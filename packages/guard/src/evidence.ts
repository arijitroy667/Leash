import { createHash } from "node:crypto";
import { parseAbi, verifyMessage, keccak256, toBytes, type PublicClient } from "viem";
import { normalize } from "viem/ens";
import { REPORTER_BAD_PER_DAY, reporterExcess, type Evidence, type Report } from "@leash/core";
import type { Arkiv, ProbeRow, RebuttalRow, ReportRow } from "./arkiv.ts";
import { validAccount, validName, type Ens } from "./ens.ts";
import { verifyHederaSignature, type Mirror, type TxFacts } from "./mirror.ts";

export const reportMessage = (r: { ns: string; txId: string; payee: string; outcome: string; amountMicroUsd: number; owner: string }) =>
  `leash.report:v1|${r.ns}|${r.txId}|${r.payee}|${r.outcome}|${r.amountMicroUsd}|${r.owner.toLowerCase()}`;

export const rebuttalMessage = (r: { ns: string; ens: string; payee: string; reason: string; evidenceHash: string; filedAt: number }) =>
  `leash.rebuttal:v1|${r.ns}|${r.ens}|${r.payee}|${r.reason}|${r.evidenceHash}|${r.filedAt}`;

export const REBUTTAL_REASONS = ["outage", "config-error", "payment-mismatch", "dispute-customer-error", "compromised-key-rotated"] as const;

export const ROLE_SET_TEXT = 1n << 4n;

/** Hedera's treasury funds every portal account, so it says nothing about who owns a wallet. */
export const PUBLIC_FUNDERS = ["0.0.2"];
const RESOLVER_ROLES = parseAbi([
  "function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool)",
  "function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)",
]);

/** The rebuttal right is ROLE_SET_TEXT on the merchant resolver's leash.rebuttal key. */
export async function holdsRebuttalRole(client: PublicClient, resolver: `0x${string}`, signer: `0x${string}`): Promise<boolean> {
  const resource = BigInt(keccak256(toBytes("leash.rebuttal")));
  const [scoped, root] = await Promise.all([
    client.readContract({ address: resolver, abi: RESOLVER_ROLES, functionName: "hasRoles", args: [resource, ROLE_SET_TEXT, signer] }),
    client.readContract({ address: resolver, abi: RESOLVER_ROLES, functionName: "hasRootRoles", args: [ROLE_SET_TEXT, signer] }),
  ]);
  return scoped || root;
}

export interface VerifiedEvidence {
  evidence: Evidence;
  /**
   * A row could not be checked because Mirror Node, Arkiv or Sepolia failed. This read must not be cached as the
   * truth, and the guard escalates on it rather than allowing.
   */
  incomplete: boolean;
  rows: { reports: (ReportRow & { valid: boolean; why?: string })[]; probes: ProbeRow[]; rebuttals: RebuttalRow[] };
}

export const digest = (s: string) => createHash("sha256").update(s).digest("hex");

type Account = NonNullable<Awaited<ReturnType<Mirror["account"]>>>;
type Checked = { why: string; mirrorDown?: boolean } | { facts: TxFacts; acct: Account };

/** A Hedera transaction id as the SDK writes it. Anything else is junk, and never costs a Mirror call. */
const TX_ID = /^0\.0\.\d{1,12}@\d{1,12}\.\d{1,9}$/;

/** Runs f on each item, a few at a time: one by one is too slow for a cold read, all at once trips Mirror's rate limit. */
async function inBatches<T, R>(xs: T[], f: (x: T) => Promise<R>, size = 8): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < xs.length; i += size) out.push(...(await Promise.all(xs.slice(i, i + size).map(f))));
  return out;
}

