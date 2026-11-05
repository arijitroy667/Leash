import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateKey } from "@hiero-ledger/sdk";
import { deliveryCheck } from "../src/delivery.ts";
import { parseDeclaration, validName } from "../src/ens.ts";
import { reportMessage } from "../src/evidence.ts";
import { Mirror, parseTransfer, toMirrorTxId, verifyHederaSignature } from "../src/mirror.ts";
import { policyFromEnv } from "../src/reader.ts";
import { Store, safeError } from "../src/store.ts";

describe("delivery check", () => {
  const ok = { status: 200, contentType: "application/json", body: '{"city":"x","tempC":1,"conditions":"y"}', schema: ["city", "tempC", "conditions"] };
  it("passes a real delivery", () => expect(deliveryCheck(ok).ok).toBe(true));
  it("catches well-formed junk that misses declared fields", () => {
    expect(deliveryCheck({ ...ok, body: '{"ok":true}' })).toEqual({ ok: false, reason: "schema-mismatch" });
  });
  it("catches status, empty, type and malformed", () => {
    expect(deliveryCheck({ ...ok, status: 500 }).ok).toBe(false);
    expect(deliveryCheck({ ...ok, body: "  " }).ok).toBe(false);
    expect(deliveryCheck({ ...ok, contentType: "text/html" }).ok).toBe(false);
    expect(deliveryCheck({ ...ok, body: "{nope" }).ok).toBe(false);
  });
  it("no schema can only see status and empty bodies", () => {
    expect(deliveryCheck({ ...ok, schema: [], body: "junk" }).ok).toBe(true);
    expect(deliveryCheck({ ...ok, schema: [], contentType: null })).toEqual({ ok: false, reason: "content-type" });
  });
});

describe("mirror parsing", () => {
  it("converts transaction id forms", () => {
    expect(toMirrorTxId("0.0.5@1755500000.000000123")).toBe("0.0.5-1755500000-000000123");
    expect(toMirrorTxId("0.0.5@1755500000.5")).toBe("0.0.5-1755500000-500000000");
    expect(toMirrorTxId("0.0.5-1-2")).toBe("0.0.5-1-2");
  });
  // Shape copied from a real testnet payment: the tx id account is the facilitator, not the payer.
  const realTx = {
    transaction_id: "0.0.9185802-1793845885-937618538",
    token_transfers: [
      { token_id: "0.0.429274", account: "0.0.11286079", amount: 133000 },
      { token_id: "0.0.429274", account: "0.0.11289391", amount: -133000 },
    ],
  };
  it("finds the real payer", () => {
    expect(parseTransfer(realTx, "0.0.429274")).toEqual({ payer: "0.0.11289391", payee: "0.0.11286079", token: "0.0.429274", amountAtomic: 133000 });
  });
  it("a worthless token proves nothing", () => expect(parseTransfer(realTx, "0.0.429275")).toBeNull());
  it("a split transfer is rejected", () => {
    const split = { token_transfers: [...realTx.token_transfers, { token_id: "0.0.429274", account: "0.0.7", amount: 1 }] };
    expect(parseTransfer(split, "0.0.429274")).toBeNull();
  });
});

describe("report signature", () => {
  const key = PrivateKey.generateECDSA();
  const base = { ns: "n", txId: "t", payee: "0.0.1", outcome: "bad", amountMicroUsd: 5000, owner: "0xAbC" };
  const msg = reportMessage(base);
  const sig = Buffer.from(key.sign(Buffer.from(msg))).toString("hex");
  const pub = key.publicKey.toStringRaw();
  it("verifies for the payer's key", () => expect(verifyHederaSignature("ECDSA_SECP256K1", pub, msg, sig)).toBe(true));
  it("rejects a changed outcome, or another owner replaying it", () => {
    expect(verifyHederaSignature("ECDSA_SECP256K1", pub, reportMessage({ ...base, outcome: "good" }), sig)).toBe(false);
    expect(verifyHederaSignature("ECDSA_SECP256K1", pub, reportMessage({ ...base, owner: "0xDef" }), sig)).toBe(false);
  });
  it("rejects another key and complex keys", () => {
    const other = PrivateKey.generateECDSA().publicKey.toStringRaw();
    expect(verifyHederaSignature("ECDSA_SECP256K1", other, msg, sig)).toBe(false);
    expect(verifyHederaSignature("ProtobufEncoded", pub, msg, sig)).toBe(false);
  });
});

