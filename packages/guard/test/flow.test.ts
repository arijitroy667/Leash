// The whole guard with the real x402 client and real signatures. Only the network is replaced: the merchant is a stub
// fetch, and the ENS, Arkiv and Mirror adapters are spies, so each failure in PRD section 12 can be caused on demand.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrivateKey } from "@hiero-ledger/sdk";
import { wrapFetchWithPayment } from "@x402/fetch";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { StandingView } from "@leash/core";
import { liveProfile } from "@leash/core";
import { LeashDenied, LeashEscalated, approvalMessage, createLeashGuard, rawClient, type GuardConfig, type LeashGuard } from "../src/index.ts";

const USDC = "0.0.429274";
const PAYEE = "0.0.100";
const ORIGIN = "https://m.example";
const URL_ = `${ORIGIN}/data`;
const owner = privateKeyToAccount(generatePrivateKey());
const decl = { payTo: PAYEE, network: "hedera:testnet", asset: USDC, maxPriceUsd: 0.25, domains: [ORIGIN], schema: ["city"], policyVersion: 1 };
const FEE = { feePayer: "0.0.7162784" };
const declared = (over: Record<string, unknown> = {}) => ({ scheme: "exact", network: "hedera:testnet", amount: "5000", asset: USDC, payTo: PAYEE, maxTimeoutSeconds: 60, extra: { leashEns: "m.eth", ...FEE }, ...over });
const unclaimed = (over: Record<string, unknown> = {}) => declared({ extra: FEE, ...over });
const goodBody = () => new Response(JSON.stringify({ city: "x" }), { status: 200, headers: { "content-type": "application/json" } });

const view = (over: Partial<StandingView>): StandingView => ({
  standing: "NEW", strikes: 0, blockStart: null, blockEnd: null, probationStart: null, holdUntil: null, rebuttalUsed: false, computedAt: Date.now() / 1000,
  b: 0, bScore: 0, L: 0, D: 0, g: 0, badClusters: 0, goodClusters: 0, ...over,
});

const open: LeashGuard[] = [];

function setup(opts: { req?: ReturnType<typeof declared>; deliver?: () => Response | Promise<Response>; cfg?: Partial<GuardConfig>; decl?: typeof decl | null } = {}) {
  const calls = { unpaid: 0, paid: 0 };
  const state = { req: opts.req ?? declared(), deliver: opts.deliver ?? goodBody, beforeChallenge: () => {} };
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = new Request(input, init);
    if (r.headers.has("PAYMENT-SIGNATURE") || r.headers.has("X-PAYMENT")) {
      calls.paid++;
      return state.deliver();
    }
    calls.unpaid++;
    state.beforeChallenge();
    const body = { x402Version: 2, error: "Payment required", resource: { url: r.url, description: "d", mimeType: "" }, accepts: [state.req] };
    return new Response(JSON.stringify({ error: "Payment required" }), {
      status: 402,
      headers: { "content-type": "application/json", "payment-required": Buffer.from(JSON.stringify(body)).toString("base64") },
    });
  }) as typeof fetch;

  const key = PrivateKey.generateECDSA().toStringRaw();
  const guard = createLeashGuard({
    agent: "agent-t", hederaAccount: "0.0.200", hederaKey: key, ownerAddress: owner.address, arkivAccessKey: "test", namespace: "t", dbPath: ":memory:", ...opts.cfg,
  });
  open.push(guard);
  const client = rawClient("0.0.200", key);
  guard.attach(client as never);
  const rawFetch = wrapFetchWithPayment(stub, client);
  const paidFetch = guard.guardedFetch(rawFetch);

  const spies = {
    ens: vi.spyOn(guard.ens, "fetch").mockImplementation(async () => (opts.decl === undefined ? decl : opts.decl)),
    ensHealth: vi.spyOn(guard.ens, "health").mockResolvedValue(true),
    reports: vi.spyOn(guard.arkiv, "reports").mockResolvedValue([]),
    probes: vi.spyOn(guard.arkiv, "probes").mockResolvedValue([]),
    rebuttals: vi.spyOn(guard.arkiv, "rebuttals").mockResolvedValue([]),
    badByPayer: vi.spyOn(guard.arkiv, "badReportsByPayer").mockResolvedValue([]),
    arkivHealth: vi.spyOn(guard.arkiv, "health").mockResolvedValue(true),
    write: vi.spyOn(guard.arkiv, "writeReport").mockResolvedValue({ entityKey: "0xe", txHash: "0xt" } as never),
    mirrorTx: vi.spyOn(guard.mirror, "tx").mockResolvedValue({ found: false, success: false }),
    mirrorAccount: vi.spyOn(guard.mirror, "account").mockResolvedValue({ keyType: "ECDSA_SECP256K1", key: "00", createdTs: 0, funder: "0.0.2" }),
    mirrorHealth: vi.spyOn(guard.mirror, "health").mockResolvedValue(true),
  };

  /** One call, reduced to what happened. */
  const pay = async (init?: RequestInit & { leashIdempotent?: boolean }) => {
    try {
      const res = await paidFetch(URL_, init);
      return { verdict: "ALLOW" as const, reasons: [] as string[], res, leash: (res as any).leash };
    } catch (e) {
      if (e instanceof LeashDenied) return { verdict: "DENY" as const, reasons: e.decision.reasons as string[], decision: e.decision };
      if (e instanceof LeashEscalated) return { verdict: "ESCALATE" as const, reasons: e.decision.reasons as string[], approvalId: e.approvalId, decision: e.decision };
      throw e;
    }
  };
  const sign = async (id: string, by = owner) => {
    const a = guard.store.getApproval(id)!;
    return guard.store.resolveApproval(id, "approved", await by.signMessage({ message: approvalMessage(a) }));
  };
  return { guard, spies, calls, state, pay, sign, rawFetch };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: 1_800_000_000_000 });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  for (const g of open.splice(0)) g.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const advance = (sec: number) => vi.setSystemTime(Date.now() + sec * 1000);

