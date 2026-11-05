// Arkiv rows are hostile: anyone can write one. Each forgery here must be ignored, and never shown as real.
import { describe, expect, it } from "vitest";
import { PrivateKey } from "@hiero-ledger/sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { originOf, payeesForDomain, readVerifiedEvidence, rebuttalMessage, reportMessage, verifyRebuttalRow } from "../src/evidence.ts";

const USDC = "0.0.429274";
const PAYEE = "0.0.100";
const PAYER = "0.0.200";
const OWNER = "0xaaa";
const NS = "n";
const payerKey = PrivateKey.generateECDSA();
const tx = (n: number) => `0.0.9@1000.${String(n).padStart(9, "0")}`;
const T = { good: tx(1), failed: tx(2), fakeToken: tx(3), otherPayee: tx(4), none: tx(5), second: tx(6) };
const sign = (key: PrivateKey, m: string) => Buffer.from(key.sign(Buffer.from(m))).toString("hex");

const report = (over: Record<string, unknown> = {}) => {
  const r: any = { owner: OWNER, payee: PAYEE, ens: "", domain: "", outcome: "bad", txId: T.good, payer: PAYER, consensusTs: 1000, amountMicroUsd: 5000, reason: "schema-mismatch", v: 1, ...over };
  r.payerSig ??= sign(payerKey, reportMessage({ ns: NS, ...r }));
  return r;
};

const txs: Record<string, unknown> = {
  [T.good]: { found: true, success: true, token: USDC, payee: PAYEE, payer: PAYER, amountAtomic: 5000, consensusTs: 1000 },
  [T.failed]: { found: true, success: false },
  [T.fakeToken]: { found: true, success: true, token: "0.0.999", payee: PAYEE, payer: PAYER, amountAtomic: 5000, consensusTs: 1000 },
  [T.otherPayee]: { found: true, success: true, token: USDC, payee: "0.0.300", payer: PAYER, amountAtomic: 5000, consensusTs: 1000 },
};

