import { NextResponse } from "next/server";
import { DEFAULT_LIMITS } from "@leash/core";
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
  return NextResponse.json({
    now,
    profile: r.params.name,
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