describe("FR-01 and FR-07: a paid call is gated, checked and reported", () => {
  it("ALLOW pays once with no human, and files a good report only after Mirror confirms settlement", async () => {
    const t = setup();
    const r = await t.pay();
    expect(r.verdict).toBe("ALLOW");
    expect(t.calls.paid).toBe(1);
    expect(r.leash.delivered).toBe(true);

    await t.guard.flush();
    expect(t.spies.write).not.toHaveBeenCalled(); // Mirror has not seen it yet, so the report is held
    t.spies.mirrorTx.mockResolvedValue({ found: true, success: true, payer: "0.0.200", payee: PAYEE, token: USDC, amountAtomic: 5000, consensusTs: 1_800_000_000 });
    advance(60);
    await t.guard.flush();
    expect(t.spies.write).toHaveBeenCalledTimes(1);
    expect(t.spies.write.mock.calls[0]![1]).toMatchObject({ outcome: "good", reason: "delivered", payer: "0.0.200", payee: PAYEE, domain: ORIGIN, amountMicroUsd: 5000 });
  });

  it("FR-24: a 200 missing a declared field is a bad report", async () => {
    const t = setup({ deliver: () => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }) });
    const r = await t.pay();
    expect(r.leash.delivered).toBe(false);
    t.spies.mirrorTx.mockResolvedValue({ found: true, success: true, payer: "0.0.200", payee: PAYEE, token: USDC, amountAtomic: 5000, consensusTs: 1_800_000_000 });
    advance(1);
    await t.guard.flush();
    expect(t.spies.write.mock.calls[0]![1]).toMatchObject({ outcome: "bad", reason: "schema-mismatch" });
  });

  it("a dry run decides without paying", async () => {
    const t = setup();
    const d = await t.guard.check({ url: URL_, requirements: declared() });
    expect(d.verdict).toBe("ALLOW");
    expect(t.calls.paid).toBe(0);
    expect(t.guard.explain(d.id)).toMatchObject({ id: d.id, verdict: "ALLOW", factors: d.factors, limits: d.limits }); // FR-22
  });

  it("observe mode logs a DENY without blocking", async () => {
    const t = setup({ req: declared({ payTo: "0.0.999" }), cfg: { mode: "observe" } });
    const r = await t.pay();
    expect(r.verdict).toBe("ALLOW");
    expect(t.calls.paid).toBe(1);
    expect(t.guard.store.recentDecisions(1)[0]).toMatchObject({ verdict: "DENY", reasons: ["declared-mismatch"] });
  });

  it("a call that skips guardedFetch has no known origin, so it never pays by itself", async () => {
    const t = setup();
    await expect(t.rawFetch(URL_)).rejects.toThrow(/leash:ESCALATE/);
    expect(t.calls.paid).toBe(0);
    expect(t.guard.store.recentDecisions(1)[0]!.reasons).toContain("unknown-origin");
  });

  it("a raw call the owner approved still counts for replay and spend", async () => {
    const t = setup();
    await expect(t.rawFetch(URL_)).rejects.toThrow(/leash:ESCALATE/);
    await t.sign(t.guard.store.listApprovals("pending")[0]!.id);
    await t.rawFetch(URL_);
    expect(t.calls.paid).toBe(1);
    await expect(t.rawFetch(URL_)).rejects.toThrow(/leash:DENY:replay/);
    expect(t.calls.paid).toBe(1);
    expect(t.guard.store.budget("agent-t", t.guard.session, Date.now() / 1000).sessionSpent).toBeCloseTo(0.005);
  });

  it("autoReport off files nothing", async () => {
    const t = setup({ cfg: { autoReport: false } });
    await t.pay();
    expect(t.guard.store.outboxDepth().depth).toBe(0);
  });

  it("FR-04: a repeat inside 120 seconds is DENY replay, after it pays again, and the flag allows a deliberate repeat", async () => {
    const t = setup();
    await t.pay();
    const repeat = await t.pay();
    expect(repeat.verdict).toBe("DENY");
    expect(repeat.reasons).toContain("replay");
    expect((await t.pay({ leashIdempotent: true })).verdict).toBe("ALLOW");
    advance(121);
    expect((await t.pay()).verdict).toBe("ALLOW");
    expect(t.calls.paid).toBe(3);
  });

  it("FR-04: a challenge older than its maxTimeoutSeconds is refused", async () => {
    const t = setup();
    t.state.beforeChallenge = () => advance(61);
    const r = await t.pay();
    expect(r.verdict).toBe("DENY");
    expect(r.reasons).toContain("stale-challenge");
    expect(t.calls.paid).toBe(0);
  });

  it("FR-25: a tuned live clock reaches the guard, and it decides with it", async () => {
    const t = setup({ cfg: { policy: liveProfile(10, [200]) } });
    expect(t.guard.params).toMatchObject({ name: "live", policyDaySec: 10, blockSec: [200] });
  });

  it("FR-05: a spoofed payTo, network, asset or origin never reaches a payment", async () => {
    for (const over of [{ payTo: "0.0.999" }, { asset: "0.0.1" }, { network: "hedera:mainnet" }]) {
      const t = setup({ req: declared(over) });
      const r = await t.pay();
      expect(r.verdict).toBe("DENY");
      expect(t.calls.paid).toBe(0);
    }
    const t = setup({ decl: { ...decl, domains: ["https://other.example"] } });
    expect((await t.pay()).reasons).toContain("declared-mismatch");
  });
});