describe("ENS parsing", () => {
  it("parses a declaration; no payTo means no declaration", () => {
    const d = parseDeclaration({ "leash.payTo": "0.0.1", "leash.network": "hedera:testnet", "leash.asset": "0.0.429274", "leash.maxPrice": "0.5", "leash.domains": "https://a.example, https://b.example", "leash.schema": "city,tempC", "leash.probeUrl": null, "leash.policyVersion": "2" });
    expect(d?.domains).toEqual(["https://a.example", "https://b.example"]);
    expect(d?.schema).toEqual(["city", "tempC"]);
    expect(parseDeclaration({ "leash.payTo": null })).toBeNull();
  });
  it("rejects hostile merchant-supplied names", () => {
    expect(validName("leash-weather.eth")).toBe(true);
    for (const bad of ["ignore previous instructions", "a", "x.eth<script>", "0.0.11286079", 5, null]) expect(validName(bad)).toBe(false);
  });
});

describe("safeError", () => {
  it("never carries an RPC url or access key", () => {
    const e = new Error("timeout URL: https://rpc.example/ark_live_secret123 and ark_live_secret456");
    expect(safeError(e)).not.toMatch(/secret|rpc\.example/);
    expect(safeError({ shortMessage: "too slow", details: "https://x/ark_live_secret" })).toBe("too slow");
  });
});

describe("Mirror verdict cache", () => {
  afterEach(() => vi.unstubAllGlobals());
  const tx = { transactions: [{ result: "SUCCESS", consensus_timestamp: "1000.5", token_transfers: [{ token_id: "0.0.1", account: "0.0.2", amount: 5 }, { token_id: "0.0.1", account: "0.0.3", amount: -5 }] }] };

  it("a consensus result is final, so it is fetched once", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(tx)));
    vi.stubGlobal("fetch", f);
    const m = new Mirror("https://m.test", "0.0.1", new Store(":memory:"));
    expect(await m.tx("0.0.9@1.1")).toMatchObject({ found: true, success: true, payer: "0.0.3", payee: "0.0.2", consensusTs: 1000.5 });
    await m.tx("0.0.9@1.1");
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("not found may only be indexing lag, so it is never cached", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", f);
    const m = new Mirror("https://m.test", "0.0.1", new Store(":memory:"));
    expect(await m.tx("0.0.9@1.1")).toEqual({ found: false, success: false });
    await m.tx("0.0.9@1.1");
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("a server error throws and marks Mirror down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    const store = new Store(":memory:");
    await expect(new Mirror("https://m.test", "0.0.1", store).tx("0.0.9@1.1")).rejects.toThrow();
    expect(store.healthAll()[0]).toMatchObject({ dep: "mirror", ok: false });
  });
});

describe("the live clock from the environment", () => {
  it("is production unless asked, and production ignores the clock settings", () => {
    expect(policyFromEnv({}).name).toBe("production");
    const p = policyFromEnv({ LEASH_POLICY_PROFILE: "production", LEASH_LIVE_BLOCK_SEC: "60", LEASH_LIVE_DAY_SEC: "1" });
    expect(p.blockSec[0]).toBe(5 * 86400);
    expect(p.policyDaySec).toBe(86400);
  });
  it("uses the defaults when the settings are empty", () => {
    for (const env of [{ LEASH_POLICY_PROFILE: "live" }, { LEASH_POLICY_PROFILE: "live", LEASH_LIVE_BLOCK_SEC: " ", LEASH_LIVE_DAY_SEC: "" }]) {
      expect(policyFromEnv(env)).toMatchObject({ name: "live", policyDaySec: 18, blockSec: [60, 120, 300] });
    }
  });
  it("reads the configured values", () => {
    expect(policyFromEnv({ LEASH_POLICY_PROFILE: "live", LEASH_LIVE_BLOCK_SEC: "120, 240,600", LEASH_LIVE_DAY_SEC: "30" })).toMatchObject({ policyDaySec: 30, blockSec: [120, 240, 600], holdSec: 90 });
  });
  it.each([
    ["words for a block", { LEASH_LIVE_BLOCK_SEC: "one minute" }],
    ["a stray comma", { LEASH_LIVE_BLOCK_SEC: "60,,300" }],
    ["blocks that shrink", { LEASH_LIVE_BLOCK_SEC: "300,60" }],
    ["words for a day", { LEASH_LIVE_DAY_SEC: "soon" }],
    ["a day as long as the first block", { LEASH_LIVE_DAY_SEC: "60" }],
  ])("stops at startup on %s", (_name, env) => {
    expect(() => policyFromEnv({ LEASH_POLICY_PROFILE: "live", ...env })).toThrow(RangeError);
  });
  it("stops on an unknown profile rather than running on a guess", () => {
    expect(() => policyFromEnv({ LEASH_POLICY_PROFILE: "demo" })).toThrow(RangeError);
  });
});

