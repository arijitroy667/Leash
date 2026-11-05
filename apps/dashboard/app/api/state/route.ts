import { NextResponse } from "next/server";
import { approvalMessage } from "@leash/guard";
import { PUBLIC_MODE, knownMerchants, merchantRow, reader } from "../../../lib/server";

export const dynamic = "force-dynamic";

export async function GET() {
  if (PUBLIC_MODE) return NextResponse.json({ error: "owner console is not public" }, { status: 403 });
  const r = reader();
  const now = Date.now() / 1000;
  r.store.expireApprovals(now);
  const merchants = await Promise.all(knownMerchants().map((m) => merchantRow(m.name ?? m.payTo!, m.payTo)));
  const down = r.store.healthAll().filter((h) => ["ens", "arkiv", "mirror"].includes(h.dep) && !h.ok);
  return NextResponse.json({
    now,
    profile: r.params.name,
    namespace: r.ns,
    owner: process.env.LEASH_OWNER_ADDRESS ?? null,
    topic: process.env.HCS_TOPIC_ID ?? null,
    health: r.store.healthAll(),
    safeMode: down.length >= 2,
    outbox: r.store.outboxDepth(),
    approvals: r.store.listApprovals(undefined, 30).map((a) => ({ ...a, message: approvalMessage(a) })),
    decisions: r.store.recentDecisions(40),
    merchants,
  });
}
