import type { Decision, Standing } from "./types.ts";

export interface ScoreInput {
  standing: Standing;
  b: number;
  L: number;
  D: number;
  g: number;
  A: number;
  s: number;
  t: number;
}

const IDENTITY_BASE: Record<Standing, number> = { NEW: 0.5, ESTABLISHED: 0, PROBATION: 0.7, BLOCKED: 0.5, UNKNOWN: 1 };

export function riskScore(i: ScoreInput): { R: number; factors: Decision["factors"] } {
  const factors = {
    bad: 1 - Math.exp(-i.b),
    loss: i.L / (i.L + i.D + 0.05),
    trust: Math.exp(-i.g / 2),
    exposure: Math.min(1, i.A / (i.D + 0.02)),
    identity: Math.min(1, IDENTITY_BASE[i.standing] + 0.1 * Math.min(i.s, 3) + 0.2 * i.t),
  };
  const R = 100 * (0.3 * factors.bad + 0.2 * factors.loss + 0.15 * factors.trust + 0.2 * factors.exposure + 0.15 * factors.identity);
  return { R, factors };
}

export function autoLimit(standing: Standing, D: number, s: number, declaredMax: number): number {
  switch (standing) {
    case "NEW": return 0.01;
    case "ESTABLISHED": return Math.max(0.01, Math.min(declaredMax, 1, 0.5 * D));
    case "PROBATION": return Math.max(0.01, 0.05 / Math.max(s, 1));
    default: return 0;
  }
}
