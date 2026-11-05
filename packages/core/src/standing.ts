import { REPORTER_BAD_PER_DAY, REPORTER_DAY_SEC, type PolicyParams } from "./params.ts";
import type { Evidence, Report, StandingView, Stats } from "./types.ts";

const VALUE_CAP_USD = 0.05;
const CLUSTER_CAP_USD = 0.5;

export const valueFactor = (a: number) => 0.5 + 0.5 * Math.min(1, a / VALUE_CAP_USD);

interface Obs {
  ts: number;
  side: "good" | "bad";
  cluster: string;
  amountUsd: number;
  weight: number;
}

function sideStats(obs: Obs[], side: Obs["side"], from: number, at: number, windowSec: number, halfLife: number) {
  const perCluster = new Map<string, { count: number; money: number }>();
  for (const o of obs) {
    if (o.side !== side || o.ts < from || o.ts > at || at - o.ts > windowSec) continue;
    const decay = Math.pow(0.5, (at - o.ts) / halfLife);
    const c = perCluster.get(o.cluster) ?? { count: 0, money: 0 };
    // A cluster counts once per side: its strongest report, not the sum.
    c.count = Math.max(c.count, o.weight * valueFactor(o.amountUsd) * decay);
    c.money += o.amountUsd * o.weight * decay;
    perCluster.set(o.cluster, c);
  }
  let count = 0;
  let money = 0;
  for (const c of perCluster.values()) {
    count += c.count;
    money += Math.min(CLUSTER_CAP_USD, c.money);
  }
  return { count, money, clusters: perCluster.size };
}

function stats(obs: Obs[], from: number, at: number, p: PolicyParams, established: boolean): Stats {
  const bad = sideStats(obs, "bad", from, at, p.badWindowSec, p.badHalfLifeSec);
  const good = sideStats(obs, "good", from, at, p.goodWindowSec, p.goodHalfLifeSec);
  const contested = established && good.count >= 3 && good.money >= 5 * bad.money;
  return {
    b: bad.count,
    bScore: contested ? bad.count / 2 : bad.count,
    L: bad.money,
    D: good.money,
    g: good.count,
    badClusters: bad.clusters,
    goodClusters: good.clusters,
  };
}

/** One report per txId, conflicting outcomes cancel, one bad per payer per window (G5). */
export function admissibleReports(reports: Report[], now: number, p: PolicyParams): Report[] {
  const byTx = new Map<string, Report[]>();
  for (const r of reports) {
    if (r.ts > now) continue; // future-dated entities are ignored (F15)
    byTx.set(r.txId, [...(byTx.get(r.txId) ?? []), r]);
  }
  const single: Report[] = [];
  for (const list of byTx.values()) {
    if (new Set(list.map((r) => r.outcome)).size === 1) single.push(list[0]!);
  }
  single.sort((a, b) => a.ts - b.ts || a.txId.localeCompare(b.txId));
  // The 5-a-day limit across payees is reporterExcess: it needs the reporter's history, which the reader fetches.
  const lastBad = new Map<string, number>();
  return single.filter((r) => {
    if (r.outcome !== "bad") return true;
    const last = lastBad.get(r.payer);
    if (last !== undefined && r.ts - last < p.badPerPayeeWindowSec) return false;
    lastBad.set(r.payer, r.ts);
    return true;
  });
}

/**
 * G5 across payees: which of one reporter's bad reports fall beyond the daily limit. Takes verified rows only, so
 * forged rows naming a victim's wallet cannot use up its allowance. A repeat on the same payee is already dropped
 * by the per-payee rule, so it does not count here either.
 */
export function reporterExcess(rows: { txId: string; ts: number; payee: string }[], badPerPayeeWindowSec: number): Set<string> {
  const kept: { ts: number; payee: string }[] = [];
  const excess = new Set<string>();
  for (const r of [...rows].sort((a, b) => a.ts - b.ts || a.txId.localeCompare(b.txId))) {
    if (kept.some((k) => k.payee === r.payee && r.ts - k.ts < badPerPayeeWindowSec)) continue;
    if (kept.filter((k) => r.ts - k.ts < REPORTER_DAY_SEC).length >= REPORTER_BAD_PER_DAY) excess.add(r.txId);
    else kept.push(r);
  }
  return excess;
}

