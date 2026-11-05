import { describe, expect, it } from "vitest";
import type { StandingView } from "@leash/core";
import { probeDue } from "../src/prober.ts";

const view = (over: Partial<StandingView>): StandingView => ({
  standing: "NEW", strikes: 0, blockStart: null, blockEnd: null, probationStart: null, holdUntil: null, rebuttalUsed: false, computedAt: 0,
  b: 0, bScore: 0, L: 0, D: 0, g: 0, badClusters: 0, goodClusters: 0, ...over,
});
const DAY = 18;

describe("which probe is due", () => {
  const blocked = view({ standing: "BLOCKED", blockStart: 100, blockEnd: 160 });

  it("none for a merchant in good standing", () => {
    expect(probeDue(view({}), 150, new Set(), 200, DAY)).toBeNull();
    expect(probeDue(view({ standing: "ESTABLISHED" }), 150, new Set(), 200, DAY)).toBeNull();
  });
  it("during a block, only for a rebuttal filed in this block, and only once", () => {
    expect(probeDue(blocked, undefined, new Set(), 120, DAY)).toBeNull();
    expect(probeDue(blocked, 50, new Set(), 120, DAY)).toBeNull(); // filed in an earlier block
    expect(probeDue(blocked, 110, new Set(), 120, DAY)).toBe("r:110");
    expect(probeDue(blocked, 110, new Set(["r:110"]), 120, DAY)).toBeNull();
  });
  it("during probation, one each policy day", () => {
    const probation = view({ standing: "PROBATION", probationStart: 200, strikes: 1 });
    const done = new Set<string>();
    const first = probeDue(probation, undefined, done, 201, DAY);
    expect(first).toBe("p:200:0");
    done.add(first!);
    expect(probeDue(probation, undefined, done, 217, DAY)).toBeNull();
    expect(probeDue(probation, undefined, done, 218, DAY)).toBe("p:200:1");
  });
});
