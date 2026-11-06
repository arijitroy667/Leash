import { NextResponse } from "next/server";
import { REASON_CODES } from "@leash/core";
import { safeError, validAccount, validName } from "@leash/guard";
import { ACCOUNT_ID, auditAccounts, knownMerchants, reader } from "../../../lib/server";

export const dynamic = "force-dynamic";

const MIRROR = process.env.MIRROR_URL ?? "https://testnet.mirrornode.hedera.com";
const REASONS = new Set<string>(REASON_CODES);
const one = <T extends string>(v: unknown, allowed: readonly T[]) => (allowed.includes(v as T) ? (v as T) : null);
const money = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e6 ? v : null);

/**
 * The topic takes messages from anyone, so a message counts only if one of this deployment's wallets paid for it,
 * and only known fields in known shapes are passed on. Nothing a merchant wrote reaches the page.
 */
function toItem(m: any) {
  let p: any;
  try {
    p = JSON.parse(Buffer.from(String(m.message), "base64").toString("utf8"));
  } catch {
    return null;
  }
  const type = one(p?.type, ["decision", "report", "approval", "probe", "rebuttal"] as const);
  if (!type) return null;
  return {
    seq: Number(m.sequence_number),
    at: Number(m.consensus_timestamp),
    ts: /^\d{1,12}\.\d{1,9}$/.test(String(m.consensus_timestamp)) ? String(m.consensus_timestamp) : null,
    payer: String(m.payer_account_id),
    type,
    agent: typeof p.agent === "string" && /^agent-[a-z0-9]{1,4}$/.test(p.agent) ? p.agent : null,
    merchant: [p.merchant, p.ens, p.payee].find((x) => validName(x) || validAccount(x)) ?? null,
    verdict: one(p.verdict, ["ALLOW", "ESCALATE", "DENY"] as const),
    reasons: Array.isArray(p.reasons) ? p.reasons.filter((x: unknown) => typeof x === "string" && REASONS.has(x)).slice(0, 6) : [],
    standing: one(p.standing, ["UNKNOWN", "NEW", "ESTABLISHED", "BLOCKED", "PROBATION"] as const),
    score: typeof p.score === "number" && Number.isFinite(p.score) ? Math.round(p.score * 10) / 10 : null,
    amountUsd: money(p.amountUsd),
    outcome: one(p.outcome, ["good", "bad"] as const),
    result: one(p.result, ["pass", "fail"] as const),
    state: one(p.state, ["requested", "used"] as const),
    reason: typeof p.reason === "string" && /^[a-z-]{1,32}$/.test(p.reason) ? p.reason : null,
    txId: typeof p.txId === "string" && /^0\.0\.\d{1,12}@\d{1,12}\.\d{1,9}$/.test(p.txId) ? p.txId : null,
  };
}

/** Payee accounts to the names that declare them in ENS, so a report reads as a merchant. Cached for five minutes. */
let names: { at: number; map: Map<string, string> } | null = null;
async function nameMap() {
  if (names && Date.now() - names.at < 300_000) return names.map;
  const map = new Map<string, string>();
  await Promise.all(knownMerchants().filter((m) => m.name).map(async (m) => {
    const d = await reader().ens.fetch(m.name!).catch(() => null);
    if (d?.payTo) map.set(d.payTo, m.name!);
  }));
  names = { at: Date.now(), map };
  return map;
}

export async function GET() {
  const topic = process.env.HCS_TOPIC_ID;
  if (!topic || !ACCOUNT_ID.test(topic)) return NextResponse.json({ topic: null, items: [] });
  try {
    const r = await fetch(`${MIRROR}/api/v1/topics/${topic}/messages?order=desc&limit=60`, { signal: AbortSignal.timeout(6000), cache: "no-store" });
    if (!r.ok) throw new Error(`mirror ${r.status}`);
    const j = await r.json();
    const ours = auditAccounts();
    const map = await nameMap();
    const items = (j.messages ?? []).filter((m: any) => ours.has(String(m.payer_account_id))).map(toItem).filter(Boolean).slice(0, 30)
      .map((i: any) => ({ ...i, merchant: map.get(i.merchant) ?? i.merchant }));
    return NextResponse.json(
      { topic, total: j.messages?.[0]?.sequence_number ?? null, items },
      { headers: { "cache-control": "public, s-maxage=3, stale-while-revalidate=6" } },
    );
  } catch (e) {
    return NextResponse.json({ topic, items: [], error: safeError(e) }, { status: 502 });
  }
}