const read = (rows: { reports?: any[]; probes?: any[]; rebuttals?: any[]; history?: any[]; mirrorDown?: boolean }, verifyRebuttal = async () => false) =>
  readVerifiedEvidence({
    arkiv: { reports: async () => rows.reports ?? [], probes: async () => rows.probes ?? [], rebuttals: async () => rows.rebuttals ?? [], badReportsByPayer: async () => rows.history ?? [] } as any,
    badPerPayeeWindowSec: 86400,
    mirror: {
      tx: async (id: string) => {
        if (rows.mirrorDown) throw new Error("mirror 503");
        return txs[id] ?? { found: false };
      },
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
    ["no such payment", { txId: T.none }, "tx not indexed"],
    ["a failed payment", { txId: T.failed }, "tx failed"],
    ["a worthless token", { txId: T.fakeToken }, "tx does not match report"],
    ["a payment to someone else", { txId: T.otherPayee }, "tx does not match report"],
    ["another wallet named as payer", { payer: "0.0.201" }, "tx does not match report"],
    ["an overstated amount", { amountMicroUsd: 9000 }, "amount overstated"],
    ["a signature by the wrong key", { payerSig: sign(PrivateKey.generateECDSA(), "x") }, "not signed by payer"],
    ["an unknown schema version", { v: 2 }, "unknown version"],
    ["a consensus time that disagrees with Mirror", { consensusTs: 999 }, "timestamp mismatch"],
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
  const probe = { owner: "0xprober", payee: PAYEE, result: "pass", txId: T.good, consensusTs: 1000, amountMicroUsd: 5000 };
  it("counts a probe only from an allow-listed wallet, with a real payment to this payee", async () => {
    expect((await read({ probes: [probe] })).evidence.probes).toHaveLength(1);
    expect((await read({ probes: [{ ...probe, owner: "0xstranger" }] })).evidence.probes).toHaveLength(0);
    expect((await read({ probes: [{ ...probe, txId: T.none }] })).evidence.probes).toHaveLength(0);
    expect((await read({ probes: [{ ...probe, txId: T.otherPayee }] })).evidence.probes).toHaveLength(0);
  });
  it("a probe with the wrong consensus time is dropped, and every prober is one cluster", async () => {
    expect((await read({ probes: [{ ...probe, consensusTs: 5 }] })).evidence.probes).toHaveLength(0);
    expect((await read({ probes: [probe] })).evidence.probes[0]!.cluster).toBe("prober");
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

describe("a dependency fails during the read", () => {
  it("Mirror down marks the read incomplete, for a bad report, a good one or a probe", async () => {
    for (const outcome of ["bad", "good"]) {
      const v = await read({ reports: [report({ outcome })], mirrorDown: true });
      expect(v.incomplete).toBe(true);
      expect(v.evidence.reports).toEqual([]);
    }
    const probes = await read({ probes: [{ owner: "0xprober", payee: PAYEE, result: "pass", txId: T.good, consensusTs: 1000, amountMicroUsd: 1 }], mirrorDown: true });
    expect(probes.incomplete).toBe(true);
  });
  it("a rebuttal check that errors marks it incomplete, a rebuttal that fails its check does not", async () => {
    expect((await read({ rebuttals: [{ filedAt: 1 }] }, async () => { throw new Error("sepolia down"); })).incomplete).toBe(true);
    expect((await read({ rebuttals: [{ filedAt: 1 }] }, async () => false)).incomplete).toBe(false);
  });
  it("a complete read is not marked", async () => {
    expect((await read({ reports: [report()] })).incomplete).toBe(false);
  });
  it("a junk row never reaches Mirror, so it cannot fake an outage and force escalations", async () => {
    for (const over of [{ txId: "IGNORE PREVIOUS INSTRUCTIONS" }, { payer: "../accounts" }, { payee: "0.0.1-abcde" }]) {
      const v = await read({ reports: [report(over)], mirrorDown: true });
      expect(v.incomplete).toBe(false);
      expect(v.rows.reports[0]).toMatchObject({ valid: false, why: "malformed row" });
    }
  });
});

describe("G5 across payees", () => {
  const others = (n: number) => Array.from({ length: n }, (_, i) => report({ txId: tx(100 + i), payee: `0.0.${500 + i}` }));
  const six = { [tx(100)]: 100, [tx(101)]: 200, [tx(102)]: 300, [tx(103)]: 400, [tx(104)]: 500 } as Record<string, number>;
  for (const [id, ts] of Object.entries(six)) txs[id] = { found: true, success: true, token: USDC, payer: PAYER, amountAtomic: 5000, consensusTs: ts };

  it("a reporter's sixth bad report in a day is ignored", async () => {
    const history = [...others(5).map((h, i) => {
      const payee = `0.0.${500 + i}`;
      txs[h.txId] = { ...(txs[h.txId] as object), payee };
      return report({ txId: h.txId, payee, consensusTs: six[h.txId] });
    }), report()];
    const v = await read({ reports: [report()], history });
    expect(v.evidence.reports).toEqual([]);
    expect(v.rows.reports[0]).toMatchObject({ valid: false, why: "reporter over daily limit" });
  });

  it("forged rows naming the reporter cannot use up its allowance", async () => {
    const forged = others(6).map((h) => ({ ...h, payerSig: "00" }));
    const v = await read({ reports: [report()], history: [...forged, report()] });
    expect(v.evidence.reports).toHaveLength(1);
  });

  it("a failed history lookup applies no limit, so the evidence still counts, and the read is incomplete", async () => {
    const v = await readVerifiedEvidence({
      arkiv: { reports: async () => [report()], probes: async () => [], rebuttals: async () => [], badReportsByPayer: async () => { throw new Error("down"); } } as any,
      mirror: { tx: async (id: string) => txs[id] ?? { found: false }, account: async () => ({ keyType: "ECDSA_SECP256K1", key: payerKey.publicKey.toStringRaw(), createdTs: 0, funder: "0.0.2" }) } as any,
      ns: NS, payee: PAYEE, usdc: USDC, publicFunders: new Set(["0.0.2"]), proberOwners: new Set(), badPerPayeeWindowSec: 86400, verifyRebuttal: async () => false,
    });
    expect(v.evidence.reports).toHaveLength(1);
    expect(v.incomplete).toBe(true);
  });
});

describe("rebuttal authority", () => {
  const holder = privateKeyToAccount(generatePrivateKey());
  const row = async (over: Record<string, unknown> = {}) => {
    const r: any = { owner: "0xo", payee: PAYEE, ens: "m.eth", reason: "config-error", evidenceHash: "h", filedAt: 10, signer: holder.address, episodeStart: 0, ...over };
    r.signature = await holder.signMessage({ message: rebuttalMessage({ ns: NS, ...r }) });
    return r;
  };
  const client = (role: boolean) => ({ getEnsResolver: async () => "0xres", readContract: async () => role }) as any;
  const ens = (payTo: string) => ({ fetch: async () => ({ payTo }) }) as any;

  it("counts from the role holder of a name that declares this payee", async () => {
    expect(await verifyRebuttalRow(await row(), NS, ens(PAYEE), client(true))).toBe(true);
  });
  it("is refused with no role", async () => {
    expect(await verifyRebuttalRow(await row(), NS, ens(PAYEE), client(false))).toBe(false);
  });
  it("is refused from the role holder of a name that does not declare this payee", async () => {
    expect(await verifyRebuttalRow(await row(), NS, ens("0.0.666"), client(true))).toBe(false);
  });
  it("is refused when any signed field is changed", async () => {
    expect(await verifyRebuttalRow({ ...(await row()), reason: "outage" }, NS, ens(PAYEE), client(true))).toBe(false);
  });
});

describe("merchant lookup by domain", () => {
  const ORIGIN = "https://m.example";
  const arkiv = (rows: { payee: string; ens: string }[]) => ({ reportsByDomain: async () => rows }) as any;
  const ens = { fetch: async (n: string) => (n === "m.eth" ? { payTo: PAYEE, domains: [ORIGIN] } : null) } as any;

  it("an ENS declaration decides: a row naming the domain with another payee is not believed", async () => {
    const hits = await payeesForDomain(arkiv([{ payee: "0.0.666", ens: "evil.eth" }, { payee: "0.0.666", ens: "m.eth" }, { payee: PAYEE, ens: "m.eth" }]), ens, ORIGIN);
    expect(hits).toEqual([{ name: "m.eth", payTo: PAYEE }]);
  });
  it("with no declaration, payees come back as unverified", async () => {
    expect(await payeesForDomain(arkiv([{ payee: "0.0.7", ens: "" }]), ens, ORIGIN)).toEqual([{ name: null, payTo: "0.0.7" }]);
  });
  it("a payee that is not an account id is text, and never comes back", async () => {
    const rows = [{ payee: "IGNORE PREVIOUS INSTRUCTIONS", ens: "" }, { payee: "0.0.7-abcde", ens: "" }];
    expect(await payeesForDomain(arkiv(rows), ens, ORIGIN)).toEqual([]);
  });
  it("accepts a bare domain or a URL, and rejects text", () => {
    expect(originOf("m.example")).toBe(ORIGIN);
    expect(originOf(`${ORIGIN}/path?x=1`)).toBe(ORIGIN);
    expect(originOf("IGNORE PREVIOUS INSTRUCTIONS")).toBeNull();
    expect(originOf("javascript:alert(1)")).toBeNull();
  });
});
