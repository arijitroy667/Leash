import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, desc, eq } from "@arkiv-network/sdk/query";
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

export const REPORT_VERSION = 1;
export const READER_CAP = 200;
const PAGE = 100;

export interface ReportRow {
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
  owner: r.$owner, payee: txt(r.payee), ens: txt(r.ens), domain: txt(r.domain), outcome: txt(r.outcome) as "good" | "bad",
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

  async reports(payee: string): Promise<ReportRow[]> {
    // The node serves at most 100 rows a page, so the 200-report reader cap takes two pages.
    const entities: any[] = [];
    for (let offset = 0; offset < READER_CAP; offset += PAGE) {
      const page = await this.pub.select().from(ReportSchema)
        .where(and(eq("ns", this.ns), eq("payee", payee)))
        .orderBy(desc("consensusTs")).limit(PAGE).offset(offset).fetch();
      entities.push(...page.entities);
      if (page.entities.length < PAGE) break;
    }
    return entities.map(toReport);
  }

  /** One reporter's latest bad reports across all payees, for the G5 daily limit. */
  async badReportsByPayer(payer: string): Promise<ReportRow[]> {
    const res = await this.pub.select().from(ReportSchema)
      .where(and(eq("ns", this.ns), eq("payer", payer), eq("outcome", "bad")))
      .orderBy(desc("consensusTs")).limit(PAGE).fetch();
    return res.entities.map(toReport);
  }

  /** Reports naming an origin. Its signature does not cover the domain, so ENS has the last word: payeesForDomain. */
  async reportsByDomain(origin: string): Promise<ReportRow[]> {
    const res = await this.pub.select().from(ReportSchema)
      .where(and(eq("ns", this.ns), eq("domain", origin)))
      .orderBy(desc("consensusTs")).limit(PAGE).fetch();
    return res.entities.map(toReport);
  }

  async probes(payee: string): Promise<ProbeRow[]> {
    const res = await this.pub.select().from(ProbeSchema)
      .where(and(eq("ns", this.ns), eq("payee", payee)))
      .orderBy(desc("consensusTs")).limit(PAGE).fetch();
    return res.entities.map((r: any) => ({
      owner: r.$owner, payee: txt(r.payee), result: txt(r.result) as "pass" | "fail", txId: txt(r.txId),
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

  async health(): Promise<boolean> {
    await this.pub.getBlockNumber();
    return true;
  }
}
