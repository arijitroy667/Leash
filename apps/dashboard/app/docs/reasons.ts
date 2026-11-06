import { DEFAULT_LIMITS, HARD_CAP_MULTIPLE, type ReasonCode } from "@leash/core";

const L = DEFAULT_LIMITS;
const usd = (n: number) => `$${n.toFixed(2)}`;

/** One line per reason, in words. The type makes a reason the engine has but the docs lack a build error. */
export const REASON_TEXT: Record<ReasonCode, [verdict: "DENY" | "ESCALATE" | "DENY or ESCALATE", text: string]> = {
  "ceiling-exceeded": ["DENY", `The amount is above the per-call ceiling (${usd(L.perCallCeiling)}), or is not a number.`],
  "unsupported-asset": ["DENY", "The 402 asks for a token other than the pinned USDC."],
  "malformed-challenge": ["DENY", "The payTo is not a plain account id, or the amount is not a whole number. The text is never shown."],
  "declared-mismatch": ["DENY", "The payTo, network, asset or origin contradicts a fresh ENS declaration: a spoof."],
  "over-declared-max": ["DENY", "The price is above the merchant's own leash.maxPrice."],
  replay: ["DENY", `This exact challenge was paid in the last ${L.replayWindowSec} seconds.`],
  "stale-challenge": ["DENY", "The 402 is older than its own maxTimeoutSeconds."],
  blocked: ["DENY", "The payee is BLOCKED, whether or not it claims an ENS name."],
  "merchant-cap-hard": ["DENY", `24-hour spend with this merchant would pass ${HARD_CAP_MULTIPLE} times its soft cap.`],
  "budget-exceeded": ["DENY", `The session (${usd(L.sessionBudget)}) or daily (${usd(L.dailyBudget)}) budget would be passed.`],
  "escalation-rate-limit": ["DENY", `More than ${L.escalationRatePerHour} new escalations in an hour: a defence against approval bombing.`],
  "locally-blocked": ["DENY", "The owner rejected this payee and blocked it on this machine."],
  "risk-band": ["DENY or ESCALATE", `A risk score of ${L.allowThreshold} or more escalates; ${L.denyThreshold} or more denies, but only with two or more bad clusters.`],
  "unknown-merchant": ["ESCALATE", "No valid ENS declaration. Unknown merchants always ask, even for dust."],
  "unknown-origin": ["ESCALATE", "The call went around guardedFetch, so its real origin is unknown."],
  "limit-exceeded": ["ESCALATE", "The amount is above the standing's auto-approve limit."],
  "merchant-cap": ["ESCALATE", "24-hour spend with this merchant would pass its soft cap."],
  "new-identity-budget": ["ESCALATE", `NEW merchants together would take more than ${usd(L.newIdentityDailyBudget)} today: identity rotation is bounded.`],
  "price-drift": ["ESCALATE", "More than twice the median of the last five prices paid for this resource: bait and switch."],
  "probation-limit": ["ESCALATE", "Above the probation limit."],
  "probation-hold": ["ESCALATE", "A bad report during probation started a hold."],
  "registry-unavailable": ["ESCALATE", "No usable standing: Arkiv is unreachable and there is no cache that may be used."],
  "declared-stale-mismatch": ["ESCALATE", "A stale ENS cache disagrees with the 402. Stale data never denies."],
  "unverified-reports": ["ESCALATE", "Some evidence could not be checked because Mirror Node, Arkiv or Sepolia failed."],
  "safe-mode": ["ESCALATE", "Two of ENS, Arkiv and Mirror Node are down. A cached block still denies."],
  "settlement-unknown": ["ESCALATE", "An earlier attempt at this challenge may still settle, and Mirror Node cannot say yet."],
};
