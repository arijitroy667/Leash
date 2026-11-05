import { describe, expect, it } from "vitest";
import fc from "fast-check";
import fixtures from "./fixtures.json" with { type: "json" };
import {
  DEFAULT_LIMITS, PROFILES, autoLimit, challengeHash, decide, replay, riskScore,
  type Challenge, type Declaration, type DecideInput, type Evidence, type Report, type Standing, type StandingView,
} from "../src/index.ts";

const P = PROFILES.production;
const L = PROFILES.live;
const DAY = 86400;
const USDC = "0.0.429274";
const OLD = -100 * DAY; // payer created long before any evidence

const report = (ts: number, outcome: Report["outcome"], cluster: string, amountUsd = 0.005, createdTs = OLD): Report =>
  ({ txId: `${cluster}-${ts}`, ts, outcome, cluster, payer: cluster, amountUsd, payerCreatedTs: createdTs });
const none: Evidence = { reports: [], probes: [], rebuttals: [] };
const ev = (reports: Report[], extra: Partial<Evidence> = {}): Evidence => ({ ...none, reports, ...extra });

const decl: Declaration = {
  payTo: "0.0.100", network: "hedera:testnet", asset: USDC, maxPriceUsd: 1, domains: ["https://m.example"], schema: [], policyVersion: 1,
};
const challenge = (A: number, over: Partial<Challenge> = {}): Challenge => ({
  scheme: "exact", network: "hedera:testnet", asset: USDC, amountUsd: A, payTo: "0.0.100",
  resourceUrl: "https://m.example/data", maxTimeoutSeconds: 60, ...over,
});
const viewOf = (v: Partial<StandingView>): StandingView => ({
  standing: "NEW", strikes: 0, blockEnd: null, probationStart: null, holdUntil: null, rebuttalUsed: false, computedAt: 0,
  b: 0, bScore: 0, L: 0, D: 0, g: 0, badClusters: 0, goodClusters: 0, ...v,
});
const input = (over: Partial<DecideInput> = {}): DecideInput => ({
  now: 1000,
  challenge: challenge(0.005),
  realOrigin: "https://m.example",
  claim: "m.eth",
  declaration: { status: "fresh", value: decl },
  registry: { status: "fresh", view: viewOf({ computedAt: 1000 }) },
  ledger: { merchantSpent24h: 0, sessionSpent: 0, dailySpent: 0, newIdentitySpentToday: 0, recentPrices: [] },
  challengeState: { receivedAt: 1000, paidAt: null },
  escalationsLastHour: 0,
  limits: { ...DEFAULT_LIMITS, allowedAssets: [USDC] },
  params: P,
  ...over,
});

describe("golden fixtures", () => {
  for (const f of fixtures) {
    it(`${f.id} score and limit`, () => {
      const st = f.standing as Standing;
      const { R } = riskScore({ standing: st, b: f.b, L: f.L, D: f.D, g: f.g, A: f.A, s: f.s, t: f.t });
      expect(Math.abs(R - f.R)).toBeLessThan(0.06);
      expect(autoLimit(st, f.D, f.s, f.declaredMax)).toBeCloseTo(f.limit, 3);
    });
    it(`${f.id} final verdict`, () => {
      const view = viewOf({
        standing: (f.after ?? f.standing) as StandingView["standing"],
        b: f.b, bScore: f.b, L: f.L, D: f.D, g: f.g, badClusters: f.badClusters, strikes: f.s,
        blockEnd: f.after ? 5000 : null, computedAt: 1000,
      });
      const d = decide(input({ challenge: challenge(f.A), registry: { status: "fresh", view }, familyTaint: f.t === 1 }));
      expect(d.verdict).toBe(f.final);
    });
  }
});