interface State {
  standing: StandingView["standing"];
  episodes: number[];
  blockStart: number;
  blockEnd: number;
  earlyExitAt: number | null;
  rebuttalUsed: boolean;
  awaitingProbe: boolean;
  scopeFrom: number;
  probationStart: number | null;
  probationBad: Set<string>;
  lastProbationBad: number | null;
  holdUntil: number | null;
  obs: Obs[];
}

const strikesAt = (s: State, at: number, p: PolicyParams) =>
  s.episodes.filter((e) => e <= at && at - e <= p.strikeMemorySec).length;

/** How long a block lasts at this strike. Strikes past the end of the list use the last value. */
export const blockLength = (strike: number, p: PolicyParams) => p.blockSec[Math.min(strike, p.blockSec.length) - 1]!;

function startBlock(s: State, ts: number, p: PolicyParams) {
  s.episodes.push(ts);
  s.standing = "BLOCKED";
  s.blockStart = ts;
  s.blockEnd = ts + blockLength(strikesAt(s, ts, p), p);
  s.earlyExitAt = null;
  s.rebuttalUsed = false;
  s.awaitingProbe = false;
  s.holdUntil = null;
  s.probationStart = null;
  s.probationBad = new Set();
  s.lastProbationBad = null;
}

const goodInScope = (s: State, at: number, p: PolicyParams) =>
  s.obs.filter((o) => o.side === "good" && o.ts >= s.scopeFrom && o.ts <= at && at - o.ts <= p.goodWindowSec);

function canBecomeEstablished(s: State, at: number, p: PolicyParams) {
  const st = stats(s.obs, s.scopeFrom, at, p, false);
  const firstGood = Math.min(Infinity, ...goodInScope(s, at, p).map((o) => o.ts));
  return st.goodClusters >= 3 && st.D >= 0.1 && st.b < 0.5 && at - firstGood >= p.firstGoodAgeSec && strikesAt(s, at, p) === 0;
}

function canRecover(s: State, at: number, minSec: number, p: PolicyParams) {
  const st = stats(s.obs, s.scopeFrom, at, p, false);
  return s.probationBad.size === 0 && st.goodClusters >= 3 && st.D >= 0.15 && at - s.probationStart! >= minSec;
}

/**
 * Applies every time-driven transition up to `t`, in order. A waiting period ends at a moment of its own, usually
 * between events, and evidence decays after it. So promotion is judged at that moment as well as at `t`: otherwise
 * a merchant that earned its standing would lose it just for being read late.
 */
function advance(s: State, t: number, p: PolicyParams) {
  if (s.standing === "BLOCKED") {
    const end = Math.min(s.blockEnd, s.earlyExitAt ?? Infinity);
    if (end > t) return;
    s.standing = "PROBATION";
    s.probationStart = end;
    s.scopeFrom = end; // evidence from before probation does not count
  }
  if (s.standing === "PROBATION") {
    const minSec = p.probationMinUnitSec * Math.min(Math.max(strikesAt(s, t, p), 1), 3);
    const ready = s.probationStart! + minSec;
    if ((ready <= t && canRecover(s, ready, minSec, p)) || canRecover(s, t, minSec, p)) {
      s.standing = "ESTABLISHED";
      s.probationStart = null;
    } else if (t - (s.lastProbationBad ?? s.probationStart!) >= p.probationToNewSec) {
      s.standing = "NEW";
      s.probationStart = null;
      s.holdUntil = null;
    } else {
      return;
    }
  }
  if (s.standing === "NEW") {
    const firstGood = Math.min(Infinity, ...s.obs.filter((o) => o.side === "good" && o.ts >= s.scopeFrom).map((o) => o.ts));
    const ripe = firstGood + p.firstGoodAgeSec;
    if ((ripe <= t && canBecomeEstablished(s, ripe, p)) || canBecomeEstablished(s, t, p)) s.standing = "ESTABLISHED";
  }
  if (s.standing === "ESTABLISHED") {
    const st = stats(s.obs, s.scopeFrom, t, p, true);
    if (st.goodClusters === 0 && st.badClusters === 0) s.standing = "NEW";
  }
}

