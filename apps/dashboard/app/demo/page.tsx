import { policySummary } from "@leash/core";
import { PUBLIC_MODE, knownMerchants, reader } from "../../lib/server";
import { DemoClient } from "./demo-client";

export const metadata = { title: "Live demo", description: "Real AI agents paying real x402 merchants on Hedera testnet, guarded by Leash, with every event linked to a public explorer." };
export const dynamic = "force-dynamic";

export default function DemoPage() {
  const r = reader();
  // Names come from the configuration, never from the code.
  const merchants = knownMerchants().map((m) => ({ key: m.name ?? m.payTo!, name: m.name, payTo: m.payTo ?? null }));
  return <DemoClient canRun={!PUBLIC_MODE} profile={r.params.name} note={policySummary(r.params)} merchants={merchants} />;
}