/** One report against Mirror Node and the payer's key. Consensus time comes from Mirror, and any mismatch drops the row. */
async function checkReport(r: ReportRow, mirror: Mirror, ns: string, usdc: string): Promise<Checked> {
  if (r.v !== 1) return { why: "unknown version" };
  if (!TX_ID.test(r.txId) || !validAccount(r.payer) || !validAccount(r.payee)) return { why: "malformed row" };
  let facts: TxFacts;
  let acct: Awaited<ReturnType<Mirror["account"]>>;
  try {
    [facts, acct] = await Promise.all([mirror.tx(r.txId), mirror.account(r.payer)]);
  } catch {
    return { why: "mirror unavailable", mirrorDown: true };
  }
  if (!facts.found || !facts.success) return { why: facts.found ? "tx failed" : "tx not indexed" };
  if (facts.token !== usdc || facts.payee !== r.payee || facts.payer !== r.payer) return { why: "tx does not match report" };
  if ((facts.amountAtomic ?? 0) < r.amountMicroUsd) return { why: "amount overstated" };
  if (Math.floor(facts.consensusTs!) !== Math.floor(r.consensusTs)) return { why: "timestamp mismatch" };
  if (!acct) return { why: "payer unknown" };
  const msg = reportMessage({ ns, txId: r.txId, payee: r.payee, outcome: r.outcome, amountMicroUsd: r.amountMicroUsd, owner: r.owner });
  if (!verifyHederaSignature(acct.keyType, acct.key, msg, r.payerSig)) return { why: "not signed by payer" };
  return { facts, acct };
}

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
  badPerPayeeWindowSec: number;
  verifyRebuttal: (r: RebuttalRow) => Promise<boolean>;
}): Promise<VerifiedEvidence> {
  const { arkiv, mirror, ns, payee, usdc } = opts;
  const [rawReports, rawProbes, rawRebuttals] = await Promise.all([arkiv.reports(payee), arkiv.probes(payee), arkiv.rebuttals(payee)]);

  let reports: Report[] = [];
  let incomplete = false;
  const rows: VerifiedEvidence["rows"] = { reports: [], probes: [], rebuttals: [] };

  // All checks at once, in batches: a cold read would otherwise wait on Mirror once per row (NFR-01).
  const ours = rawProbes.filter((p) => opts.proberOwners.has(p.owner.toLowerCase()) && TX_ID.test(p.txId));
  const [checks, probeFacts, rebuttalChecks] = await Promise.all([
    inBatches(rawReports, (r) => checkReport(r, mirror, ns, usdc)),
    inBatches(ours, (p) => mirror.tx(p.txId).catch(() => null)),
    // A check that fails is not a rebuttal that fails: missing the first one could let a second one count.
    inBatches(rawRebuttals, (r) => opts.verifyRebuttal(r).catch(() => null)),
  ]);

  for (const [i, r] of rawReports.entries()) {
    const c = checks[i]!;
    if ("why" in c) {
      if (c.mirrorDown) incomplete = true;
      rows.reports.push({ ...r, valid: false, why: c.why });
      continue;
    }
    rows.reports.push({ ...r, valid: true });
    reports.push({
      txId: r.txId,
      ts: c.facts.consensusTs!, // Mirror's time, never the entity's claim
      outcome: r.outcome,
      cluster: opts.publicFunders.has(c.acct.funder) ? r.payer : c.acct.funder,
      payer: r.payer,
      amountUsd: r.amountMicroUsd / 1e6,
      payerCreatedTs: c.acct.createdTs,
    });
  }

  // G5 across payees. A failed lookup applies no limit, so the evidence is kept, and the read is marked incomplete.
  const badPayers = [...new Set(reports.filter((r) => r.outcome === "bad").map((r) => r.payer))];
  const excessByPayer = await Promise.all(badPayers.map(async (payer) => {
    const history = await arkiv.badReportsByPayer(payer).catch(() => {
      incomplete = true;
      return [] as ReportRow[];
    });
    if (history.length <= REPORTER_BAD_PER_DAY) return new Set<string>();
    const verified: { txId: string; ts: number; payee: string }[] = [];
    const past = await inBatches(history, (h) => checkReport(h, mirror, ns, usdc));
    for (const [i, h] of history.entries()) {
      const c = past[i]!;
      if (!("why" in c)) verified.push({ txId: h.txId, ts: c.facts.consensusTs!, payee: h.payee });
      else if (c.mirrorDown) incomplete = true;
    }
    return reporterExcess(verified, opts.badPerPayeeWindowSec);
  }));
  const excess = new Set(excessByPayer.flatMap((s) => [...s]));
  if (excess.size) {
    reports = reports.filter((r) => !excess.has(r.txId));
    for (const row of rows.reports) {
      if (excess.has(row.txId) && row.outcome === "bad") Object.assign(row, { valid: false, why: "reporter over daily limit" });
    }
  }

  const probes: Evidence["probes"] = [];
  for (const [i, p] of ours.entries()) {
    const facts = probeFacts[i];
    if (!facts) {
      incomplete = true;
      continue;
    }
    if (!facts.success || facts.payee !== p.payee || facts.token !== usdc) continue;
    if (Math.floor(facts.consensusTs!) !== Math.floor(p.consensusTs)) continue;
    // One cluster for every prober: a probe alone can never supply the three good clusters recovery needs.
    probes.push({ txId: p.txId, ts: facts.consensusTs!, result: p.result, cluster: "prober", amountUsd: p.amountMicroUsd / 1e6 });
    rows.probes.push(p); // anyone can write an entity, so only verified rows may be shown or acted on
  }

  const rebuttals: Evidence["rebuttals"] = [];
  for (const [i, r] of rawRebuttals.entries()) {
    if (rebuttalChecks[i] === null) incomplete = true;
    else if (rebuttalChecks[i]) {
      rebuttals.push({ ts: r.filedAt });
      rows.rebuttals.push(r);
    }
  }

  return { evidence: { reports, probes, rebuttals }, incomplete, rows };
}

