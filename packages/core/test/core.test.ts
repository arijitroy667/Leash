import { describe, expect, it } from "vitest";
import fc from "fast-check";
import fixtures from "./fixtures.json" with { type: "json" };
import {
  DEFAULT_LIMITS, PROFILES, REASON_CODES, autoLimit, blockLength, challengeHash, decide, liveProfile, policySummary, replay, reporterExcess, riskScore,
  type Challenge, type Declaration, type DecideInput, type Evidence, type ReasonCode, type Report, type Standing, type StandingView,
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
  standing: "NEW", strikes: 0, blockStart: null, blockEnd: null, probationStart: null, holdUntil: null, rebuttalUsed: false, computedAt: 0,
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
    expect(replay(ev(first), 6, L).blockEnd).toBe(65);
    expect(replay(ev(first), 65, L).standing).toBe("PROBATION");
    // agent A again, 100 s after its first bad report: not rate limited in live
    const again = [...first, report(100, "bad", "a")];
    const held = replay(ev(again), 101, L);
    expect(held.holdUntil).toBe(154);
    const blocked = replay(ev([...again, report(120, "bad", "b")]), 121, L);
    expect(blocked.standing).toBe("BLOCKED");
    expect(blocked.strikes).toBe(2);
    expect(blocked.blockEnd).toBe(240);
  });
});