describe("FR-15: owner-signed, single-use approvals bound to the challenge", () => {
  it("unknown merchant escalates, the owner signs, it pays once, and a second use is refused", async () => {
    const t = setup({ req: unclaimed() });
    const first = await t.pay();
    expect(first).toMatchObject({ verdict: "ESCALATE", reasons: ["unknown-merchant"] });
    expect(t.calls.paid).toBe(0);
    expect(t.guard.explain(first.decision!.id)?.approvalId).toBe(first.approvalId);

    await t.sign(first.approvalId!);
    expect((await t.pay()).verdict).toBe("ALLOW");
    expect(t.calls.paid).toBe(1);
    expect(t.guard.store.getApproval(first.approvalId!)?.status).toBe("used");

    expect((await t.pay()).reasons).toContain("replay");
    expect(t.calls.paid).toBe(1);
  });

  it("a signature from any other wallet never pays, even written straight into the database", async () => {
    const t = setup({ req: unclaimed() });
    const { approvalId } = await t.pay();
    await t.sign(approvalId!, privateKeyToAccount(generatePrivateKey()));
    expect(t.guard.store.getApproval(approvalId!)?.status).toBe("approved");
    expect((await t.pay()).verdict).toBe("ESCALATE");
    expect(t.calls.paid).toBe(0);
  });

  it("an approval for one challenge does not cover another, and it expires in 120 seconds", async () => {
    const t = setup({ req: unclaimed() });
    const { approvalId } = await t.pay();
    await t.sign(approvalId!);
    t.state.req = unclaimed({ amount: "6000" });
    expect((await t.pay()).verdict).toBe("ESCALATE");
    expect(t.calls.paid).toBe(0);
    t.state.req = unclaimed();
    advance(121);
    expect((await t.pay()).verdict).toBe("ESCALATE");
    expect(t.calls.paid).toBe(0);
  });

  it("an expired approval cannot be used, and a fresh card is made on request", async () => {
    const t = setup({ req: unclaimed() });
    const first = await t.pay();
    advance(121);
    const second = await t.pay();
    expect(second.verdict).toBe("ESCALATE");
    expect(second.approvalId).not.toBe(first.approvalId);
    expect(t.guard.store.getApproval(first.approvalId!)?.status).toBe("expired");
    expect(t.guard.store.getApproval(second.approvalId!)?.status).toBe("pending");
    expect(t.calls.paid).toBe(0);
  });

  it("a rejection stands, and reject and block locally denies from then on", async () => {
    const t = setup({ req: unclaimed() });
    const { approvalId } = await t.pay();
    expect(t.guard.store.resolveApproval(approvalId!, "rejected")).toBe(true);
    expect(t.guard.store.getApproval(approvalId!)?.status).toBe("rejected");
    t.guard.store.blockLocally(PAYEE, Date.now() / 1000);
    const r = await t.pay();
    expect(r.verdict).toBe("DENY");
    expect(r.reasons).toContain("locally-blocked");
  });

  it("the card shows structured fields, including declared against asked price", async () => {
    const t = setup({ req: declared({ amount: "50000" }) });
    const { approvalId } = await t.pay();
    expect(t.guard.store.getApproval(approvalId!)?.card).toMatchObject({ merchant: "m.eth", standing: "NEW", amountUsd: 0.05, declaredMaxUsd: 0.25, remainingCap24h: 0.05 });
  });

  it("awaitApprovalMs waits for the owner, then pays", async () => {
    vi.useRealTimers();
    const t = setup({ req: unclaimed(), cfg: { awaitApprovalMs: 5000 } });
    const pending = t.pay();
    let id: string | undefined;
    for (let i = 0; i < 200 && !id; i++) {
      await new Promise((r) => setTimeout(r, 20));
      id = t.guard.store.listApprovals("pending")[0]?.id;
    }
    await t.sign(id!);
    expect((await pending).verdict).toBe("ALLOW");
    expect(t.calls.paid).toBe(1);
  });

  it("awaitApprovalMs gives up with the approval id still pending", async () => {
    vi.useRealTimers();
    const t = setup({ req: unclaimed(), cfg: { awaitApprovalMs: 50 } });
    const r = await t.pay();
    expect(r.verdict).toBe("ESCALATE");
    expect(t.guard.store.getApproval(r.approvalId!)?.status).toBe("pending");
  });

  it("the 10th approval can still be used; the 11th new escalation is denied", async () => {
    const t = setup({ req: unclaimed() });
    let last = "";
    for (let i = 1; i <= 10; i++) {
      t.state.req = unclaimed({ amount: String(5000 + i) });
      last = (await t.pay()).approvalId!;
    }
    await t.sign(last);
    expect((await t.pay()).verdict).toBe("ALLOW"); // same challenge as the 10th, so not a new escalation
    t.state.req = unclaimed({ amount: "7000" });
    const r = await t.pay();
    expect(r.verdict).toBe("DENY");
    expect(r.reasons).toContain("escalation-rate-limit");
  });
});

