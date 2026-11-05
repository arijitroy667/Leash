import { afterEach, describe, expect, it, vi } from "vitest";
import { PROBE_BUDGET_PER_DAY, PROBE_USD, type StandingView } from "@leash/core";
import { Store } from "@leash/guard";
import { probeDue, probeOnce } from "../src/prober.ts";

const view = (over: Partial<StandingView>): StandingView => ({
  standing: "NEW", strikes: 0, blockStart: null, blockEnd: null, probationStart: null, holdUntil: null, rebuttalUsed: false, computedAt: 0,
  b: 0, bScore: 0, L: 0, D: 0, g: 0, badClusters: 0, goodClusters: 0, ...over,
});
const DAY = 18;

describe("which probe is due", () => {
  const blocked = view({ standing: "BLOCKED", blockStart: 100, blockEnd: 160 });

  it("none for a merchant in good standing", () => {
    expect(probeDue(view({}), [150], new Set(), 200, DAY)).toBeNull();
    expect(probeDue(view({ standing: "ESTABLISHED" }), [150], new Set(), 200, DAY)).toBeNull();
  });
  it("during a block, only for a rebuttal filed in this block, and only once", () => {
    expect(probeDue(blocked, [], new Set(), 120, DAY)).toBeNull();
    expect(probeDue(blocked, [50], new Set(), 120, DAY)).toBeNull(); // filed in an earlier block
    expect(probeDue(blocked, [110, 50], new Set(), 120, DAY)).toBe("r:110");
    expect(probeDue(blocked, [110], new Set(["r:110"]), 120, DAY)).toBeNull();
  });
  it("F13: a second rebuttal in the same block buys no second probe", () => {
    expect(probeDue(blocked, [130, 110], new Set(["r:110"]), 140, DAY)).toBeNull();
  });
  afterEach(() => vi.unstubAllEnvs());
  it("NFR-08: spends at most 0.50 USD a day, and stops before any network call", async () => {
    vi.stubEnv("PROBER_ACCOUNT", "0.0.1");
    vi.stubEnv("PROBER_KEY", "11".repeat(32));
    const store = new Store(":memory:");
    const reader = { store, ens: { fetch: () => Promise.reject(new Error("no network in this test")) } } as never;
    store.addProbeSpend(new Date().toISOString().slice(0, 10), PROBE_BUDGET_PER_DAY - PROBE_USD / 2);
    expect(await probeOnce(reader, "m.eth")).toEqual({ skipped: "budget" });
    expect(PROBE_BUDGET_PER_DAY).toBe(0.5);
  });
  it("during probation, one each policy day", () => {
    const probation = view({ standing: "PROBATION", probationStart: 200, strikes: 1 });
    const done = new Set<string>();
    const first = probeDue(probation, [], done, 201, DAY);
    expect(first).toBe("p:200:0");
    done.add(first!);
    expect(probeDue(probation, [], done, 217, DAY)).toBeNull();
    expect(probeDue(probation, [], done, 218, DAY)).toBe("p:200:1");
  });
});
