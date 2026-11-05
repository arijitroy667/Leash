const HOUR = 3600;
const DAY = 24 * HOUR;

/** Durations are seconds. Only the ones the PRD lists differ between profiles. */
export interface PolicyParams {
  name: "production" | "live";
  blockBaseSec: number;
  blockMaxSec: number;
  holdSec: number;
  rebuttalCooldownSec: number;
  probationMinUnitSec: number;
  strikeMemorySec: number;
  reportTtlSec: number;
  badPerPayeeWindowSec: number;
  standingFreshSec: number;
  standingStaleSec: number;
  ensFreshSec: number;
  ensStaleSec: number;
  badHalfLifeSec: number;
  badWindowSec: number;
  goodHalfLifeSec: number;
  goodWindowSec: number;
  probationToNewSec: number;
  firstGoodAgeSec: number;
  youngAccountSec: number;
}

const production: PolicyParams = {
  name: "production",
  blockBaseSec: 5 * DAY,
  blockMaxSec: 20 * DAY,
  holdSec: 72 * HOUR,
  rebuttalCooldownSec: 24 * HOUR,
  probationMinUnitSec: 3 * DAY,
  strikeMemorySec: 60 * DAY,
  reportTtlSec: 60 * DAY,
  badPerPayeeWindowSec: 24 * HOUR,
  standingFreshSec: 60,
  standingStaleSec: 900,
  ensFreshSec: 60,
  ensStaleSec: 600,
  badHalfLifeSec: 72 * HOUR,
  badWindowSec: 7 * DAY,
  goodHalfLifeSec: 168 * HOUR,
  goodWindowSec: 21 * DAY,
  probationToNewSec: 21 * DAY,
  firstGoodAgeSec: 24 * HOUR,
  youngAccountSec: 24 * HOUR,
};

const LIVE_DAY = 18; // 1 policy day = 18 real seconds, disclosed on screen

const live: PolicyParams = {
  ...production,
  name: "live",
  blockBaseSec: 5 * LIVE_DAY,
  blockMaxSec: 20 * LIVE_DAY,
  holdSec: 3 * LIVE_DAY,
  rebuttalCooldownSec: LIVE_DAY,
  probationMinUnitSec: 3 * LIVE_DAY,
  strikeMemorySec: 60 * LIVE_DAY,
  reportTtlSec: 60 * LIVE_DAY,
  badPerPayeeWindowSec: LIVE_DAY,
  standingFreshSec: 5,
};

export const PROFILES = { production, live } as const;

export const DEFAULT_LIMITS = {
  perCallCeiling: 1.0,
  sessionBudget: 2.0,
  dailyBudget: 10.0,
  newIdentityDailyBudget: 0.1,
  escalationRatePerHour: 10,
  replayWindowSec: 120,
  allowThreshold: 35,
  denyThreshold: 70,
};

export const SOFT_CAPS = { NEW: 0.05, ESTABLISHED: 1.0, PROBATION: 0.1 } as const;
export const HARD_CAP_MULTIPLE = 5;
