import { createHash } from "node:crypto";
import { parseAbi, verifyMessage, keccak256, toBytes, type PublicClient } from "viem";
import type { Evidence, Report } from "@herd/core";
import type { Arkiv, ProbeRow, RebuttalRow, ReportRow } from "./arkiv.ts";
import { verifyHederaSignature, type Mirror } from "./mirror.ts";

export const reportMessage = (r: { ns: string; txId: string; payee: string; outcome: string; amountMicroUsd: number; owner: string }) =>
  `herd.report:v1|${r.ns}|${r.txId}|${r.payee}|${r.outcome}|${r.amountMicroUsd}|${r.owner.toLowerCase()}`;

export const rebuttalMessage = (r: { ns: string; ens: string; payee: string; reason: string; evidenceHash: string; filedAt: number }) =>
  `herd.rebuttal:v1|${r.ns}|${r.ens}|${r.payee}|${r.reason}|${r.evidenceHash}|${r.filedAt}`;

export const REBUTTAL_REASONS = ["outage", "config-error", "payment-mismatch", "dispute-customer-error", "compromised-key-rotated"] as const;

export const ROLE_SET_TEXT = 1n << 4n;

/** Hedera's treasury funds every portal account, so it says nothing about who owns a wallet. */
export const PUBLIC_FUNDERS = ["0.0.2"];
const RESOLVER_ROLES = parseAbi([
  "function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool)",
  "function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)",
]);

/** The rebuttal right is ROLE_SET_TEXT on the merchant resolver's herd.rebuttal key. */
export async function holdsRebuttalRole(client: PublicClient, resolver: `0x${string}`, signer: `0x${string}`): Promise<boolean> {
  const resource = BigInt(keccak256(toBytes("herd.rebuttal")));
  const [scoped, root] = await Promise.all([
    client.readContract({ address: resolver, abi: RESOLVER_ROLES, functionName: "hasRoles", args: [resource, ROLE_SET_TEXT, signer] }),
    client.readContract({ address: resolver, abi: RESOLVER_ROLES, functionName: "hasRootRoles", args: [ROLE_SET_TEXT, signer] }),
  ]);
  return scoped || root;
}

export interface VerifiedEvidence {
  evidence: Evidence;
  unverifiedBadClusters: number;
  rows: { reports: (ReportRow & { valid: boolean; why?: string })[]; probes: ProbeRow[]; rebuttals: RebuttalRow[] };
}

export const digest = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Every Arkiv row is hostile until re-verified. A report counts only if Mirror shows a SUCCESS
 * transfer of the declared USDC from the named payer to this payee, and the payer's key signed it.
 */
export async function readVerifiedEvidence(opts: {
  arkiv: Arkiv;
  mirror: Mirror;
  ns: string;
  payee: string;
  usdc: string;
  publicFunders: Set<string>;
  proberOwners: Set<string>;
  verifyRebuttal: (r: RebuttalRow) => Promise<boolean>;
}): Promise<VerifiedEvidence> {
  const { arkiv, mirror, ns, payee, usdc } = opts;
  const [rawReports, rawProbes, rawRebuttals] = await Promise.all([arkiv.reports(payee), arkiv.probes(payee), arkiv.rebuttals(payee)]);

  const reports: Report[] = [];
  const unverified = new Set<string>();
  const rows: VerifiedEvidence["rows"] = { reports: [], probes: [], rebuttals: [] };

  for (const r of rawReports) {
    const mark = (valid: boolean, why?: string) => rows.reports.push({ ...r, valid, why });
    if (r.v !== 1) { mark(false, "unknown version"); continue; }
    let facts;
    let acct;
    try {
      facts = await mirror.tx(r.txId);
      acct = await mirror.account(r.payer);
    } catch {
      if (r.outcome === "bad") unverified.add(r.payer);
      mark(false, "mirror unavailable");
      continue;
    }
    if (!facts.found || !facts.success) { mark(false, facts.found ? "tx failed" : "tx not indexed"); continue; }
    if (facts.token !== usdc || facts.payee !== r.payee || facts.payer !== r.payer) { mark(false, "tx does not match report"); continue; }
    if ((facts.amountAtomic ?? 0) < r.amountMicroUsd) { mark(false, "amount overstated"); continue; }
    if (!acct) { mark(false, "payer unknown"); continue; }
    const msg = reportMessage({ ns, txId: r.txId, payee: r.payee, outcome: r.outcome, amountMicroUsd: r.amountMicroUsd, owner: r.owner });
    if (!verifyHederaSignature(acct.keyType, acct.key, msg, r.payerSig)) { mark(false, "not signed by payer"); continue; }
    mark(true);
    reports.push({
      txId: r.txId,
      ts: facts.consensusTs!, // Mirror's time, never the entity's claim
      outcome: r.outcome,
      cluster: opts.publicFunders.has(acct.funder) ? r.payer : acct.funder,
      payer: r.payer,
      amountUsd: r.amountMicroUsd / 1e6,
      payerCreatedTs: acct.createdTs,
    });
  }

  const probes: Evidence["probes"] = [];
  for (const p of rawProbes) {
    if (!opts.proberOwners.has(p.owner.toLowerCase())) continue;
    const facts = await mirror.tx(p.txId).catch(() => null);
    if (!facts?.success || facts.payee !== p.payee || facts.token !== usdc) continue;
    probes.push({ txId: p.txId, ts: facts.consensusTs!, result: p.result, cluster: `prober:${facts.payer}`, amountUsd: p.amountMicroUsd / 1e6 });
    rows.probes.push(p); // anyone can write an entity, so only verified rows may be shown or acted on
  }

  const rebuttals: Evidence["rebuttals"] = [];
  for (const r of rawRebuttals) {
    if (await opts.verifyRebuttal(r).catch(() => false)) {
      rebuttals.push({ ts: r.filedAt });
      rows.rebuttals.push(r);
    }
  }

  return { evidence: { reports, probes, rebuttals }, unverifiedBadClusters: unverified.size, rows };
}

export const verifyRebuttalSignature = (ns: string, r: RebuttalRow) =>
  verifyMessage({ address: r.signer as `0x${string}`, message: rebuttalMessage({ ns, ...r }), signature: r.signature as `0x${string}` });
