import { NextResponse } from "next/server";
import { LeashDenied, LeashEscalated, safeError } from "@leash/guard";
import { PUBLIC_MODE, demoAgent } from "../../../lib/server";

export const dynamic = "force-dynamic";

/** The demo's real calls: a real agent, a real merchant and a real payment. Each maps to a scene of the filmed demo. */
const SCENES = {
  weather: { agent: "A", merchant: "WEATHER", path: "/forecast" },
  "lemon-a": { agent: "A", merchant: "LEMON", path: "/forecast" },
  "lemon-b": { agent: "B", merchant: "LEMON", path: "/forecast" },
  "lemon-c": { agent: "C", merchant: "LEMON", path: "/forecast" },
  spoof: { agent: "A", merchant: "SPOOF", path: "/forecast" },
  rogue: { agent: "C", merchant: "ROGUE", path: "/premium" },
} as const;

/** Operator machine only: the agents' keys live there and never reach a public deployment. */
export async function POST(req: Request) {
  if (PUBLIC_MODE) return NextResponse.json({ error: "The demo runs on the operator's machine, where the agents' keys are" }, { status: 403 });
  const { scene, run } = (await req.json().catch(() => ({}))) as { scene?: string; run?: string };
  const s = SCENES[scene as keyof typeof SCENES];
  // The run token names the challenge: the same token is the same purchase, so an approval applies and a repeat is a replay.
  if (!s || typeof run !== "string" || !/^[a-z0-9]{1,16}$/.test(run)) return NextResponse.json({ error: "unknown scene" }, { status: 400 });
  const base = process.env[`MERCHANT_${s.merchant}_URL`];
  if (!base) return NextResponse.json({ error: `MERCHANT_${s.merchant}_URL is not set` }, { status: 500 });
  const url = `${base}${s.path}?run=${run}`;
  const { guard, paidFetch } = demoAgent(s.agent);
  const out = { scene, agent: s.agent, merchant: s.merchant.toLowerCase(), url };
  try {
    const res = await paidFetch(url);
    const leash = (res as any).leash;
    if (!leash) return NextResponse.json({ ...out, outcome: "no_payment", status: res.status });
    // A payment the owner approved was decided ESCALATE, then paid with the signed approval.
    const d = guard.explain(leash.decisionId);
    return NextResponse.json({ ...out, outcome: "paid", verdict: d?.verdict ?? "ALLOW", status: res.status, delivered: leash.delivered, txId: leash.txId, reasons: d?.reasons ?? [], score: d?.score, standing: d?.standing, latencyMs: d?.latencyMs });
  } catch (e) {
    if (e instanceof LeashDenied || e instanceof LeashEscalated) {
      const d = e.decision;
      return NextResponse.json({ ...out, outcome: e instanceof LeashDenied ? "denied" : "escalated", verdict: d.verdict, reasons: d.reasons, score: d.score, standing: d.standing, latencyMs: d.latencyMs, approvalId: e instanceof LeashEscalated ? e.approvalId : undefined });
    }
    return NextResponse.json({ ...out, error: safeError(e) }, { status: 502 });
  }
}
