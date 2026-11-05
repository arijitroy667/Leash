const HOUR = 3600;
const DAY = 24 * HOUR;

/** Durations are seconds. Only the ones the PRD lists differ between profiles. */
export interface PolicyParams {
  name: "production" | "live";
  /** One policy day: how often the prober retests a merchant in probation. */
  policyDaySec: number;
  /** Block length by strike: first, second, third. Later strikes use the last value. */
  blockSec: number[];
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
  policyDaySec: DAY,
  blockSec: [5 * DAY, 10 * DAY, 20 * DAY],
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

export const DEFAULT_LIVE_DAY_SEC = 18;
export const DEFAULT_LIVE_BLOCK_SEC = [60, 120, 300];

/**
 * The live profile runs the same engine on real elapsed time, with shorter durations. It throws on a clock that would
 * break the rules rather than quietly running something else, since standing is derived from these values by every reader.
 */
export function liveProfile(daySec = DEFAULT_LIVE_DAY_SEC, blockSec = DEFAULT_LIVE_BLOCK_SEC): PolicyParams {
  if (!(daySec > 0)) throw new RangeError("The live policy day must be a positive number of seconds");
  if (!blockSec.length || blockSec.some((sec) => !(sec > 0))) throw new RangeError("Live block lengths must be positive numbers of seconds");
  if (blockSec.some((sec, i) => i > 0 && sec < blockSec[i - 1]!)) throw new RangeError("Live block lengths must not shrink: a repeat offender cannot get a shorter block");
  // The per-payee report window and the rebuttal cooldown are one day, and both must fit inside a block.
  if (blockSec[0]! <= daySec) throw new RangeError("The first live block must be longer than one policy day");
  // A block exists only while its reports do, so evidence must outlive every block in a chain of strikes.
  const memory = Math.max(60 * daySec, 2 * blockSec.reduce((sum, sec) => sum + sec, 0));
  return {
    ...production,
    name: "live",
    policyDaySec: daySec,
    blockSec,
    holdSec: 3 * daySec,
    rebuttalCooldownSec: daySec,
    probationMinUnitSec: 3 * daySec,
    strikeMemorySec: memory,
    reportTtlSec: memory,
    badPerPayeeWindowSec: daySec,
    standingFreshSec: 5,
  };
}

const span = (sec: number) => (sec % 60 === 0 ? `${sec / 60} min` : `${sec} s`);

/** The disclosure shown on screen, from the values actually in use. */
export function policySummary(p: PolicyParams): string {
  const blocks = p.blockSec.map(span);
  const list = blocks.length > 1 ? `${blocks.slice(0, -1).join(", ")}, then ${blocks.at(-1)}` : blocks[0];
  return `1 policy day = ${p.policyDaySec} real seconds. Blocks last ${list}.`;
}

export const PROFILES = { production, live: liveProfile() } as const;

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

/** G5: bad reports one reporter may file in a rolling real day, across all payees. Not shortened by the live profile. */
export const REPORTER_BAD_PER_DAY = 5;
export const REPORTER_DAY_SEC = DAY;
