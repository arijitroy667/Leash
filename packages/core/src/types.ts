export type Standing = "UNKNOWN" | "NEW" | "ESTABLISHED" | "BLOCKED" | "PROBATION";
export type Verdict = "ALLOW" | "ESCALATE" | "DENY";

export type ReasonCode =
  | "ceiling-exceeded" | "declared-mismatch" | "over-declared-max" | "replay" | "stale-challenge"
  | "blocked" | "merchant-cap-hard" | "budget-exceeded" | "escalation-rate-limit" | "risk-band"
  | "unsupported-asset" | "unknown-merchant" | "unknown-origin" | "limit-exceeded" | "merchant-cap"
  | "new-identity-budget" | "price-drift" | "probation-limit" | "probation-hold" | "registry-unavailable"
  | "declared-stale-mismatch" | "unverified-reports" | "safe-mode" | "settlement-unknown" | "locally-blocked";

/** A report already verified by the reader against Mirror Node and the payer's key. */
export interface Report {
  txId: string;
  ts: number; // consensus time, seconds
  outcome: "good" | "bad";
  cluster: string;
  payer: string;
  amountUsd: number;
  payerCreatedTs: number;
}

export interface Probe {
  txId: string;
  ts: number;
  result: "pass" | "fail";
  cluster: string;
  amountUsd: number;
}

/** A rebuttal whose signer was already checked against the ENS role. */
export interface Rebuttal {
  ts: number;
}

export interface Evidence {
  reports: Report[];
  probes: Probe[];
  rebuttals: Rebuttal[];
}

export interface Stats {
  b: number; // raw decayed bad evidence
  bScore: number; // b after contested halving
  L: number;
  D: number;
  g: number;
  badClusters: number;
  goodClusters: number;
}

export interface StandingView extends Stats {
  standing: Exclude<Standing, "UNKNOWN">;
  strikes: number;
  blockStart: number | null;
  blockEnd: number | null;
  probationStart: number | null;
  holdUntil: number | null;
  rebuttalUsed: boolean;
  computedAt: number;
}

export interface Declaration {
  payTo: string;
  network: string;
  asset: string;
  maxPriceUsd: number;
  domains: string[];
  schema: string[];
  probeUrl?: string;
  policyVersion: number;
}

export interface Challenge {
  scheme: string;
  network: string;
  asset: string;
  amountUsd: number;
  payTo: string;
  resourceUrl: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface Limits {
  perCallCeiling: number;
  sessionBudget: number;
  dailyBudget: number;
  newIdentityDailyBudget: number;
  escalationRatePerHour: number;
  replayWindowSec: number;
  allowThreshold: number;
  denyThreshold: number;
  allowedAssets: string[];
}

export interface Decision {
  id: string;
  verdict: Verdict;
  reasons: ReasonCode[];
  standing: Standing;
  score: number;
  factors: { bad: number; loss: number; trust: number; exposure: number; identity: number };
  limits: { autoApprove: number; cap24h: number; capUsed24h: number };
  challengeHash: string;
  /** Set when this decision opened an approval. */
  approvalId?: string;
  merchantKey: string;
  amountUsd: number;
  degraded?: { dependency: string; staleSec: number };
  at: number;
}