describe("standing replay", () => {
  it("one bad cluster never blocks", () => {
    expect(replay(ev([report(0, "bad", "a", 0.5)]), 1, P).standing).toBe("NEW");
  });

  it("two clusters block, and the block latches after b decays (defect 1)", () => {
    const e = ev([report(0, "bad", "a"), report(10, "bad", "b")]);
    const v = replay(e, 11, P);
    expect(v.standing).toBe("BLOCKED");
    expect(v.blockEnd).toBe(10 + 5 * DAY);
    const later = replay(e, 12 * 3600, P);
    expect(later.b).toBeLessThan(1);
    expect(later.standing).toBe("BLOCKED");
  });

  it("wallets under 24 hours weigh half and cannot block alone (defect 2)", () => {
    const e = ev([report(0, "bad", "a", 0.005, -60), report(10, "bad", "b", 0.005, -60)]);
    expect(replay(e, 11, P).standing).toBe("NEW");
  });

  it("block doubles per strike and is capped", () => {
    const first = [report(0, "bad", "a"), report(1, "bad", "b")];
    expect(replay(ev(first), 2, P).blockEnd).toBe(1 + 5 * DAY);
    const t2 = 1 + 5 * DAY;
    const second = [...first, report(t2 + 1, "bad", "a"), report(t2 + 2, "bad", "b")];
    const v = replay(ev(second), t2 + 3, P);
    expect(v.strikes).toBe(2);
    expect(v.blockEnd).toBe(t2 + 2 + 10 * DAY);
  });

  it("block ends in probation, never established", () => {
    const e = ev([report(0, "bad", "a"), report(1, "bad", "b")]);
    const v = replay(e, 1 + 5 * DAY, P);
    expect(v.standing).toBe("PROBATION");
    expect(v.b).toBe(0); // pre-block evidence is out of scope
  });

  it("probation: one bad cluster holds, second blocks with strike plus one", () => {
    const base = [report(0, "bad", "a"), report(1, "bad", "b")];
    const entry = 1 + 5 * DAY;
    const held = replay(ev([...base, report(entry + 10, "bad", "a")]), entry + 11, P);
    expect(held.standing).toBe("PROBATION");
    expect(held.holdUntil).toBe(entry + 10 + 3 * DAY);
    const after = replay(ev([...base, report(entry + 10, "bad", "a")]), entry + 11 + 3 * DAY, P);
    expect(after.holdUntil).toBeNull();
    const reblocked = replay(ev([...base, report(entry + 10, "bad", "a"), report(entry + 20, "bad", "c")]), entry + 21, P);
    expect(reblocked.standing).toBe("BLOCKED");
    expect(reblocked.strikes).toBe(2);
  });

  it("probation recovers only with proven delivery", () => {
    const base = [report(0, "bad", "a"), report(1, "bad", "b")];
    const entry = 1 + 5 * DAY;
    const goods = ["x", "y", "z"].map((c, n) => report(entry + n + 1, "good", c, 0.1));
    expect(replay(ev([...base, ...goods]), entry + 2 * DAY, P).standing).toBe("PROBATION");
    expect(replay(ev([...base, ...goods]), entry + 3 * DAY + 5, P).standing).toBe("ESTABLISHED");
    expect(replay(ev(base), entry + 3 * DAY + 5, P).standing).toBe("PROBATION");
  });

  it("waiting alone reaches NEW, not ESTABLISHED", () => {
    const base = [report(0, "bad", "a"), report(1, "bad", "b")];
    expect(replay(ev(base), 1 + 5 * DAY + 21 * DAY, P).standing).toBe("NEW");
  });

  it("new to established needs three clusters, delivered value and 24 hours", () => {
    const goods = ["x", "y", "z"].map((c, n) => report(n, "good", c, 0.05));
    expect(replay(ev(goods), 100, P).standing).toBe("NEW");
    expect(replay(ev(goods), DAY + 100, P).standing).toBe("ESTABLISHED");
  });

  it("established returns to new when good evidence expires", () => {
    const goods = ["x", "y", "z"].map((c, n) => report(n, "good", c, 0.05));
    expect(replay(ev(goods), 22 * DAY, P).standing).toBe("NEW");
  });

  it("rebuttal alone does not unblock; failed probe keeps it blocked and consumes it", () => {
    const base = [report(0, "bad", "a"), report(1, "bad", "b")];
    const alone = replay(ev(base, { rebuttals: [{ ts: 10 }] }), DAY * 2, P);
    expect(alone.standing).toBe("BLOCKED");
    const failed = ev(base, {
      rebuttals: [{ ts: 10 }, { ts: 30 }],
      probes: [
        { txId: "p1", ts: 20, result: "fail", cluster: "prober", amountUsd: 0.01 },
        { txId: "p2", ts: 40, result: "pass", cluster: "prober", amountUsd: 0.01 },
      ],
    });
    expect(replay(failed, DAY * 2, P).standing).toBe("BLOCKED");
  });

  it("rebuttal with passing probe reaches probation after the cooldown, not before", () => {
    const e = ev([report(0, "bad", "a"), report(1, "bad", "b")], {
      rebuttals: [{ ts: 10 }],
      probes: [{ txId: "p", ts: 20, result: "pass", cluster: "prober", amountUsd: 0.01 }],
    });
    expect(replay(e, 100, P).standing).toBe("BLOCKED");
    expect(replay(e, 1 + DAY, P).standing).toBe("PROBATION");
  });

  it("contested established merchant needs three clusters", () => {
    const goods = ["x", "y", "z", "w"].map((c, n) => report(n, "good", c, 0.2));
    const start = DAY + 10;
    const two = [report(start, "bad", "a", 0.05), report(start + 1, "bad", "b", 0.05)];
    expect(replay(ev([...goods, ...two]), start + 2, P).standing).toBe("ESTABLISHED");
    const three = [...two, report(start + 2, "bad", "c", 0.05)];
    expect(replay(ev([...goods, ...three]), start + 3, P).standing).toBe("BLOCKED");
  });

  it("one report per txId; conflicting outcomes cancel; repeat bad within the window ignored", () => {
    const dup = { ...report(0, "bad", "a"), txId: "t" };
    expect(replay(ev([dup, { ...dup, cluster: "b", payer: "b" }]), 1, P).badClusters).toBe(1);
    expect(replay(ev([dup, { ...dup, outcome: "good" }]), 1, P).badClusters).toBe(0);
    const v = replay(ev([report(0, "bad", "a", 0.05), report(10, "bad", "a", 0.05)]), 11, P);
    expect(v.L).toBeCloseTo(0.05, 3);
  });

  it("future-dated entities are ignored", () => {
    expect(replay(ev([report(100, "bad", "a")]), 50, P).badClusters).toBe(0);
  });

  it("live profile runs the scam loop in real seconds (section 19)", () => {
    const first = [report(0, "bad", "a"), report(5, "bad", "b")];
    expect(replay(ev(first), 6, L).blockEnd).toBe(95);
    expect(replay(ev(first), 95, L).standing).toBe("PROBATION");
    // agent A again, 100 s after its first bad report: not rate limited in live
    const again = [...first, report(100, "bad", "a")];
    const held = replay(ev(again), 101, L);
    expect(held.holdUntil).toBe(154);
    const blocked = replay(ev([...again, report(120, "bad", "b")]), 121, L);
    expect(blocked.standing).toBe("BLOCKED");
    expect(blocked.strikes).toBe(2);
    expect(blocked.blockEnd).toBe(300);
  });
});