function applyBad(s: State, cluster: string, ts: number, p: PolicyParams) {
  if (s.standing === "PROBATION") {
    s.probationBad.add(cluster);
    s.lastProbationBad = ts;
    if (s.probationBad.size >= 2) startBlock(s, ts, p);
    // A hold that already ran out does not cover a new bad report.
    else if (s.holdUntil === null || s.holdUntil <= ts) s.holdUntil = ts + p.holdSec;
  } else if (s.standing !== "BLOCKED") {
    const st = stats(s.obs, s.scopeFrom, ts, p, s.standing === "ESTABLISHED");
    const contested = s.standing === "ESTABLISHED" && st.g >= 3 && st.D >= 5 * st.L;
    if (st.badClusters >= (contested ? 3 : 2) && st.bScore >= 1) startBlock(s, ts, p); // bScore is b after G4 halving
  }
}

/**
 * Standing is a replay of evidence in consensus order. A block latches when it
 * triggers, so it runs its full duration even after b decays below 1.
 */
export function replay(evidence: Evidence, now: number, p: PolicyParams): StandingView {
  type Ev =
    | { ts: number; order: number; id: string; kind: "report"; side: "good" | "bad"; cluster: string; amountUsd: number; weight: number }
    | { ts: number; order: number; id: string; kind: "probe"; pass: boolean; cluster: string; amountUsd: number }
    | { ts: number; order: number; id: string; kind: "rebuttal" };
  const events: Ev[] = [
    ...admissibleReports(evidence.reports, now, p).map((r): Ev => ({
      ts: r.ts, order: 1, id: r.txId, kind: "report", side: r.outcome, cluster: r.cluster, amountUsd: r.amountUsd,
      weight: r.ts - r.payerCreatedTs < p.youngAccountSec ? 0.5 : 1,
    })),
    ...evidence.probes.filter((x) => x.ts <= now).map((x): Ev => ({
      ts: x.ts, order: 2, id: x.txId, kind: "probe", pass: x.result === "pass", cluster: x.cluster, amountUsd: x.amountUsd,
    })),
    ...evidence.rebuttals.filter((x) => x.ts <= now).map((x): Ev => ({ ts: x.ts, order: 0, id: String(x.ts), kind: "rebuttal" })),
  ];
  events.sort((a, b) => a.ts - b.ts || a.order - b.order || a.id.localeCompare(b.id));

  const s: State = {
    standing: "NEW", episodes: [], blockStart: 0, blockEnd: 0, earlyExitAt: null, rebuttalUsed: false, awaitingProbe: false,
    scopeFrom: -Infinity, probationStart: null, probationBad: new Set(), lastProbationBad: null, holdUntil: null, obs: [],
  };

  for (const e of events) {
    advance(s, e.ts, p);
    if (e.kind === "rebuttal") {
      if (s.standing === "BLOCKED" && !s.rebuttalUsed) {
        s.rebuttalUsed = true;
        s.awaitingProbe = true;
      }
    } else if (e.kind === "probe") {
      if (s.standing === "BLOCKED") {
        if (s.awaitingProbe) {
          s.awaitingProbe = false;
          if (e.pass) s.earlyExitAt = Math.max(e.ts, s.blockStart + p.rebuttalCooldownSec);
        }
      } else {
        const side = e.pass ? "good" : "bad";
        s.obs.push({ ts: e.ts, side, cluster: e.cluster, amountUsd: e.amountUsd, weight: 1 });
        if (side === "bad") applyBad(s, e.cluster, e.ts, p);
      }
    } else if (s.standing !== "BLOCKED") {
      s.obs.push({ ts: e.ts, side: e.side, cluster: e.cluster, amountUsd: e.amountUsd, weight: e.weight });
      if (e.side === "bad") applyBad(s, e.cluster, e.ts, p);
    }
    advance(s, e.ts, p); // this event may be the one that completes a transition
  }
  advance(s, now, p);

  const st = stats(s.obs, s.scopeFrom, now, p, s.standing === "ESTABLISHED");
  return {
    ...st,
    standing: s.standing,
    strikes: strikesAt(s, now, p),
    blockStart: s.standing === "BLOCKED" ? s.blockStart : null,
    blockEnd: s.standing === "BLOCKED" ? Math.min(s.blockEnd, s.earlyExitAt ?? Infinity) : null,
    probationStart: s.probationStart,
    holdUntil: s.holdUntil !== null && s.holdUntil > now ? s.holdUntil : null,
    rebuttalUsed: s.rebuttalUsed,
    computedAt: now,
  };
}