describe("FR-16 chaos matrix, PRD section 12", () => {
  describe("ENS", () => {
    it("down with no cache: UNKNOWN, so ESCALATE", async () => {
      const t = setup();
      t.spies.ens.mockRejectedValue(new Error("rpc down"));
      const r = await t.pay();
      expect(r.verdict).toBe("ESCALATE");
      expect(r.reasons).toContain("unknown-merchant");
      expect(t.guard.store.healthAll().find((h) => h.dep === "ens")?.ok).toBe(false);
    });
    it("down with a cache under 10 minutes: degraded, caps halved", async () => {
      const t = setup();
      await t.guard.check({ url: URL_, requirements: declared() });
      advance(120);
      t.spies.ens.mockRejectedValue(new Error("rpc down"));
      const d = await t.guard.check({ url: URL_, requirements: declared() });
      expect(d.degraded?.dependency).toBe("ens");
      expect(d.limits.cap24h).toBe(0.025);
    });
    it("a stale declaration that mismatches escalates and never denies", async () => {
      const t = setup({ decl: { ...decl, maxPriceUsd: 0.01 } });
      await t.guard.check({ url: URL_, requirements: declared() });
      advance(120);
      t.spies.ens.mockRejectedValue(new Error("rpc down"));
      for (const over of [{ payTo: "0.0.999" }, { amount: "20000" }]) {
        const d = await t.guard.check({ url: URL_, requirements: declared(over) });
        expect(d.verdict).toBe("ESCALATE");
        expect(d.reasons).toContain("declared-stale-mismatch");
      }
    });
    it("a cache over 10 minutes old is UNKNOWN", async () => {
      const t = setup();
      await t.guard.check({ url: URL_, requirements: declared() });
      advance(601);
      t.spies.ens.mockRejectedValue(new Error("rpc down"));
      const d = await t.guard.check({ url: URL_, requirements: declared() });
      expect(d.reasons).toContain("unknown-merchant");
    });
  });

  describe("Arkiv", () => {
    const down = (t: ReturnType<typeof setup>) => t.spies.reports.mockRejectedValue(new Error("arkiv down"));

    it("down with no cache: ESCALATE registry-unavailable", async () => {
      const t = setup();
      down(t);
      const r = await t.pay();
      expect(r.verdict).toBe("ESCALATE");
      expect(r.reasons).toContain("registry-unavailable");
      expect(t.calls.paid).toBe(0);
    });
    it("a cached block still denies until its computed end, then escalates", async () => {
      const t = setup();
      t.guard.store.standingPut(PAYEE, view({ standing: "BLOCKED", blockEnd: Date.now() / 1000 + 300, strikes: 1 }));
      down(t);
      advance(100);
      expect((await t.pay()).reasons).toContain("blocked");
      advance(201);
      const r = await t.pay();
      expect(r.verdict).toBe("ESCALATE");
      expect(r.reasons).toContain("registry-unavailable");
    });
    it("cached ESTABLISHED works for 15 minutes with halved caps, then does not", async () => {
      const t = setup();
      t.guard.store.standingPut(PAYEE, view({ standing: "ESTABLISHED", D: 0.6, g: 4 }));
      down(t);
      advance(120);
      const d = await t.guard.check({ url: URL_, requirements: declared() });
      expect(d.limits.cap24h).toBe(0.5);
      expect(d.degraded?.dependency).toBe("arkiv");
      advance(800);
      expect((await t.guard.check({ url: URL_, requirements: declared() })).reasons).toContain("registry-unavailable");
    });
    it("cached NEW is not usable once stale", async () => {
      const t = setup();
      t.guard.store.standingPut(PAYEE, view({ standing: "NEW" }));
      down(t);
      advance(120);
      expect((await t.guard.check({ url: URL_, requirements: declared() })).reasons).toContain("registry-unavailable");
    });
    it("cached PROBATION keeps its limits", async () => {
      const t = setup();
      t.guard.store.standingPut(PAYEE, view({ standing: "PROBATION", strikes: 1, probationStart: 1 }));
      down(t);
      advance(120);
      const d = await t.guard.check({ url: URL_, requirements: declared({ amount: "30000" }) });
      expect(d.standing).toBe("PROBATION");
      expect(d.verdict).toBe("ESCALATE");
    });
    it("a failed report write stays in the outbox and never touches the response", async () => {
      const t = setup();
      t.spies.write.mockRejectedValue(new Error("arkiv down"));
      t.spies.mirrorTx.mockResolvedValue({ found: true, success: true, payer: "0.0.200", payee: PAYEE, token: USDC, amountAtomic: 5000, consensusTs: 1_800_000_000 });
      expect((await t.pay()).verdict).toBe("ALLOW");
      advance(1);
      await t.guard.flush();
      expect(t.guard.store.outboxDepth().depth).toBe(1);
      t.spies.write.mockResolvedValue({ entityKey: "0xe", txHash: "0xt" } as never);
      advance(120);
      await t.guard.flush();
      expect(t.guard.store.outboxDepth().depth).toBe(0);
    });
  });

  describe("Mirror Node", () => {
    const badRow = (payer: string, txId: string) => ({
      owner: "0xa", payee: PAYEE, ens: "", domain: ORIGIN, outcome: "bad" as const, txId, payer, payerSig: "00", consensusTs: 1, amountMicroUsd: 5000, reason: "x", v: 1,
    });
    it("two unverified bad clusters escalate on every call, and the partial read is never cached", async () => {
      const t = setup();
      t.spies.reports.mockResolvedValue([badRow("0.0.301", "t1"), badRow("0.0.302", "t2")]);
      t.spies.mirrorTx.mockRejectedValue(new Error("mirror 503"));
      for (let i = 0; i < 2; i++) {
        const d = await t.guard.check({ url: URL_, requirements: declared() });
        expect(d.verdict).toBe("ESCALATE");
        expect(d.reasons).toContain("unverified-reports");
        advance(1);
      }
      expect(t.guard.store.standingGet(PAYEE)).toBeUndefined();
    });
    it("unverified reports are never a DENY", async () => {
      const t = setup();
      t.spies.reports.mockResolvedValue([badRow("0.0.301", "t1"), badRow("0.0.302", "t2"), badRow("0.0.303", "t3")]);
      t.spies.mirrorTx.mockRejectedValue(new Error("mirror 503"));
      expect((await t.guard.check({ url: URL_, requirements: declared() })).verdict).toBe("ESCALATE");
    });
    it("a report is held while Mirror is down, without calling Arkiv down", async () => {
      const t = setup();
      await t.pay();
      t.spies.mirrorTx.mockRejectedValue(new Error("mirror 503"));
      advance(1);
      await t.guard.flush();
      expect(t.spies.write).not.toHaveBeenCalled();
      expect(t.guard.store.outboxDepth().depth).toBe(1);
      expect(t.guard.store.healthAll().find((h) => h.dep === "arkiv")?.ok).toBe(true);
    });
  });

  describe("facilitator: a failed settle never pays twice (F9)", () => {
    const failed = () => new Response('{"error":"settlement failed"}', { status: 402, headers: { "content-type": "application/json" } });
    const settled = { found: true, success: true, payer: "0.0.200", payee: PAYEE, token: USDC, amountAtomic: 5000, consensusTs: 1_800_000_000 };

    it("inside the window the retry is DENY replay, with the same 402 or a fresh one", async () => {
      const t = setup({ deliver: failed });
      await t.pay();
      expect(t.calls.paid).toBe(1);
      const r = await t.pay();
      expect(r.reasons).toContain("replay");
      expect(t.calls.paid).toBe(1);
    });
    it("after the window, Mirror is checked first: down or not yet landed is ESCALATE", async () => {
      const t = setup({ deliver: failed });
      await t.pay();
      advance(121);
      t.spies.mirrorTx.mockRejectedValue(new Error("mirror 503"));
      const down = await t.pay();
      expect(down.verdict).toBe("ESCALATE");
      expect(down.reasons).toContain("settlement-unknown");
      t.spies.mirrorTx.mockResolvedValue({ found: false, success: false });
      const lag = await t.pay();
      expect(lag.reasons).toContain("settlement-unknown");
      expect(t.calls.paid).toBe(1);
    });
    it("once it cannot land any more, a fresh attempt is allowed", async () => {
      const t = setup({ deliver: failed });
      await t.pay();
      advance(181);
      t.state.deliver = goodBody;
      expect((await t.pay()).verdict).toBe("ALLOW");
      expect(t.guard.store.settlementGet("agent-t", (await t.guard.check({ url: URL_, requirements: declared() })).challengeHash)).toBeUndefined();
    });
    it("Mirror confirming the first payment closes the question", async () => {
      const t = setup({ deliver: failed });
      await t.pay();
      advance(121);
      t.spies.mirrorTx.mockResolvedValue(settled);
      const d = await t.guard.check({ url: URL_, requirements: declared() });
      expect(d.reasons).not.toContain("settlement-unknown");
    });
    it("a connection lost after paying is held the same way, and reports only if it settled", async () => {
      const t = setup({ deliver: () => { throw new Error("socket hang up"); } });
      await expect(t.pay()).rejects.toThrow();
      const r = await t.pay();
      expect(r.reasons).toContain("replay");
      expect(t.calls.paid).toBe(1);
      advance(1);
      await t.guard.flush();
      expect(t.spies.write).not.toHaveBeenCalled();
      t.spies.mirrorTx.mockResolvedValue(settled);
      advance(120);
      await t.guard.flush();
      expect(t.spies.write.mock.calls[0]![1]).toMatchObject({ outcome: "bad", reason: "transport-failure" });
    });
  });

  describe("safe mode", () => {
    it("two dependencies down: everything escalates, a cached block still denies", async () => {
      const t = setup();
      t.guard.store.setHealth("ens", false, 1, "x");
      t.guard.store.setHealth("arkiv", false, 1, "x");
      t.spies.ensHealth.mockRejectedValue(new Error("down"));
      t.spies.arkivHealth.mockRejectedValue(new Error("down"));
      const r = await t.pay();
      expect(r.verdict).toBe("ESCALATE");
      expect(r.reasons).toContain("safe-mode");
      expect(t.calls.paid).toBe(0);

      t.guard.store.standingPut(PAYEE, view({ standing: "BLOCKED", blockEnd: Date.now() / 1000 + 900 }));
      expect((await t.pay()).verdict).toBe("DENY");
    });
    it("one dependency down is not safe mode", () => {
      const t = setup();
      t.guard.store.setHealth("arkiv", false, 1, "x");
      expect(t.guard.store.safeMode()).toBe(false);
    });
    it("HCS or the facilitator being down is not safe mode", () => {
      const t = setup();
      t.guard.store.setHealth("hcs", false, 1, "x");
      t.guard.store.setHealth("facilitator", false, 1, "x");
      expect(t.guard.store.safeMode()).toBe(false);
    });
    it("ends after three healthy reads in a row, and a failure restarts the count", () => {
      const { guard: { store } } = setup();
      const both = (ok: boolean) => {
        store.setHealth("ens", ok, 1);
        store.setHealth("arkiv", ok, 1);
      };
      both(false);
      both(true);
      both(true);
      expect(store.safeMode()).toBe(true);
      both(false); // a failure restarts the count
      both(true);
      both(true);
      expect(store.safeMode()).toBe(true);
      both(true);
      expect(store.safeMode()).toBe(false);
      expect(store.healthAll().every((h) => !h.recovering)).toBe(true);
    });
    it("real probes run on each decision, so safe mode can end by itself", async () => {
      const t = setup();
      t.guard.store.setHealth("ens", false, 1);
      t.guard.store.setHealth("arkiv", false, 1);
      for (let i = 0; i < 3; i++) {
        await t.guard.check({ url: URL_, requirements: declared() });
        advance(1);
      }
      expect(t.spies.arkivHealth).toHaveBeenCalled();
      expect(t.guard.store.safeMode()).toBe(false);
      expect((await t.guard.check({ url: URL_, requirements: declared() })).reasons).not.toContain("safe-mode");
    });
  });

  it("HCS: a queued audit message never blocks a payment", async () => {
    const t = setup({ cfg: { hcsTopicId: "0.0.1" } });
    const r = await t.pay();
    expect(r.verdict).toBe("ALLOW");
    const queued = t.guard.store.db.prepare("SELECT payload FROM outbox WHERE kind='hcs'").all() as { payload: string }[];
    expect(queued.map((q) => JSON.parse(q.payload).type)).toContain("decision");
  });

  it("FR-19: a denied call and an approval both get audit messages", async () => {
    const t = setup({ req: declared({ payTo: "0.0.999" }), cfg: { hcsTopicId: "0.0.1" } });
    await t.pay();
    t.state.req = unclaimed();
    const { approvalId } = await t.pay();
    await t.sign(approvalId!);
    await t.pay();
    const types = (t.guard.store.db.prepare("SELECT payload FROM outbox WHERE kind='hcs'").all() as { payload: string }[]).map((q) => JSON.parse(q.payload));
    expect(types.find((m) => m.type === "decision" && m.verdict === "DENY")?.reasons).toEqual(["declared-mismatch"]);
    expect(types.filter((m) => m.type === "approval").map((m) => m.state)).toEqual(["requested", "used"]);
  });

  it("guard restart: replay window, ledger, approvals and outbox all survive", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "leash-")), "state.sqlite");
    const key = { cfg: { dbPath } };
    const a = setup(key);
    await a.pay();
    const pendingId = (() => {
      a.state.req = unclaimed();
      return a.pay();
    })();
    const { approvalId } = await pendingId;
    open.splice(0);
    a.guard.close();

    const b = setup(key);
    expect(b.guard.store.getApproval(approvalId!)?.status).toBe("pending");
    expect(b.guard.store.outboxDepth().depth).toBeGreaterThanOrEqual(1);
    b.state.req = declared();
    const again = await b.pay();
    expect(again.reasons).toContain("replay");
    expect(b.calls.paid).toBe(0);
    expect(b.guard.store.ledger("agent-t", b.guard.session, "m.eth", URL_, Date.now() / 1000).merchantSpent24h).toBeCloseTo(0.005);

    // The outbox drains after a restart too.
    b.spies.mirrorTx.mockResolvedValue({ found: true, success: true, payer: "0.0.200", payee: PAYEE, token: USDC, amountAtomic: 5000, consensusTs: 1_800_000_000 });
    await b.guard.flush();
    expect(b.spies.write).toHaveBeenCalledTimes(1);
    expect(b.spies.write.mock.calls[0]![1]).toMatchObject({ outcome: "good", reason: "delivered" });
  });
});

