import { createHash } from "node:crypto";
import { challengeHash } from "./challenge.ts";
import { HARD_CAP_MULTIPLE, SOFT_CAPS, type PolicyParams } from "./params.ts";
import { autoLimit, riskScore } from "./score.ts";
import type { Challenge, Decision, Declaration, Limits, ReasonCode, Standing, StandingView, Verdict } from "./types.ts";

export interface DecideInput {
  now: number;
  challenge: Challenge;
  /** Origin of the real request. null when the call did not pass through guardedFetch. */
  realOrigin: string | null;
  /** The ENS name the merchant claims, if any. */
  claim: string | null;
  declaration: { status: "fresh" | "stale" | "none"; value?: Declaration; fetchedAt?: number; outage?: boolean };
  registry: { status: "fresh" | "stale" | "none"; view?: StandingView };
  ledger: { merchantSpent24h: number; sessionSpent: number; dailySpent: number; newIdentitySpentToday: number; recentPrices: number[] };
  challengeState: { receivedAt: number; paidAt: number | null };
  idempotent?: boolean;
  escalationsLastHour: number;
  unverifiedBadClusters?: number;
  safeMode?: boolean;
  familyTaint?: boolean;
  limits: Limits;
  params: PolicyParams;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function decide(i: DecideInput): Decision {
  const { challenge: c, now, limits, params: p } = i;
  const hash = challengeHash(c);
  const deny = new Set<ReasonCode>();
  const esc = new Set<ReasonCode>();
  let degraded: Decision["degraded"];
  const A = c.amountUsd;

  // Hard global rules
  if (A > limits.perCallCeiling) deny.add("ceiling-exceeded");
  if (!limits.allowedAssets.includes(c.asset)) deny.add("unsupported-asset");
  const paidAt = i.challengeState.paidAt;
  if (paidAt !== null && now - paidAt <= limits.replayWindowSec && !i.idempotent) deny.add("replay");
  if (now - i.challengeState.receivedAt > c.maxTimeoutSeconds) deny.add("stale-challenge");
  if (i.realOrigin === null) esc.add("unknown-origin");

  // Declaration
  const d = i.declaration;
  const decl = i.claim && d.status !== "none" ? d.value : undefined;
  if (d.status === "stale" && d.fetchedAt !== undefined) degraded = { dependency: "ens", staleSec: now - d.fetchedAt };
  if (d.status === "none" && d.outage) degraded = { dependency: "ens", staleSec: 0 };
  if (decl) {
    const mismatch =
      decl.payTo !== c.payTo || decl.network !== c.network || decl.asset !== c.asset ||
      (i.realOrigin !== null && !decl.domains.includes(i.realOrigin));
    if (mismatch) {
      if (d.status === "fresh") deny.add("declared-mismatch");
      else esc.add("declared-stale-mismatch");
    }
    if (A > decl.maxPriceUsd) deny.add("over-declared-max");
  }

  // Registry
  const r = i.registry;
  let view = r.view;
  let usable = r.status === "fresh";
  if (r.status === "stale" && view) {
    const age = now - view.computedAt;
    if (view.standing === "BLOCKED") usable = view.blockEnd !== null && view.blockEnd > now;
    else if (view.standing === "PROBATION") usable = true;
    else usable = age <= p.standingStaleSec;
    if (usable) degraded = { dependency: "arkiv", staleSec: age };
  }
  if (!usable) {
    view = undefined;
    esc.add("registry-unavailable");
    degraded ??= { dependency: "arkiv", staleSec: 0 };
  }

  // Standing
  let standing: Standing;
  if (view?.standing === "BLOCKED") standing = "BLOCKED";
  else if (!decl) standing = "UNKNOWN";
  else standing = view?.standing ?? "NEW";

  const s = view?.strikes ?? 0;
  const { R, factors } = riskScore({
    standing, b: view?.bScore ?? 0, L: view?.L ?? 0, D: view?.D ?? 0, g: view?.g ?? 0, A, s, t: i.familyTaint ? 1 : 0,
  });

  const merchantKey = i.claim && decl ? i.claim : c.payTo;
  const auto = autoLimit(standing, view?.D ?? 0, s, decl?.maxPriceUsd ?? 0);
  const softBase = standing === "NEW" || standing === "ESTABLISHED" || standing === "PROBATION" ? SOFT_CAPS[standing] : 0;
  const soft = degraded ? softBase / 2 : softBase;
  const used = i.ledger.merchantSpent24h;

  // Budgets hold for every standing
  if (i.ledger.sessionSpent + A > limits.sessionBudget || i.ledger.dailySpent + A > limits.dailyBudget) deny.add("budget-exceeded");

  if (standing === "BLOCKED") deny.add("blocked");
  else if (standing === "UNKNOWN") esc.add("unknown-merchant");
  else if (usable) {
    if (used + A > soft * HARD_CAP_MULTIPLE) deny.add("merchant-cap-hard");
    else if (used + A > soft) esc.add("merchant-cap");
    if (A > auto) esc.add(standing === "PROBATION" ? "probation-limit" : "limit-exceeded");
    if (standing === "PROBATION" && view?.holdUntil) esc.add("probation-hold");
    if (standing === "NEW" && i.ledger.newIdentitySpentToday + A > limits.newIdentityDailyBudget) esc.add("new-identity-budget");
    if (i.ledger.recentPrices.length && A > 2 * median(i.ledger.recentPrices.slice(-5))) esc.add("price-drift");
    // One bad cluster can never cause DENY, whatever the score says (S15).
    if (R >= limits.denyThreshold && (view?.badClusters ?? 0) >= 2) deny.add("risk-band");
    else if (R >= limits.allowThreshold) esc.add("risk-band");
  }

  if ((i.unverifiedBadClusters ?? 0) >= 2) esc.add("unverified-reports");
  if (i.safeMode) esc.add("safe-mode");

  if (!deny.size && esc.size && i.escalationsLastHour >= limits.escalationRatePerHour) deny.add("escalation-rate-limit");

  const verdict: Verdict = deny.size ? "DENY" : esc.size ? "ESCALATE" : "ALLOW";

  return {
    id: createHash("sha256").update(`${hash}|${now}`).digest("hex").slice(0, 24),
    verdict,
    reasons: [...deny, ...esc],
    standing,
    score: R,
    factors,
    limits: { autoApprove: auto, cap24h: soft, capUsed24h: used },
    challengeHash: hash,
    merchantKey,
    amountUsd: A,
    degraded,
    at: now,
  };
}