describe("decide", () => {
  const reason = (o: Partial<DecideInput>) => decide(input(o));

  it("happy path S2", () => {
    const d = reason({});
    expect(d.verdict).toBe("ALLOW");
    expect(d.score).toBeCloseTo(27.5, 1);
    expect(d.reasons).toEqual([]);
  });
  it("ceiling", () => expect(reason({ challenge: challenge(1.5) }).reasons).toContain("ceiling-exceeded"));
  it("spoofed payTo", () => {
    const d = reason({ challenge: challenge(0.005, { payTo: "0.0.999" }) });
    expect(d.verdict).toBe("DENY");
    expect(d.reasons).toContain("declared-mismatch");
  });
  it("origin not declared", () => expect(reason({ realOrigin: "https://evil.example" }).reasons).toContain("declared-mismatch"));
  it("no origin known is not an ALLOW", () => expect(reason({ realOrigin: null }).verdict).toBe("ESCALATE"));
  it("over declared max", () => {
    const value = { ...decl, maxPriceUsd: 0.001 };
    expect(reason({ declaration: { status: "fresh", value } }).reasons).toContain("over-declared-max");
  });
  it("non-USDC asset", () => {
    const d = reason({ claim: null, challenge: challenge(0.005, { asset: "0.0.1" }), declaration: { status: "none" } });
    expect(d.reasons).toContain("unsupported-asset");
    expect(d.verdict).toBe("DENY");
  });
  it("replay inside window, allowed after, and with idempotent flag", () => {
    expect(reason({ challengeState: { receivedAt: 1000, paidAt: 900 } }).reasons).toContain("replay");
    expect(reason({ challengeState: { receivedAt: 1000, paidAt: 800 } }).reasons).not.toContain("replay");
    expect(reason({ idempotent: true, challengeState: { receivedAt: 1000, paidAt: 900 } }).reasons).not.toContain("replay");
  });
  it("stale challenge", () => expect(reason({ challengeState: { receivedAt: 900, paidAt: null } }).reasons).toContain("stale-challenge"));
  it("unknown always escalates even for dust", () => {
    const d = reason({ claim: null, declaration: { status: "none" }, challenge: challenge(0.001) });
    expect(d.verdict).toBe("ESCALATE");
    expect(d.reasons).toContain("unknown-merchant");
  });
  it("blocked payee with no ENS still denies", () => {
    const view = viewOf({ standing: "BLOCKED", blockEnd: 5000, computedAt: 1000 });
    const d = reason({ claim: null, declaration: { status: "none" }, registry: { status: "fresh", view } });
    expect(d.verdict).toBe("DENY");
  });
  it("soft cap escalates, hard cap denies", () => {
    const led = (m: number) => ({ merchantSpent24h: m, sessionSpent: 0, dailySpent: 0, newIdentitySpentToday: 0, recentPrices: [] });
    expect(reason({ ledger: led(0.05) }).reasons).toContain("merchant-cap");
    const hard = reason({ ledger: led(0.25) });
    expect(hard.verdict).toBe("DENY");
    expect(hard.reasons).toContain("merchant-cap-hard");
  });
  it("budget, new identity, price drift", () => {
    const base = { merchantSpent24h: 0, sessionSpent: 0, dailySpent: 0, newIdentitySpentToday: 0, recentPrices: [] as number[] };
    expect(reason({ ledger: { ...base, sessionSpent: 2 } }).reasons).toContain("budget-exceeded");
    expect(reason({ ledger: { ...base, newIdentitySpentToday: 0.1 } }).reasons).toContain("new-identity-budget");
    expect(reason({ ledger: { ...base, recentPrices: [0.001, 0.001] } }).reasons).toContain("price-drift");
  });
  it("escalation rate limit turns escalate into deny", () => {
    const d = reason({ escalationsLastHour: 10, challenge: challenge(0.05) });
    expect(d.reasons).toContain("escalation-rate-limit");
    expect(d.verdict).toBe("DENY");
  });
  it("probation limit and hold", () => {
    const view = viewOf({ standing: "PROBATION", strikes: 1, D: 1, g: 5, computedAt: 1000, probationStart: 1 });
    expect(reason({ challenge: challenge(0.2), registry: { status: "fresh", view } }).reasons).toContain("probation-limit");
    const held = { ...view, holdUntil: 2000 };
    expect(reason({ registry: { status: "fresh", view: held } }).reasons).toContain("probation-hold");
  });

  describe("outages never produce a silent ALLOW", () => {
    it("registry down, no cache", () => {
      const d = reason({ registry: { status: "none" } });
      expect(d.verdict).toBe("ESCALATE");
      expect(d.reasons).toContain("registry-unavailable");
    });
    it("cached block still denies", () => {
      const view = viewOf({ standing: "BLOCKED", blockEnd: 5000, computedAt: 100 });
      expect(reason({ registry: { status: "stale", view } }).verdict).toBe("DENY");
    });
    it("stale standing past its limit is unavailable", () => {
      const view = viewOf({ standing: "ESTABLISHED", D: 0.6, g: 4, computedAt: 1000 - 901 });
      expect(reason({ registry: { status: "stale", view } }).reasons).toContain("registry-unavailable");
    });
    it("stale standing halves caps and is marked degraded", () => {
      const view = viewOf({ standing: "ESTABLISHED", D: 0.6, g: 4, computedAt: 900 });
      const d = reason({ registry: { status: "stale", view } });
      expect(d.limits.cap24h).toBe(0.5);
      expect(d.degraded?.dependency).toBe("arkiv");
    });
    it("stale declaration mismatch escalates, never denies", () => {
      const d = reason({ declaration: { status: "stale", value: { ...decl, payTo: "0.0.1" }, fetchedAt: 900 } });
      expect(d.verdict).toBe("ESCALATE");
      expect(d.reasons).toContain("declared-stale-mismatch");
    });
    it("ENS down with no cache is unknown", () => {
      expect(reason({ declaration: { status: "none", outage: true } }).reasons).toContain("unknown-merchant");
    });
    it("unverified bad clusters escalate", () => {
      expect(reason({ unverifiedBadClusters: 2 }).reasons).toContain("unverified-reports");
    });
    it("safe mode escalates, cached block still denies", () => {
      expect(reason({ safeMode: true }).verdict).toBe("ESCALATE");
      const view = viewOf({ standing: "BLOCKED", blockEnd: 5000, computedAt: 100 });
      expect(reason({ safeMode: true, registry: { status: "stale", view } }).verdict).toBe("DENY");
    });
  });
});