// FR-09: every transition in PRD section 10, in both policy profiles.
describe.each([["production", P], ["live", L]] as const)("standing transitions, %s profile", (_name, p) => {
  const pair = [report(0, "bad", "a"), report(1, "bad", "b")];
  const duration = (strike: number) => blockLength(strike, p);
  const entry = 1 + duration(1);
  const goods = (at: number, amount = 0.1, names = ["x", "y", "z"]) => names.map((c, n) => report(at + n + 1, "good", c, amount));

  it("NEW to BLOCKED needs two independent clusters and b of 1", () => {
    expect(replay(ev([report(0, "bad", "a")]), 1, p).standing).toBe("NEW");
    const v = replay(ev(pair), 2, p);
    expect(v).toMatchObject({ standing: "BLOCKED", strikes: 1, blockStart: 1, blockEnd: entry, rebuttalUsed: false });
  });

  it("one funding cluster with many wallets counts once", () => {
    const sameCluster = [{ ...report(0, "bad", "f"), payer: "w1", txId: "t1" }, { ...report(1, "bad", "f"), payer: "w2", txId: "t2" }, { ...report(2, "bad", "f"), payer: "w3", txId: "t3" }];
    expect(replay(ev(sameCluster), 3, p)).toMatchObject({ standing: "NEW", badClusters: 1 });
  });

  it("ESTABLISHED to BLOCKED takes two clusters when not contested, three when contested", () => {
    const at = DAY + 10;
    const thin = goods(0, 0.05);
    expect(replay(ev(thin), at, p).standing).toBe("ESTABLISHED");
    const two = [report(at, "bad", "a", 0.05), report(at + 1, "bad", "b", 0.05)];
    expect(replay(ev([...thin, ...two]), at + 2, p).standing).toBe("BLOCKED");
    const strong = goods(0, 0.2, ["x", "y", "z", "w"]);
    expect(replay(ev([...strong, ...two]), at + 2, p).standing).toBe("ESTABLISHED");
    expect(replay(ev([...strong, ...two, report(at + 2, "bad", "c", 0.05)]), at + 3, p).standing).toBe("BLOCKED");
  });

  it("G4: a contested merchant takes half weight, so three dust reports do not block it", () => {
    const at = DAY + 10;
    const strong = goods(0, 0.2, ["x", "y", "z", "w"]);
    const dust = ["a", "b", "c"].map((c, n) => report(at + n, "bad", c, 0.005));
    const v = replay(ev([...strong, ...dust]), at + 3, p);
    expect(v.standing).toBe("ESTABLISHED");
    expect(v.bScore).toBeCloseTo(v.b / 2, 5);
  });

  it("a block runs its full duration, then always PROBATION", () => {
    expect(replay(ev(pair), entry - 1, p).standing).toBe("BLOCKED");
    const v = replay(ev(pair), entry, p);
    expect(v).toMatchObject({ standing: "PROBATION", probationStart: entry, strikes: 1, blockEnd: null, blockStart: null });
    expect(v.b).toBe(0);
  });

  it("reports filed during a block change nothing", () => {
    const during = [...pair, report(5, "good", "x", 1), report(6, "good", "y", 1), report(7, "good", "z", 1)];
    expect(replay(ev(during), entry - 1, p)).toMatchObject({ standing: "BLOCKED", g: 0 });
    expect(replay(ev(during), entry, p).goodClusters).toBe(0);
  });

  it("each strike takes the next block length, and it stops at the last", () => {
    let reports = [...pair];
    let blockEnd = entry;
    for (const strike of [2, 3, 4]) {
      const blockAt = blockEnd + 2;
      reports = [...reports, report(blockEnd + 1, "bad", "a"), report(blockAt, "bad", "b")];
      const v = replay(ev(reports), blockAt + 1, p);
      expect(v.strikes).toBe(strike);
      expect(v.blockEnd).toBe(blockAt + duration(strike));
      blockEnd = blockAt + duration(strike);
    }
    expect(duration(4)).toBe(duration(3));
    expect(p.blockSec.at(-1)).toBe(duration(3));
  });

  it("PROBATION to hold on one bad cluster, and back when the hold ends", () => {
    const one = [...pair, report(entry + 10, "bad", "a")];
    expect(replay(ev(one), entry + 11, p)).toMatchObject({ standing: "PROBATION", holdUntil: entry + 10 + p.holdSec });
    expect(replay(ev(one), entry + 10 + p.holdSec, p)).toMatchObject({ standing: "PROBATION", holdUntil: null });
  });

  it("a new bad report after a hold ended starts a new hold", () => {
    const at = entry + 10 + p.holdSec + 1;
    const again = [...pair, report(entry + 10, "bad", "a"), report(at, "bad", "a")];
    expect(replay(ev(again), at + 1, p)).toMatchObject({ standing: "PROBATION", holdUntil: at + p.holdSec });
  });

  it("PROBATION or hold to BLOCKED on a second bad cluster, with strike plus 1", () => {
    const v = replay(ev([...pair, report(entry + 10, "bad", "a"), report(entry + 20, "bad", "b")]), entry + 21, p);
    expect(v).toMatchObject({ standing: "BLOCKED", strikes: 2, blockEnd: entry + 20 + duration(2), rebuttalUsed: false, holdUntil: null });
  });

  it("PROBATION to ESTABLISHED needs 3 clusters, delivered value, zero bad and the minimum time", () => {
    const min = p.probationMinUnitSec;
    const g = goods(entry);
    expect(replay(ev([...pair, ...g]), entry + min - 1, p).standing).toBe("PROBATION");
    expect(replay(ev([...pair, ...g]), entry + min, p).standing).toBe("ESTABLISHED");
    expect(replay(ev([...pair, ...goods(entry, 0.03)]), entry + min, p).standing).toBe("PROBATION"); // D under 0.15
    expect(replay(ev([...pair, ...goods(entry, 0.1, ["x", "y"])]), entry + min, p).standing).toBe("PROBATION"); // 2 clusters
    expect(replay(ev([...pair, ...g, report(entry + 5, "bad", "a")]), entry + min, p).standing).toBe("PROBATION"); // a bad report
  });

  it("evidence from before probation does not count toward recovery", () => {
    const before = goods(-100, 1);
    expect(replay(ev([...before, ...pair]), entry + p.probationMinUnitSec, p)).toMatchObject({ standing: "PROBATION", goodClusters: 0, D: 0 });
  });

  it("the prober counts as at most one cluster toward recovery", () => {
    const passes = [1, 2, 3].map((n) => ({ txId: `p${n}`, ts: entry + n, result: "pass" as const, cluster: "prober", amountUsd: 0.1 }));
    const one = goods(entry + 10, 0.1, ["x"]);
    expect(replay(ev([...pair, ...one], { probes: passes }), entry + p.probationMinUnitSec + 20, p).standing).toBe("PROBATION");
    const two = goods(entry + 10, 0.1, ["x", "y"]);
    expect(replay(ev([...pair, ...two], { probes: passes }), entry + p.probationMinUnitSec + 20, p).standing).toBe("ESTABLISHED");
  });

  it("a failed probe during probation is a bad cluster, so it starts a hold", () => {
    const failed = [{ txId: "p", ts: entry + 5, result: "fail" as const, cluster: "prober", amountUsd: 0.01 }];
    expect(replay(ev(pair, { probes: failed }), entry + 6, p)).toMatchObject({ standing: "PROBATION", holdUntil: entry + 5 + p.holdSec });
  });

  it("PROBATION to NEW after the quiet period, never ESTABLISHED by waiting", () => {
    expect(replay(ev(pair), entry + p.probationToNewSec - 1, p).standing).toBe("PROBATION");
    expect(replay(ev(pair), entry + p.probationToNewSec, p).standing).toBe("NEW");
  });

  it("NEW to ESTABLISHED needs 3 clusters, delivered value, low b, 24 hours, and no strikes", () => {
    const g = goods(0, 0.05);
    expect(replay(ev(g), p.firstGoodAgeSec, p).standing).toBe("NEW");
    expect(replay(ev(g), p.firstGoodAgeSec + 2, p).standing).toBe("ESTABLISHED");
    expect(replay(ev(goods(0, 0.01)), p.firstGoodAgeSec + 2, p).standing).toBe("NEW"); // D under 0.10
  });

  it("ESTABLISHED to NEW when its good evidence leaves the window, and not just because it is read late", () => {
    const g = goods(0, 0.05);
    expect(replay(ev(g), p.firstGoodAgeSec + 2, p).standing).toBe("ESTABLISHED");
    expect(replay(ev(g), 15 * DAY, p).standing).toBe("ESTABLISHED"); // D has decayed below the promotion bar by now
    expect(replay(ev(g), p.goodWindowSec, p).standing).toBe("ESTABLISHED");
    expect(replay(ev(g), p.goodWindowSec + 10, p).standing).toBe("NEW");
  });

  it("a late report that completes the criteria promotes at its own time", () => {
    const g = [report(0, "good", "x", 0.05), report(2 * DAY, "good", "y", 0.05), report(3 * DAY, "good", "z", 0.05)];
    expect(replay(ev(g), 3 * DAY - 1, p).standing).toBe("NEW");
    expect(replay(ev(g), 20 * DAY, p).standing).toBe("ESTABLISHED");
  });

  it("recovery is not lost by being read late either", () => {
    const g = goods(entry);
    expect(replay(ev([...pair, ...g]), entry + p.probationMinUnitSec + 15 * DAY, p).standing).toBe("ESTABLISHED");
  });

  it("strikes are forgotten after their memory runs out", () => {
    expect(replay(ev(pair), 1 + p.strikeMemorySec, p).strikes).toBe(1);
    expect(replay(ev(pair), 2 + p.strikeMemorySec, p).strikes).toBe(0);
  });

  it("a rebuttal alone never unblocks, and only one counts per episode", () => {
    const failed = ev(pair, {
      rebuttals: [{ ts: 2 }, { ts: 4 }],
      probes: [{ txId: "p1", ts: 3, result: "fail", cluster: "prober", amountUsd: 0.01 }, { txId: "p2", ts: 5, result: "pass", cluster: "prober", amountUsd: 0.01 }],
    });
    expect(replay(ev(pair, { rebuttals: [{ ts: 2 }] }), entry - 1, p)).toMatchObject({ standing: "BLOCKED", rebuttalUsed: true });
    expect(replay(failed, entry - 1, p).standing).toBe("BLOCKED");
  });

  it("a probe with no rebuttal does nothing during a block", () => {
    const probes = [{ txId: "p", ts: 3, result: "pass" as const, cluster: "prober", amountUsd: 0.01 }];
    expect(replay(ev(pair, { probes }), entry - 1, p).standing).toBe("BLOCKED");
  });

  it("a passing probe reaches PROBATION early, but not before the cooldown", () => {
    const e = ev(pair, { rebuttals: [{ ts: 2 }], probes: [{ txId: "p", ts: 3, result: "pass", cluster: "prober", amountUsd: 0.01 }] });
    expect(replay(e, p.rebuttalCooldownSec, p).standing).toBe("BLOCKED");
    expect(replay(e, 1 + p.rebuttalCooldownSec, p)).toMatchObject({ standing: "PROBATION", probationStart: 1 + p.rebuttalCooldownSec });
  });

  it("a second block starts with its own rebuttal", () => {
    const again = [...pair, report(entry + 10, "bad", "a"), report(entry + 20, "bad", "b")];
    expect(replay(ev(again, { rebuttals: [{ ts: 2 }] }), entry + 21, p).rebuttalUsed).toBe(false);
  });
});

