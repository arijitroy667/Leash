// Arkiv rows are hostile: anyone can write one. Each forgery here must be ignored, and never shown as real.
import { describe, expect, it } from "vitest";
import { PrivateKey } from "@hiero-ledger/sdk";
import { readVerifiedEvidence, reportMessage } from "../src/evidence.ts";

const USDC = "0.0.429274";
const PAYEE = "0.0.100";
const PAYER = "0.0.200";
const OWNER = "0xaaa";
const NS = "n";
const payerKey = PrivateKey.generateECDSA();
const sign = (key: PrivateKey, m: string) => Buffer.from(key.sign(Buffer.from(m))).toString("hex");

const report = (over: Record<string, unknown> = {}) => {
  const r: any = { owner: OWNER, payee: PAYEE, ens: "", domain: "", outcome: "bad", txId: "tx-good", payer: PAYER, consensusTs: 1, amountMicroUsd: 5000, reason: "schema-mismatch", v: 1, ...over };
  r.payerSig ??= sign(payerKey, reportMessage({ ns: NS, ...r }));
  return r;
};

const txs: Record<string, unknown> = {
  "tx-good": { found: true, success: true, token: USDC, payee: PAYEE, payer: PAYER, amountAtomic: 5000, consensusTs: 1000 },
  "tx-failed": { found: true, success: false },
  "tx-fake-token": { found: true, success: true, token: "0.0.999", payee: PAYEE, payer: PAYER, amountAtomic: 5000, consensusTs: 1000 },
  "tx-other-payee": { found: true, success: true, token: USDC, payee: "0.0.300", payer: PAYER, amountAtomic: 5000, consensusTs: 1000 },
};

const read = (rows: { reports?: any[]; probes?: any[]; rebuttals?: any[] }, verifyRebuttal = async () => false) =>
  readVerifiedEvidence({
    arkiv: { reports: async () => rows.reports ?? [], probes: async () => rows.probes ?? [], rebuttals: async () => rows.rebuttals ?? [] } as any,
    mirror: {
      tx: async (id: string) => txs[id] ?? { found: false },
      account: async () => ({ keyType: "ECDSA_SECP256K1", key: payerKey.publicKey.toStringRaw(), createdTs: 0, funder: "0.0.2" }),
    } as any,
    ns: NS, payee: PAYEE, usdc: USDC, publicFunders: new Set(["0.0.2"]), proberOwners: new Set(["0xprober"]), verifyRebuttal,
  });

describe("report verification", () => {
  it("counts a real signed report", async () => {
    const v = await read({ reports: [report()] });
    expect(v.evidence.reports).toHaveLength(1);
    expect(v.evidence.reports[0]!.ts).toBe(1000); // Mirror's time, not the entity's claim
  });
  it.each([
    ["no such payment", { txId: "tx-none" }, "tx not indexed"],
    ["a failed payment", { txId: "tx-failed" }, "tx failed"],
    ["a worthless token", { txId: "tx-fake-token" }, "tx does not match report"],
    ["a payment to someone else", { txId: "tx-other-payee" }, "tx does not match report"],
    ["another wallet named as payer", { payer: "0.0.201" }, "tx does not match report"],
    ["an overstated amount", { amountMicroUsd: 9000 }, "amount overstated"],
    ["a signature by the wrong key", { payerSig: sign(PrivateKey.generateECDSA(), "x") }, "not signed by payer"],
    ["an unknown schema version", { v: 2 }, "unknown version"],
  ])("ignores %s", async (_name, over, why) => {
    const v = await read({ reports: [report(over)] });
    expect(v.evidence.reports).toHaveLength(0);
    expect(v.rows.reports[0]).toMatchObject({ valid: false, why });
  });
  it("a good report cannot be flipped to bad, or replayed by another wallet", async () => {
    const signed = report({ outcome: "good" });
    expect((await read({ reports: [{ ...signed, outcome: "bad" }] })).evidence.reports).toHaveLength(0);
    expect((await read({ reports: [{ ...signed, owner: "0xbbb" }] })).evidence.reports).toHaveLength(0);
  });
});

describe("probes and rebuttals", () => {
  const probe = { owner: "0xprober", payee: PAYEE, result: "pass", txId: "tx-good", consensusTs: 1, amountMicroUsd: 5000 };
  it("counts a probe only from an allow-listed wallet, with a real payment to this payee", async () => {
    expect((await read({ probes: [probe] })).evidence.probes).toHaveLength(1);
    expect((await read({ probes: [{ ...probe, owner: "0xstranger" }] })).evidence.probes).toHaveLength(0);
    expect((await read({ probes: [{ ...probe, txId: "tx-none" }] })).evidence.probes).toHaveLength(0);
    expect((await read({ probes: [{ ...probe, txId: "tx-other-payee" }] })).evidence.probes).toHaveLength(0);
  });
  it("never displays a forged probe or rebuttal", async () => {
    const v = await read({ probes: [{ ...probe, owner: "0xstranger" }], rebuttals: [{ filedAt: 1 }] });
    expect(v.rows.probes).toEqual([]);
    expect(v.rows.rebuttals).toEqual([]);
    expect(v.evidence.rebuttals).toEqual([]);
  });
  it("keeps a verified rebuttal", async () => {
    const v = await read({ rebuttals: [{ filedAt: 7 }] }, async () => true);
    expect(v.evidence.rebuttals).toEqual([{ ts: 7 }]);
    expect(v.rows.rebuttals).toHaveLength(1);
  });
});