describe("challenge hash", () => {
  it("is order independent and sensitive to payTo", () => {
    const a = challengeHash(challenge(0.005, { extra: { a: 1, b: 2 } }));
    const b = challengeHash(challenge(0.005, { extra: { b: 2, a: 1 } }));
    expect(a).toBe(b);
    expect(challengeHash(challenge(0.005, { payTo: "0.0.5" }))).not.toBe(a);
  });
});

describe("properties", () => {
  const n = { numRuns: 20000 };
  const pos = fc.double({ min: 0, max: 5, noNaN: true });
  const st = fc.constantFrom<Standing>("NEW", "ESTABLISHED", "PROBATION");
  const inp = fc.record({ standing: st, b: pos, L: pos, D: pos, g: pos, A: pos, s: fc.integer({ min: 0, max: 5 }), t: fc.constantFrom(0, 1) });
  const R = (i: Parameters<typeof riskScore>[0]) => riskScore(i).R;
  const eps = 1e-9;

  it("R rises with b, L, A", () => {
    fc.assert(fc.property(inp, pos, (i, d) => {
      return R({ ...i, b: i.b + d }) >= R(i) - eps && R({ ...i, L: i.L + d }) >= R(i) - eps && R({ ...i, A: i.A + d }) >= R(i) - eps;
    }), n);
  });
  it("R falls with g, D", () => {
    fc.assert(fc.property(inp, pos, (i, d) => R({ ...i, g: i.g + d }) <= R(i) + eps && R({ ...i, D: i.D + d }) <= R(i) + eps), n);
  });

  const reports = (clusters: string[]) => fc.array(fc.record({
    ts: fc.integer({ min: 0, max: 30 * DAY }),
    amountUsd: fc.double({ min: 0.001, max: 1, noNaN: true }),
    outcome: fc.constantFrom<Report["outcome"]>("good", "bad"),
    cluster: fc.constantFrom(...clusters),
  }), { maxLength: 30 }).map((a) => a.map((r, n) => ({ ...r, txId: `t${n}`, payer: r.cluster, payerCreatedTs: OLD })));

  it("no single bad cluster ever yields DENY through the score or standing", () => {
    fc.assert(fc.property(reports(["only"]), fc.integer({ min: 0, max: 40 * DAY }), fc.double({ min: 0.001, max: 0.24, noNaN: true }), (rs, now, A) => {
      const view = replay(ev(rs), now, P);
      const d = decide(input({ now, challenge: challenge(A), registry: { status: "fresh", view }, challengeState: { receivedAt: now, paidAt: null } }));
      return view.standing !== "BLOCKED" && d.verdict !== "DENY";
    }), { numRuns: 3000 });
  });

  it("any history followed by 60 quiet days is not BLOCKED", () => {
    fc.assert(fc.property(reports(["a", "b", "c", "d"]), (rs) => replay(ev(rs), 30 * DAY + 60 * DAY, P).standing !== "BLOCKED"), { numRuns: 3000 });
  });

  it("same evidence and now give the same standing, whatever the input order", () => {
    fc.assert(fc.property(reports(["a", "b", "c"]), fc.integer({ min: 0, max: 40 * DAY }), (rs, now) => {
      expect(replay(ev([...rs].reverse()), now, P)).toEqual(replay(ev(rs), now, P));
    }), { numRuns: 2000 });
  });

  it("a latched block lasts its full duration", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 5 * DAY - 2 }), (dt) => {
      const e = ev([report(0, "bad", "a"), report(1, "bad", "b")]);
      return replay(e, 1 + dt, P).standing === "BLOCKED";
    }), { numRuns: 2000 });
  });
});
