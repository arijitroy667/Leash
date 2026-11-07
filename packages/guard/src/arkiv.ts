import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, desc, eq, lte } from "@arkiv-network/sdk/query";
import { bytes, defineSchema, i32, str, u64 } from "@arkiv-network/sdk/schema";
import { hexToBytes, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const ReportSchema = defineSchema("leash.report", {
  ns: str().indexed(),
  payee: str().indexed(),
  domain: str().indexed(),
  ens: str().indexed(),
  outcome: str().indexed(),
  txId: str().indexed(),
  payer: str().indexed(),
  payerSig: str(),
  consensusTs: u64().indexed(),
  amountMicroUsd: u64(),
  reason: str(),
  v: i32(),
});

export const RebuttalSchema = defineSchema("leash.rebuttal", {
  ns: str().indexed(),
  payee: str().indexed(),
  ens: str().indexed(),
  reason: str().indexed(),
  evidenceHash: str(),
  episodeStart: u64(),
  filedAt: u64().indexed(),
  signer: str(),
  signature: bytes(), // 65 bytes: too long for a str, which is capped at 128 bytes
  v: i32(),
});

export const ProbeSchema = defineSchema("leash.probe", {
  ns: str().indexed(),
  payee: str().indexed(),
  result: str().indexed(),
  txId: str().indexed(),
  consensusTs: u64().indexed(),
  amountMicroUsd: u64(),
  deliveryDigest: str(),
  v: i32(),
});

/** A merchant's own listing, signed by a wallet that can set its ENS policy. ENS keeps the last word on every read. */
export const ListingSchema = defineSchema("leash.merchant", {
  ns: str().indexed(),
  ens: str().indexed(),
  payee: str().indexed(),
  policyVersion: u64(),
  endpoint: str(), // "verified": its 402 claims this name and pays the declared account; "none": no endpoint declared
  signedAt: u64().indexed(),
  signer: str(),
  signature: bytes(),
  v: i32(),
});

export interface ListingRow {
  key?: string;
  ens: string;
  payee: string;
  policyVersion: number;
  endpoint: "verified" | "none";
  signedAt: number;
  signer: string;
  signature: string;
}

export const REPORT_VERSION = 1;
export const READER_CAP = 200;
export const ARKIV_PAGE = 100;
const PAGE = ARKIV_PAGE;

export interface ReportRow {
  /** The Arkiv entity key, to link the row on the explorer. */
  key?: string;
  owner: string;
  payee: string;
  ens: string;
  domain: string;
  outcome: "good" | "bad";
  txId: string;
  payer: string;
  payerSig: string;
  consensusTs: number;
  amountMicroUsd: number;
  reason: string;
  v: number;
}
export interface ProbeRow {
  key?: string;
  owner: string;
  payee: string;
  result: "pass" | "fail";
  txId: string;
  consensusTs: number;
  amountMicroUsd: number;
}
export interface RebuttalRow {
  owner: string;
  payee: string;
  ens: string;
  reason: string;
  filedAt: number;
  signer: string;
  signature: string;
  evidenceHash: string;
  episodeStart: number;
}

const num = (x: { value: bigint | number | string }) => Number(x.value);
const txt = (x: { value: unknown }) => String(x.value);
const toReport = (r: any): ReportRow => ({
  key: r.$key, owner: r.$owner, payee: txt(r.payee), ens: txt(r.ens), domain: txt(r.domain), outcome: txt(r.outcome) as "good" | "bad",
  txId: txt(r.txId), payer: txt(r.payer), payerSig: txt(r.payerSig), consensusTs: num(r.consensusTs),
  amountMicroUsd: num(r.amountMicroUsd), reason: txt(r.reason), v: num(r.v),
});

export class Arkiv {
  private pub;
  /** rpcUrl routes traffic through the local outage relay in scene 7. */
  constructor(private accessKey: string, private ns: string, private rpcUrl?: string) {
    this.pub = createPublicClient({ chain: rabdi({ accessKey }), transport: http(rpcUrl, { timeout: 6000 }) });
  }

  writer(privateKey: `0x${string}`) {
    return createWalletClient({ chain: rabdi({ accessKey: this.accessKey }), transport: http(this.rpcUrl), account: privateKeyToAccount(privateKey) });
  }

  /**
   * One page of reports, newest first. The reader keeps paging past rows that fail verification, so a flood cannot
   * push the real reports out of view. Future-dated rows are never fetched: no honest report can be one.
   */
  async reports(payee: string, offset = 0): Promise<ReportRow[]> {
    const page = await this.pub.select().from(ReportSchema)
      .where(and(eq("ns", this.ns), eq("payee", payee), lte("consensusTs", u64(BigInt(Math.floor(Date.now() / 1000))))))
      .orderBy(desc("consensusTs")).limit(PAGE).offset(offset).fetch();
    return page.entities.map(toReport);
  }

  /** One reporter's latest bad reports across all payees, for the G5 daily limit. */
  async badReportsByPayer(payer: string): Promise<ReportRow[]> {
    const res = await this.pub.select().from(ReportSchema)
      .where(and(eq("ns", this.ns), eq("payer", payer), eq("outcome", "bad")))
      .orderBy(desc("consensusTs")).limit(PAGE).fetch();
    return res.entities.map(toReport);
  }

  /**
   * Payees named in the newest report rows, for listing every merchant in the registry. A row is only a claim: each
   * listed payee's standing still comes from the verified read, and a name a row claims is checked against ENS.
   */
  async recentPayees(maxRows = 500): Promise<{ payee: string; ens: string }[]> {
    const seen = new Map<string, string>();
    for (let offset = 0; offset < maxRows; offset += PAGE) {
      const page = await this.pub.select().from(ReportSchema).where(eq("ns", this.ns)).orderBy(desc("consensusTs")).limit(PAGE).offset(offset).fetch();
      for (const r of page.entities.map(toReport)) if (!seen.has(r.payee) || (!seen.get(r.payee) && r.ens)) seen.set(r.payee, r.ens);
      if (page.entities.length < PAGE) break;
    }
    return [...seen].map(([payee, ens]) => ({ payee, ens }));
  }

  /** Live entity counts in this registry. They fall as entities expire, which is the forgiveness mechanism at work. */
  async counts() {
    const n = (schema: typeof ReportSchema | typeof ProbeSchema | typeof RebuttalSchema) => this.pub.count().from(schema).where(eq("ns", this.ns)).fetch().then(Number);
    const [reports, probes, rebuttals] = await Promise.all([n(ReportSchema), n(ProbeSchema), n(RebuttalSchema)]);
    return { reports, probes, rebuttals };
  }

  /** Whether this writer already filed a report for this payment, so a retried delivery never writes it twice (NFR-08). */
  async hasReport(txId: string, creator: string): Promise<boolean> {
    const res = await this.pub.select().from(ReportSchema)
      .where(and(eq("ns", this.ns), eq("txId", txId))).createdBy(creator as `0x${string}`).limit(1).fetch();
    return res.entities.length > 0;
  }

  /** Reports naming an origin. Its signature does not cover the domain, so ENS has the last word: payeesForDomain. */
  async reportsByDomain(origin: string): Promise<ReportRow[]> {
    const res = await this.pub.select().from(ReportSchema)
      .where(and(eq("ns", this.ns), eq("domain", origin)))
      .orderBy(desc("consensusTs")).limit(PAGE).fetch();
    return res.entities.map(toReport);
  }

  /**
   * Probes written by the allow-listed probers. By creator, never by owner: an owner can hand any entity to the
   * prober's address, so a passing probe forged by the merchant's side would let a blocked merchant out early.
   */
  async probes(payee: string, creators: string[]): Promise<ProbeRow[]> {
    const pages = await Promise.all(creators.map((creator) => this.pub.select().from(ProbeSchema)
      .where(and(eq("ns", this.ns), eq("payee", payee))).createdBy(creator as `0x${string}`)
      .orderBy(desc("consensusTs")).limit(PAGE).fetch()));
    return pages.flatMap((p) => p.entities).map((r: any) => ({
      key: r.$key, owner: String(r.$creator), payee: txt(r.payee), result: txt(r.result) as "pass" | "fail", txId: txt(r.txId),
      consensusTs: num(r.consensusTs), amountMicroUsd: num(r.amountMicroUsd),
    }));
  }

  async rebuttals(payee: string): Promise<RebuttalRow[]> {
    const res = await this.pub.select().from(RebuttalSchema)
      .where(and(eq("ns", this.ns), eq("payee", payee)))
      .orderBy(desc("filedAt")).limit(PAGE).fetch();
    return res.entities.map((r: any) => ({
      owner: r.$owner, payee: txt(r.payee), ens: txt(r.ens), reason: txt(r.reason), filedAt: num(r.filedAt),
      signer: txt(r.signer), signature: txt(r.signature), evidenceHash: txt(r.evidenceHash), episodeStart: num(r.episodeStart),
    }));
  }

  /** Listings written by the registrar only, as probes are trusted by creator, so a flood of rows cannot bury them. */
  async listings(registrar: string): Promise<ListingRow[]> {
    const res = await this.pub.select().from(ListingSchema).where(eq("ns", this.ns)).createdBy(registrar as `0x${string}`)
      .orderBy(desc("signedAt")).limit(PAGE).fetch();
    return res.entities.map((r: any) => ({
      key: r.$key, ens: txt(r.ens), payee: txt(r.payee), policyVersion: num(r.policyVersion), endpoint: txt(r.endpoint) === "verified" ? "verified" : "none",
      signedAt: num(r.signedAt), signer: txt(r.signer), signature: txt(r.signature),
    }));
  }

  async writeListing(key: `0x${string}`, l: Omit<ListingRow, "key">, ttlSec: number) {
    return this.writer(key).createEntity(ListingSchema, {
      ns: this.ns, ens: l.ens, payee: l.payee, policyVersion: u64(BigInt(l.policyVersion)), endpoint: l.endpoint,
      signedAt: u64(BigInt(l.signedAt)), signer: l.signer, signature: hexToBytes(l.signature as `0x${string}`), v: i32(REPORT_VERSION),
    }, { expiration: ExpirationTime.fromSeconds(ttlSec) });
  }

  /** Every entity of one kind in this registry, newest first, with its key, so a page can link each write to the explorer. */
  async recent(kind: "report" | "probe" | "rebuttal" | "merchant", limit = PAGE) {
    const [schema, by] = kind === "report" ? [ReportSchema, "consensusTs"] : kind === "probe" ? [ProbeSchema, "consensusTs"]
      : kind === "merchant" ? [ListingSchema, "signedAt"] : [RebuttalSchema, "filedAt"];
    const res = await (this.pub.select().from(schema as typeof ReportSchema).where(eq("ns", this.ns)) as any).orderBy(desc(by)).limit(limit).fetch();
    return res.entities as any[];
  }

  async writeReport(key: `0x${string}`, r: Omit<ReportRow, "owner" | "v">, ttlSec: number) {
    return this.writer(key).createEntity(ReportSchema, {
      ns: this.ns, payee: r.payee, domain: r.domain, ens: r.ens, outcome: r.outcome, txId: r.txId, payer: r.payer, payerSig: r.payerSig,
      consensusTs: u64(BigInt(Math.floor(r.consensusTs))), amountMicroUsd: u64(BigInt(r.amountMicroUsd)), reason: r.reason, v: i32(REPORT_VERSION),
    }, { expiration: ExpirationTime.fromSeconds(ttlSec) });
  }

  async writeProbe(key: `0x${string}`, p: Omit<ProbeRow, "owner"> & { deliveryDigest: string }, ttlSec: number) {
    return this.writer(key).createEntity(ProbeSchema, {
      ns: this.ns, payee: p.payee, result: p.result, txId: p.txId, consensusTs: u64(BigInt(Math.floor(p.consensusTs))),
      amountMicroUsd: u64(BigInt(p.amountMicroUsd)), deliveryDigest: p.deliveryDigest, v: i32(REPORT_VERSION),
    }, { expiration: ExpirationTime.fromSeconds(ttlSec) });
  }

  async writeRebuttal(key: `0x${string}`, r: Omit<RebuttalRow, "owner">, ttlSec: number) {
    return this.writer(key).createEntity(RebuttalSchema, {
      ns: this.ns, payee: r.payee, ens: r.ens, reason: r.reason, evidenceHash: r.evidenceHash, episodeStart: u64(BigInt(Math.floor(r.episodeStart))),
      filedAt: u64(BigInt(Math.floor(r.filedAt))), signer: r.signer, signature: hexToBytes(r.signature as `0x${string}`), v: i32(REPORT_VERSION),
    }, { expiration: ExpirationTime.fromSeconds(ttlSec) });
  }

  /** The SDK's BLOCK_TIME is 2 s, so an entity has ($expiresAt - this) * 2 seconds left. */
  blockNumber() {
    return this.pub.getBlockNumber();
  }

  async health(): Promise<boolean> {
    await this.pub.getBlockNumber();
    return true;
  }
}