describe("strikes keep a merchant out of ESTABLISHED until they expire", () => {
  it("waiting reaches NEW, then good evidence only promotes once the strikes are gone", () => {
    const pair = [report(0, "bad", "a"), report(1, "bad", "b")];
    const goods = ["x", "y", "z"].map((c, n) => report(45 * DAY + n, "good", c, 0.2));
    expect(replay(ev([...pair, ...goods]), 50 * DAY, P)).toMatchObject({ standing: "NEW", strikes: 1 });
    expect(replay(ev([...pair, ...goods]), 62 * DAY, P)).toMatchObject({ standing: "ESTABLISHED", strikes: 0 });
  });
});

describe("G5: at most 5 bad reports a day from one reporter, across payees", () => {
  const row = (n: number, ts: number, payee = `0.0.${n}`) => ({ txId: `t${n}`, ts, payee });
  it("the sixth in a rolling day is excess, and later ones count again", () => {
    const six = [1, 2, 3, 4, 5, 6].map((n) => row(n, n * 100));
    expect([...reporterExcess(six, 86400)]).toEqual(["t6"]);
    expect([...reporterExcess([...six.slice(0, 5), row(6, 100 + 86400)], 86400)]).toEqual([]);
  });
  it("a repeat on the same payee is dropped by the per-payee rule, so it does not use up the allowance", () => {
    const repeats = [row(1, 10, "p"), row(2, 20, "p"), row(3, 30, "p"), row(4, 40, "q"), row(5, 50, "r"), row(6, 60, "s"), row(7, 70, "t")];
    expect([...reporterExcess(repeats, 86400)]).toEqual([]);
  });
  it("gives the same answer in any input order", () => {
    const six = [1, 2, 3, 4, 5, 6].map((n) => row(n, n * 100));
    expect([...reporterExcess([...six].reverse(), 86400)]).toEqual(["t6"]);
  });
});