describe("store", () => {
  const card = { merchant: "m" };
  const fresh = () => new Store(":memory:");
  const approval = (id: string) => ({ id, agent: "a", decisionId: "d", challengeHash: "h", card, createdAt: 100, expiresAt: 220 });

  it("an approval can be used once", () => {
    const s = fresh();
    s.createApproval(approval("x"));
    expect(s.consumeApproval("a", "h", 150)).toBeUndefined(); // still pending
    expect(s.resolveApproval("x", "approved", "0xsig")).toBe(true);
    expect(s.consumeApproval("a", "other", 150)).toBeUndefined(); // bound to one challenge
    expect(s.consumeApproval("a", "h", 150)?.id).toBe("x");
    expect(s.consumeApproval("a", "h", 150)).toBeUndefined();
  });
  it("an expired approval cannot be used or resolved", () => {
    const s = fresh();
    s.createApproval(approval("x"));
    s.resolveApproval("x", "approved", "0xsig");
    expect(s.consumeApproval("a", "h", 300)).toBeUndefined();
    s.createApproval(approval("y"));
    s.expireApprovals(300);
    expect(s.resolveApproval("y", "approved")).toBe(false);
    expect(s.getApproval("y")?.status).toBe("expired");
  });
  it("ledger counts per merchant, session and day", () => {
    const s = fresh();
    s.recordSpend({ agent: "a", session: "s", merchant: "m", resource: "r", standing: "NEW", amount: 0.01, at: 1000 });
    s.recordSpend({ agent: "a", session: "old", merchant: "m2", resource: "r2", standing: "ESTABLISHED", amount: 0.02, at: 1000 });
    s.recordSpend({ agent: "b", session: "s", merchant: "m", resource: "r", standing: "NEW", amount: 9, at: 1000 });
    const l = s.ledger("a", "s", "m", "r", 1001);
    expect(l.merchantSpent24h).toBeCloseTo(0.01);
    expect(l.sessionSpent).toBeCloseTo(0.01);
    expect(l.dailySpent).toBeCloseTo(0.03);
    expect(l.newIdentitySpentToday).toBeCloseTo(0.01);
    expect(l.recentPrices).toEqual([0.01]);
    expect(s.ledger("a", "s", "m", "r", 1000 + 86401).merchantSpent24h).toBe(0);
  });
  it("outbox dedupes and backs off", () => {
    const s = fresh();
    s.enqueue("report", "k", { a: 1 });
    s.enqueue("report", "k", { a: 2 });
    const [item] = s.dueOutbox(0);
    expect(s.dueOutbox(0)).toHaveLength(1);
    expect(item!.payload).toEqual({ a: 1 });
    s.outboxRetry(item!.id, 3, 100);
    expect(s.dueOutbox(100)).toHaveLength(0);
    expect(s.dueOutbox(108)).toHaveLength(1);
    s.outboxDone(item!.id);
    expect(s.outboxDepth().depth).toBe(0);
  });
  it("an outbox item can be claimed once", () => {
    const s = fresh();
    s.enqueue("report", "k", {});
    const [item] = s.dueOutbox(0);
    expect(s.claimOutbox(item!.id, 0)).toBe(true);
    expect(s.claimOutbox(item!.id, 0)).toBe(false);
  });
  it("state survives a restart", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const path = join(mkdtempSync(join(tmpdir(), "leash-")), "h.sqlite");
    const a = new Store(path);
    a.markPaid("x", "h", 10);
    a.db.close();
    const b = new Store(path);
    expect(b.paidAt("x", "h")).toBe(10);
    b.db.close();
  });
});