export const verifyRebuttalSignature = (ns: string, r: RebuttalRow) =>
  verifyMessage({ address: r.signer as `0x${string}`, message: rebuttalMessage({ ns, ...r }), signature: r.signature as `0x${string}` });

/**
 * A rebuttal counts only if it is signed by the role holder of a name that really declares this payee.
 * Without the declaration check, anyone could use their own name to burn another merchant's one rebuttal.
 */
export async function verifyRebuttalRow(r: RebuttalRow, ns: string, ens: Ens, client: PublicClient): Promise<boolean> {
  if (!(await verifyRebuttalSignature(ns, r))) return false;
  if ((await ens.fetch(r.ens))?.payTo !== r.payee) return false;
  return holdsRebuttalRole(client, await client.getEnsResolver({ name: normalize(r.ens) }), r.signer as `0x${string}`);
}

export const originOf = (s: string): string | null => {
  try {
    const u = new URL(s.includes("://") ? s : `https://${s}`);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
};

/**
 * Payees that reports name for an origin. A report's signature does not cover its domain, so a row alone proves
 * nothing: a name whose ENS declaration lists this origin and payee wins, and anything else is an unverified claim.
 */
export async function payeesForDomain(arkiv: Arkiv, ens: Ens, origin: string): Promise<{ name: string | null; payTo: string }[]> {
  // Anyone can write a row, so a payee that is not an account id is text, and never comes back.
  const rows = (await arkiv.reportsByDomain(origin)).filter((r) => validAccount(r.payee));
  const seen = [...new Map(rows.map((r) => [`${r.payee}|${r.ens}`, r])).values()];
  const declared: { name: string; payTo: string }[] = [];
  for (const r of seen) {
    if (!validName(r.ens)) continue;
    const d = await ens.fetch(r.ens).catch(() => null);
    if (d?.payTo === r.payee && d.domains.includes(origin)) declared.push({ name: r.ens, payTo: r.payee });
  }
  if (declared.length) return declared;
  return [...new Set(seen.map((r) => r.payee))].map((payTo) => ({ name: null, payTo }));
}