describe("the configurable live clock", () => {
  const pair = [report(0, "bad", "a"), report(1, "bad", "b")];

  it("defaults to blocks of 1, 2 and 5 minutes, with the PRD's other live durations", () => {
    expect(L).toMatchObject({ name: "live", policyDaySec: 18, blockSec: [60, 120, 300], holdSec: 54, rebuttalCooldownSec: 18, probationMinUnitSec: 54, strikeMemorySec: 1080, reportTtlSec: 1080, standingFreshSec: 5 });
  });
  it("leaves production at the PRD's 5, 10 and 20 days", () => {
    expect(P.blockSec).toEqual([5 * DAY, 10 * DAY, 20 * DAY]);
    expect(P).toMatchObject({ holdSec: 3 * DAY, rebuttalCooldownSec: DAY, strikeMemorySec: 60 * DAY, reportTtlSec: 60 * DAY });
  });
  it("uses the configured block at each strike, then the last one", () => {
    const p = liveProfile(18, [70, 200]);
    expect(replay(ev(pair), 2, p).blockEnd).toBe(71);
    let reports = [...pair];
    let end = 71;
    for (const length of [200, 200]) {
      reports = [...reports, report(end + 1, "bad", "a"), report(end + 2, "bad", "b")];
      expect(replay(ev(reports), end + 3, p).blockEnd).toBe(end + 2 + length);
      end = end + 2 + length;
    }
  });
  it("the policy day sets the hold, cooldown, probation minimum and report window", () => {
    expect(liveProfile(10, [60])).toMatchObject({ policyDaySec: 10, holdSec: 30, rebuttalCooldownSec: 10, probationMinUnitSec: 30, badPerPayeeWindowSec: 10, strikeMemorySec: 600, reportTtlSec: 600 });
  });
  it("evidence always outlives a chain of blocks, or a block would end when its reports expire", () => {
    const p = liveProfile(5, [600, 1200, 1800]);
    expect(p.reportTtlSec).toBe(7200);
    expect(p.strikeMemorySec).toBe(7200);
  });
  it("does not shorten what the PRD says stays real", () => {
    for (const p of [L, liveProfile(5, [30])]) {
      expect(p).toMatchObject({ badHalfLifeSec: P.badHalfLifeSec, badWindowSec: P.badWindowSec, goodHalfLifeSec: P.goodHalfLifeSec, goodWindowSec: P.goodWindowSec, youngAccountSec: P.youngAccountSec, firstGoodAgeSec: P.firstGoodAgeSec });
    }
  });
  it.each([
    ["a zero day", 0, [60]],
    ["a negative day", -1, [60]],
    ["a day that is not a number", NaN, [60]],
    ["no blocks", 18, []],
    ["a zero block", 18, [60, 0]],
    ["a block that is not a number", 18, [60, NaN]],
    ["blocks that shrink", 18, [300, 60]],
    ["a first block no longer than a day", 60, [60, 120]],
  ] as const)("refuses %s", (_name, day, blocks) => {
    expect(() => liveProfile(day, [...blocks])).toThrow(RangeError);
  });
  it("describes the values actually in use", () => {
    expect(policySummary(L)).toBe("1 policy day = 18 real seconds. Blocks last 1 min, 2 min, then 5 min.");
    expect(policySummary(liveProfile(10, [90]))).toBe("1 policy day = 10 real seconds. Blocks last 90 s.");
  });
});

