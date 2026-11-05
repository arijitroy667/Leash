import { resolve } from "node:path";
import { config } from "dotenv";
import { buildReader, parseDeclaration, safeError, validName } from "@herd/guard";

/** Public mode serves the read-only explorer: no database file, no keys, no approvals. */
export const PUBLIC_MODE = process.env.HERD_PUBLIC === "1";
if (!PUBLIC_MODE) config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

type Reader = ReturnType<typeof buildReader>;
const cached = new Map<string, Reader>();

/** Registries the explorer may show, as `namespace:profile`. Default: the configured one. */
export function namespaces(): { ns: string; profile: string }[] {
  const list = (process.env.HERD_PUBLIC_NAMESPACES ?? "").split(",").filter(Boolean).map((p) => {
    const [ns, profile] = p.split(":");
    return { ns: ns!, profile: profile === "live" ? "live" : "production" };
  });
  return list.length ? list : [{ ns: process.env.HERD_NAMESPACE ?? "dev", profile: process.env.HERD_POLICY_PROFILE ?? "production" }];
}

/** An unlisted namespace falls back to the default, so a query string cannot pick a profile. */
export function reader(ns?: string): Reader {
  const chosen = namespaces().find((n) => n.ns === ns) ?? namespaces()[0]!;
  let r = cached.get(chosen.ns);
  if (!r) {
    r = buildReader({
      ...process.env,
      HERD_NAMESPACE: chosen.ns,
      HERD_POLICY_PROFILE: chosen.profile,
      HERD_DB: PUBLIC_MODE ? ":memory:" : (process.env.HERD_DB ?? resolve(process.cwd(), "../../.herd/herd.sqlite")),
    });
    cached.set(chosen.ns, r);
  }
  return r;
}

export const ACCOUNT_ID = /^0\.0\.\d+$/;

/** Every merchant we know about: declared names first, then bare payTo accounts. */
export function knownMerchants(): { name: string | null; payTo?: string }[] {
  const e = process.env;
  const list: { name: string | null; payTo?: string }[] = [];
  for (const name of [e.ENS_NAME_WEATHER, e.ENS_NAME_LEMON]) if (name) list.push({ name });
  for (const payTo of [e.MERCHANT_SPOOF_ACCOUNT, e.MERCHANT_ROGUE_ACCOUNT]) if (payTo) list.push({ name: null, payTo });
  return list;
}

export interface MerchantRow {
  key: string;
  name: string | null;
  payTo: string | null;
  declaration: ReturnType<typeof parseDeclaration>;
  standing: string;
  view: unknown;
  reports: { outcome: string; txId: string; payer: string; amountUsd: number; reason: string; valid: boolean; why?: string; consensusTs: number; owner: string }[];
  probes: { result: string; txId: string; consensusTs: number }[];
  rebuttals: { reason: string; filedAt: number; signer: string }[];
  error?: string;
}

export async function merchantRow(key: string, payToHint?: string, r: Reader = reader()): Promise<MerchantRow> {
  const now = Date.now() / 1000;
  const name = validName(key) ? key : null;
  const base: MerchantRow = { key, name, payTo: payToHint ?? (name ? null : key), declaration: null, standing: "UNKNOWN", view: null, reports: [], probes: [], rebuttals: [] };
  try {
    if (name) {
      base.declaration = await r.ens.fetch(name);
      base.payTo = base.declaration?.payTo ?? null;
    }
    if (!base.payTo) return base;
    const v = await r.read(base.payTo, now);
    base.view = v.view;
    base.standing = v.view.standing === "BLOCKED" || base.declaration ? v.view.standing : "UNKNOWN";
    // Structured fields only. Reason codes are written by guards, so only known shapes are shown.
    base.reports = v.rows.reports.map((x) => ({
      outcome: x.outcome, txId: x.txId, payer: x.payer, amountUsd: x.amountMicroUsd / 1e6,
      reason: /^[a-z-]{1,32}$/.test(x.reason) ? x.reason : "invalid", valid: x.valid, why: x.why, consensusTs: x.consensusTs, owner: x.owner,
    }));
    base.probes = v.rows.probes.map((x) => ({ result: x.result, txId: x.txId, consensusTs: x.consensusTs }));
    base.rebuttals = v.rows.rebuttals.map((x) => ({ reason: /^[a-z-]{1,32}$/.test(x.reason) ? x.reason : "invalid", filedAt: x.filedAt, signer: x.signer }));
  } catch (e) {
    base.error = safeError(e);
  }
  return base;
}
