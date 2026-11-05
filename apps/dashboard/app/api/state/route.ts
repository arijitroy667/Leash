import { NextResponse } from "next/server";
import { DEFAULT_LIMITS, PROBE_BUDGET_PER_DAY, policySummary } from "@leash/core";
import { approvalMessage, safeError, type Store } from "@leash/guard";
import { PUBLIC_MODE, knownMerchants, merchantRow, reader } from "../../../lib/server";

export const dynamic = "force-dynamic";

let facilitatorCheckedAt = 0;

/** The merchant picks the facilitator, so this is for the health screen only. Never holds up the response. */
function checkFacilitator(store: Store, now: number) {
  const url = process.env.FACILITATOR_URL;
  if (!url || now - facilitatorCheckedAt < 15) return;
  facilitatorCheckedAt = now;
  fetch(`${url}/supported`, { signal: AbortSignal.timeout(4000) })
    .then(async (r) => {
      const ok = r.ok && (await r.text()).includes("hedera:testnet");
      store.setHealth("facilitator", ok, now, ok ? "" : "does not list hedera:testnet");
    })
    .catch((e) => store.setHealth("facilitator", false, now, safeError(e)));
}

export async function GET() {
  if (PUBLIC_MODE) return NextResponse.json({ error: "owner console is not public" }, { status: 403 });
  const r = reader();
  const now = Date.now() / 1000;
  r.store.expireApprovals(now);
  checkFacilitator(r.store, now);
  const merchants = await Promise.all(knownMerchants().map((m) => merchantRow(m.name ?? m.payTo!, m.payTo)));
  const lat = r.store.recentDecisions(200).map((d) => d.latencyMs).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  const pct = (p: number) => lat[Math.max(0, Math.ceil(p * lat.length) - 1)] ?? null;
  return NextResponse.json({
    latency: { p50: pct(0.5), p95: pct(0.95), n: lat.length },
    probeSpend: { today: r.store.probeSpent(new Date().toISOString().slice(0, 10)), budget: PROBE_BUDGET_PER_DAY },
    now,
    profile: r.params.name,
    policyNote: policySummary(r.params),
    namespace: r.ns,
    owner: process.env.LEASH_OWNER_ADDRESS ?? null,
    topic: process.env.HCS_TOPIC_ID ?? null,
    health: r.store.healthAll(),
    safeMode: r.store.safeMode(),
    escalations: r.store.escalationsByAgent(now),
    escalationLimit: DEFAULT_LIMITS.escalationRatePerHour,
    outbox: r.store.outboxDepth(),
    approvals: r.store.listApprovals(undefined, 30).map((a) => ({ ...a, message: approvalMessage(a) })),
    decisions: r.store.recentDecisions(40),
    merchants,
  });
}