describe("decide", () => {
  const reason = (o: Partial<DecideInput>) => decide(input(o));

  it("risk band: R of 70 or more denies with two bad clusters, and one cluster can only escalate", () => {
    const risky = (badClusters: number) => viewOf({ standing: "NEW", b: 1, bScore: 1, L: 0.5, badClusters, computedAt: 1000 });
    const two = reason({ challenge: challenge(0.05), registry: { status: "fresh", view: risky(2) } });
    expect(two.score).toBeGreaterThanOrEqual(70);
    expect(two.verdict).toBe("DENY");
    expect(two.reasons).toContain("risk-band");
    const one = reason({ challenge: challenge(0.05), registry: { status: "fresh", view: risky(1) } });
    expect(one.score).toBeGreaterThanOrEqual(70);
    expect(one.verdict).toBe("ESCALATE");
  });
  it("a merchant moves from UNKNOWN to NEW by declaring in ENS", () => {
    expect(reason({ claim: null, declaration: { status: "none" } }).standing).toBe("UNKNOWN");
    expect(reason({}).standing).toBe("NEW");
  });
  it("a merchant that has only a reporter's word is not blocked: settlement unknown escalates, owner block denies", () => {
    const unknown = reason({ settlementUnknown: true });
    expect(unknown.verdict).toBe("ESCALATE");
    expect(unknown.reasons).toContain("settlement-unknown");
    const local = reason({ locallyBlocked: true });
    expect(local.verdict).toBe("DENY");
    expect(local.reasons).toContain("locally-blocked");
  });
  it("an amount above the declared maximum denies on a fresh declaration, escalates on a stale one", () => {
    const value = { ...decl, maxPriceUsd: 0.001 };
    expect(reason({ declaration: { status: "fresh", value } }).verdict).toBe("DENY");
    const stale = reason({ declaration: { status: "stale", value, fetchedAt: 900 } });
    expect(stale.verdict).toBe("ESCALATE");
    expect(stale.reasons).toContain("declared-stale-mismatch");
  });
  it("a stale NEW view is not usable, a stale PROBATION view is", () => {
    const stale = (standing: StandingView["standing"]) => reason({ registry: { status: "stale", view: viewOf({ standing, strikes: 1, computedAt: 900 }) } });
    expect(stale("NEW").reasons).toContain("registry-unavailable");
    expect(stale("PROBATION").reasons).not.toContain("registry-unavailable");
  });

  it("happy path S2", () => {
    const d = reason({});
    expect(d.verdict).toBe("ALLOW");
    expect(d.score).toBeCloseTo(27.5, 1);
    expect(d.reasons).toEqual([]);
  });
  it("ceiling", () => expect(reason({ challenge: challenge(1.5) }).reasons).toContain("ceiling-exceeded"));
  it("an amount that is not a number is refused, never allowed", () => {
    const d = reason({ challenge: challenge(Number.NaN) });
    expect(d.verdict).toBe("DENY");
    expect(d.reasons).toContain("ceiling-exceeded");
  });
  it("every reason code has a case that produces it", () => {
    const led = (o: Partial<DecideInput["ledger"]>) => ({ merchantSpent24h: 0, sessionSpent: 0, dailySpent: 0, newIdentitySpentToday: 0, recentPrices: [] as number[], ...o });
    const probation = viewOf({ standing: "PROBATION", strikes: 1, D: 1, g: 5, computedAt: 1000, probationStart: 1 });
    const cases: Record<ReasonCode, Partial<DecideInput>> = {
      "ceiling-exceeded": { challenge: challenge(1.5) },
      "declared-mismatch": { challenge: challenge(0.005, { payTo: "0.0.999" }) },
      "over-declared-max": { declaration: { status: "fresh", value: { ...decl, maxPriceUsd: 0.001 } } },
      replay: { challengeState: { receivedAt: 1000, paidAt: 900 } },
      "stale-challenge": { challengeState: { receivedAt: 900, paidAt: null } },
      blocked: { registry: { status: "fresh", view: viewOf({ standing: "BLOCKED", blockEnd: 5000, computedAt: 1000 }) } },
      "merchant-cap-hard": { ledger: led({ merchantSpent24h: 0.25 }) },
      "budget-exceeded": { ledger: led({ sessionSpent: 2 }) },
      "escalation-rate-limit": { escalationsLastHour: 10, challenge: challenge(0.05) },
      "risk-band": { challenge: challenge(0.05), registry: { status: "fresh", view: viewOf({ b: 1, bScore: 1, L: 0.5, badClusters: 2, computedAt: 1000 }) } },
      "unsupported-asset": { challenge: challenge(0.005, { asset: "0.0.1" }) },
      "unknown-merchant": { claim: null, declaration: { status: "none" } },
      "unknown-origin": { realOrigin: null },
      "limit-exceeded": { challenge: challenge(0.05) },
      "merchant-cap": { ledger: led({ merchantSpent24h: 0.05 }) },
      "new-identity-budget": { ledger: led({ newIdentitySpentToday: 0.1 }) },
      "price-drift": { ledger: led({ recentPrices: [0.001, 0.001] }) },
      "probation-limit": { challenge: challenge(0.2), registry: { status: "fresh", view: probation } },
      "probation-hold": { registry: { status: "fresh", view: { ...probation, holdUntil: 2000 } } },
      "registry-unavailable": { registry: { status: "none" } },
      "declared-stale-mismatch": { declaration: { status: "stale", value: { ...decl, payTo: "0.0.1" }, fetchedAt: 900 } },
      "unverified-reports": { unverifiedEvidence: true },
      "safe-mode": { safeMode: true },
      "settlement-unknown": { settlementUnknown: true },
      "locally-blocked": { locallyBlocked: true },
      "malformed-challenge": { malformedChallenge: true },
    };
    expect(Object.keys(cases).sort()).toEqual([...REASON_CODES].sort());
    for (const [code, o] of Object.entries(cases)) expect(reason(o).reasons, code).toContain(code);
  });
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
    it("evidence Mirror could not check escalates, even where the score alone would allow, and never denies", () => {
      const d = reason({ unverifiedEvidence: true });
      expect(reason({}).verdict).toBe("ALLOW");
      expect(d.verdict).toBe("ESCALATE");
      expect(d.reasons).toEqual(["unverified-reports"]);
      expect(d.degraded?.dependency).toBe("mirror");
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
    }), n);
  }, 300_000);

  it("any history followed by 60 quiet days is not BLOCKED", () => {
    fc.assert(fc.property(reports(["a", "b", "c", "d"]), (rs) => replay(ev(rs), 30 * DAY + 60 * DAY, P).standing !== "BLOCKED"), n);
  }, 300_000);

  it("same evidence and now give the same standing, whatever the input order", () => {
    fc.assert(fc.property(reports(["a", "b", "c"]), fc.integer({ min: 0, max: 40 * DAY }), (rs, now) => {
      expect(replay(ev([...rs].reverse()), now, P)).toEqual(replay(ev(rs), now, P));
    }), n);
  }, 300_000);

  it("a latched block lasts its full duration", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 5 * DAY - 2 }), (dt) => {
      const e = ev([report(0, "bad", "a"), report(1, "bad", "b")]);
      return replay(e, 1 + dt, P).standing === "BLOCKED";
    }), n);
  }, 300_000);

  it("the verdict is the most restrictive gate, whatever combination fires", () => {
    const DENY_ONLY = new Set(["ceiling-exceeded", "unsupported-asset", "declared-mismatch", "over-declared-max", "replay", "stale-challenge", "blocked", "merchant-cap-hard", "budget-exceeded", "escalation-rate-limit", "locally-blocked", "malformed-challenge"]);
    const gates = fc.record({
      A: fc.double({ min: 0.001, max: 2, noNaN: true }),
      spoof: fc.boolean(), badAsset: fc.boolean(), replayed: fc.boolean(), stale: fc.boolean(), noClaim: fc.boolean(), noOrigin: fc.boolean(), registryDown: fc.boolean(),
      blocked: fc.boolean(), safeMode: fc.boolean(), unknownSettlement: fc.boolean(), localBlock: fc.boolean(), spent: fc.double({ min: 0, max: 3, noNaN: true }), escalations: fc.integer({ min: 0, max: 12 }), unverified: fc.boolean(), malformed: fc.boolean(),
    });
    fc.assert(fc.property(gates, (g) => {
      const view = viewOf({ standing: g.blocked ? "BLOCKED" : "NEW", blockEnd: g.blocked ? 5000 : null, computedAt: 1000 });
      const i = input({
        challenge: challenge(g.A, { payTo: g.spoof ? "0.0.999" : "0.0.100", asset: g.badAsset ? "0.0.1" : USDC }),
        claim: g.noClaim ? null : "m.eth",
        declaration: g.noClaim ? { status: "none" } : { status: "fresh", value: decl },
        realOrigin: g.noOrigin ? null : "https://m.example",
        registry: g.registryDown ? { status: "none" } : { status: "fresh", view },
        ledger: { merchantSpent24h: g.spent, sessionSpent: g.spent, dailySpent: g.spent, newIdentitySpentToday: g.spent, recentPrices: [] },
        challengeState: { receivedAt: g.stale ? 900 : 1000, paidAt: g.replayed ? 990 : null },
        escalationsLastHour: g.escalations, unverifiedEvidence: g.unverified, malformedChallenge: g.malformed, safeMode: g.safeMode, settlementUnknown: g.unknownSettlement, locallyBlocked: g.localBlock,
      });
      const d = decide(i);
      expect(decide(i)).toEqual(d);
      if (d.reasons.some((r) => DENY_ONLY.has(r))) expect(d.verdict).toBe("DENY");
      if (d.reasons.length === 0) expect(d.verdict).toBe("ALLOW");
      else expect(d.verdict).not.toBe("ALLOW");
      // An outage, unchecked evidence or no declaration is never a silent ALLOW (NFR-03)
      if (g.safeMode || g.registryDown || g.noClaim || g.unverified) expect(d.verdict).not.toBe("ALLOW");
    }), n);
  }, 300_000);
});