describe("FR-13 and FR-14: caps and unknown merchants, through the guard", () => {
  it("soft cap escalates, hard cap denies, with real spend from the ledger", async () => {
    const t = setup();
    t.guard.store.recordSpend({ agent: "agent-t", session: "old", merchant: "m.eth", resource: "r", standing: "NEW", amount: 0.05, at: Date.now() / 1000 });
    const soft = await t.pay();
    expect(soft.verdict).toBe("ESCALATE");
    expect(soft.reasons).toContain("merchant-cap");
    t.guard.store.recordSpend({ agent: "agent-t", session: "old", merchant: "m.eth", resource: "r", standing: "NEW", amount: 0.2, at: Date.now() / 1000 });
    const hard = await t.pay();
    expect(hard.verdict).toBe("DENY");
    expect(hard.reasons).toContain("merchant-cap-hard");
  });
  it("an unknown merchant that other agents proved bad is DENY, not ESCALATE", async () => {
    const t = setup({ req: unclaimed() });
    t.guard.store.standingPut(PAYEE, view({ standing: "BLOCKED", blockEnd: Date.now() / 1000 + 900, strikes: 1, badClusters: 2 }));
    const r = await t.pay();
    expect(r.verdict).toBe("DENY");
    expect(r.reasons).toContain("blocked");
  });
});
