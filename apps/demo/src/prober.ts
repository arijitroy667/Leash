// The prober pays a blocked or probation merchant for real, checks delivery and records the result.
// It solves the chicken-and-egg problem: a blocked merchant gets no payments, so it could never prove itself.
import "dotenv/config";
import { fileURLToPath } from "node:url";
import { wrapFetchWithPayment } from "@x402/fetch";
import { Transaction } from "@hiero-ledger/sdk";
import type { StandingView } from "@leash/core";
import { buildReader, deliveryCheck, digest, rawClient, safeError } from "@leash/guard";

const env = process.env;
const hex = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;
export { buildReader };
const PROBE_USD = 0.01;
const BUDGET_PER_DAY = 0.5;

export async function probeOnce(reader: ReturnType<typeof buildReader>, ens: string) {
  const account = env.PROBER_ACCOUNT;
  const key = env.PROBER_KEY;
  if (!account || !key) throw new Error("PROBER is missing. Run pnpm wallets:create");
  const day = new Date().toISOString().slice(0, 10);
  if (reader.store.probeSpent(day) + PROBE_USD > BUDGET_PER_DAY) return { skipped: "budget" as const };

  const decl = await reader.ens.fetch(ens);
  if (!decl?.probeUrl) return { skipped: "no-probe-url" as const };

  // The prober pays directly: the guard would rightly refuse a blocked merchant.
  const client = rawClient(account, key, reader.usdc);
  let txId = "";
  let amount = 0;
  client.onAfterPaymentCreation(async (ctx: any) => {
    txId = Transaction.fromBytes(Buffer.from(String(ctx.paymentPayload.payload.transaction), "base64")).transactionId!.toString();
    amount = Number(ctx.selectedRequirements.amount);
  });
  client.onBeforePaymentCreation(async (ctx: any) => {
    if (Number(ctx.selectedRequirements.amount) / 1e6 > PROBE_USD) return { abort: true, reason: "probe-too-expensive" };
    if (ctx.selectedRequirements.payTo !== decl.payTo) return { abort: true, reason: "probe-payto-mismatch" };
    if (ctx.selectedRequirements.asset !== reader.usdc) return { abort: true, reason: "probe-asset-mismatch" };
    return undefined;
  });
  const res = await wrapFetchWithPayment(fetch, client)(decl.probeUrl);
  const body = await res.text();
  const check = deliveryCheck({ status: res.status, contentType: res.headers.get("content-type"), body, schema: decl.schema });
  if (!txId) return { skipped: "no-payment" as const };
  reader.store.addProbeSpend(day, amount / 1e6);

  let facts = await reader.mirror.tx(txId);
  for (let i = 0; i < 15 && !facts.found; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    facts = await reader.mirror.tx(txId);
  }
  if (!facts.success) return { skipped: "not-settled" as const, txId };
  const result = check.ok ? ("pass" as const) : ("fail" as const);
  const { entityKey } = await reader.arkiv.writeProbe(hex(key), {
    payee: decl.payTo, result, txId, consensusTs: facts.consensusTs!, amountMicroUsd: amount, deliveryDigest: digest(body),
  }, reader.params.reportTtlSec);
  reader.audit("probe", txId, { payee: decl.payTo, result, txId, entityKey, at: facts.consensusTs });
  await reader.flushAudit();
  return { result, txId, entityKey };
}

/** The probe that is due, if any: one for a rebuttal filed during this block, and one a policy day during probation. */
export function probeDue(view: StandingView, latestRebuttalAt: number | undefined, done: Set<string>, now: number, policyDaySec: number): string | null {
  let key: string | null = null;
  if (view.standing === "BLOCKED" && latestRebuttalAt !== undefined && latestRebuttalAt >= (view.blockStart ?? 0)) key = `r:${latestRebuttalAt}`;
  if (view.standing === "PROBATION" && view.probationStart !== null) key = `p:${view.probationStart}:${Math.floor((now - view.probationStart) / policyDaySec)}`;
  return key && !done.has(key) ? key : null;
}

export async function watch(names: string[], intervalMs = 5000) {
  const reader = buildReader();
  const done = new Set<string>();
  for (;;) {
    for (const name of names) {
      try {
        const decl = await reader.ens.fetch(name);
        if (!decl) continue;
        const now = Date.now() / 1000;
        const { view, rows } = await reader.read(decl.payTo, now);
        const due = probeDue(view, rows.rebuttals[0]?.filedAt, done, now, reader.params.policyDaySec);
        if (due) {
          done.add(due);
          console.log(name, view.standing, JSON.stringify(await probeOnce(reader, name)));
        }
      } catch (e) {
        console.error(name, "probe error", safeError(e));
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await watch([env.ENS_NAME_WEATHER, env.ENS_NAME_LEMON].filter(Boolean) as string[]);
}
