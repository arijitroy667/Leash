import { resolve } from "node:path";
import { config } from "dotenv";
import { riskScore, type Standing, type StandingView } from "@leash/core";
import { privateKeyToAccount } from "viem/accounts";
import { buildAgent, buildReader, parseDeclaration, safeError, validAccount, validName, type ListingRow } from "@leash/guard";

/** Public mode serves the read-only site: no database file, no keys, no approvals, no demo runner. */
export const PUBLIC_MODE = process.env.LEASH_PUBLIC === "1";
if (!PUBLIC_MODE) config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

/** The operator's store, shared with the agents, the MCP server and the scenes run from the repo root. */
const ROOT_DB = () => process.env.LEASH_DB ?? resolve(process.cwd(), "../../.leash/leash.sqlite");

type Reader = ReturnType<typeof buildReader>;
const cached = new Map<string, Reader>();

/** Registries the site may show, as `namespace:profile`. Default: the configured one. */
export function namespaces(): { ns: string; profile: string }[] {
  const list = (process.env.LEASH_PUBLIC_NAMESPACES ?? "").split(",").filter(Boolean).map((p) => {
    const [ns, profile] = p.split(":");
    return { ns: ns!, profile: profile === "live" ? "live" : "production" };
  });
  return list.length ? list : [{ ns: process.env.LEASH_NAMESPACE ?? "dev", profile: process.env.LEASH_POLICY_PROFILE ?? "production" }];
}

/** An unlisted namespace falls back to the default, so a query string cannot pick a profile. */
export function reader(ns?: string): Reader {
  const chosen = namespaces().find((n) => n.ns === ns) ?? namespaces()[0]!;
  let r = cached.get(chosen.ns);
  if (!r) {
    r = buildReader({ ...process.env, LEASH_NAMESPACE: chosen.ns, LEASH_POLICY_PROFILE: chosen.profile, LEASH_DB: PUBLIC_MODE ? ":memory:" : ROOT_DB() });
    cached.set(chosen.ns, r);
  }
  return r;
}

export const ACCOUNT_ID = /^0\.0\.\d+$/;

/** The merchants this deployment runs: declared names first, then the bare payTo accounts. */
export function knownMerchants(): { name: string | null; payTo?: string }[] {
  const e = process.env;
  const list: { name: string | null; payTo?: string }[] = [];
  for (const name of [e.ENS_NAME_WEATHER, e.ENS_NAME_LEMON, e.ENS_NAME_INVOICE]) if (name) list.push({ name });
  for (const payTo of [e.MERCHANT_SPOOF_ACCOUNT, e.MERCHANT_ROGUE_ACCOUNT]) if (payTo) list.push({ name: null, payTo });
  return list;
}

/**
 * The only key the public site holds: it writes merchant listings to Arkiv and nothing else, so it carries testnet
 * gas only. Unset, the listing desk is closed and listings are not read.
 */
export function registrar(): { key: `0x${string}`; address: `0x${string}` } | null {
  const k = process.env.LEASH_REGISTRAR_KEY?.trim();
  if (!k) return null;
  const key = (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;
  return { key, address: privateKeyToAccount(key).address };
}

type Listed = { key: string; name: string | null; payTo: string | null; source: "deployment" | "listed" | "registry"; endpoint?: "verified" | "none" };

/**
 * Every merchant in the registry: this deployment's own, then the merchants that listed themselves, then every payee
 * named in the newest report rows. A row or a listing only claims a payee and a name, so a name is kept only if its
 * ENS declaration still names that payee.
 */
export async function listMerchants(r: Reader): Promise<Listed[]> {
  const own = knownMerchants();
  const ownPayTo = new Set(own.map((m) => m.payTo).filter(Boolean));
  const out: Listed[] = own.map((m) => ({ key: m.name ?? m.payTo!, name: m.name, payTo: m.payTo ?? null, source: "deployment" }));
  const declared = await Promise.all(own.filter((m) => m.name).map((m) => r.ens.fetch(m.name!).then((d) => d?.payTo).catch(() => undefined)));
  for (const p of declared) if (p) ownPayTo.add(p);
  // The newest listing per name. One whose name now declares another payee is stale and dropped.
  const reg = registrar();
  const newest = new Map<string, ListingRow>();
  for (const l of reg ? await r.arkiv.listings(reg.address).catch(() => []) : []) {
    if (validName(l.ens) && validAccount(l.payee) && !newest.has(l.ens)) newest.set(l.ens, l);
  }
  const listings = [...newest.values()].slice(0, 30);
  const live = await Promise.all(listings.map((l) => r.ens.fetch(l.ens).then((d) => d?.payTo === l.payee).catch(() => false)));
  for (const [i, l] of listings.entries()) {
    if (!live[i]) continue;
    const mine = out.find((m) => m.name === l.ens); // one of this deployment's own merchants listed itself too
    if (mine) Object.assign(mine, { source: "listed", endpoint: l.endpoint });
    if (mine || ownPayTo.has(l.payee)) continue;
    ownPayTo.add(l.payee);
    out.push({ key: l.ens, name: l.ens, payTo: l.payee, source: "listed", endpoint: l.endpoint });
  }
  const rows = await r.arkiv.recentPayees().catch(() => []);
  for (const row of rows.filter((x) => validAccount(x.payee) && !ownPayTo.has(x.payee)).slice(0, 60)) {
    const claimed = validName(row.ens) ? row.ens : null;
    const name = claimed && (await r.ens.fetch(claimed).then((d) => d?.payTo === row.payee).catch(() => false)) ? claimed : null;
    out.push({ key: name ?? row.payee, name, payTo: row.payee, source: "registry" });
  }
  return out;
}

/** The risk a micro payment would carry, as 0 to 100 health in five levels that follow the decision bands (35, 70). */
export const HEALTH_REF_USD = 0.005;
export function healthOf(standing: string, v: StandingView | null) {
  const { R } = riskScore({ standing: standing as Standing, b: v?.bScore ?? 0, L: v?.L ?? 0, D: v?.D ?? 0, g: v?.g ?? 0, A: HEALTH_REF_USD, s: v?.strikes ?? 0, t: 0 });
  const blocked = standing === "BLOCKED";
  const level = blocked ? 1 : R < 20 ? 5 : R < 35 ? 4 : R < 50 ? 3 : R < 70 ? 2 : 1;
  const status = level >= 4 ? "good" : level === 3 ? "warning" : level === 2 ? "serious" : "critical";
  const label = blocked ? "Blocked" : ["", "Bad", "Risky", "Caution", "Good", "Excellent"][level]!;
  return { score: blocked ? 0 : Math.round(Math.max(0, 100 - R)), level, status, label, risk: Math.round(R * 10) / 10, refUsd: HEALTH_REF_USD };
}

export interface MerchantRow {
  key: string;
  name: string | null;
  payTo: string | null;
  declaration: ReturnType<typeof parseDeclaration>;
  standing: string;
  view: StandingView | null;
  health: ReturnType<typeof healthOf> | null;
  reports: { key?: string; outcome: string; txId: string; payer: string; amountUsd: number; reason: string; valid: boolean; why?: string; consensusTs: number; owner: string }[];
  probes: { key?: string; result: string; txId: string; consensusTs: number }[];
  rebuttals: { reason: string; filedAt: number; signer: string }[];
  error?: string;
}

export async function merchantRow(key: string, payToHint?: string, r: Reader = reader()): Promise<MerchantRow> {
  const now = Date.now() / 1000;
  const name = validName(key) ? key : null;
  const base: MerchantRow = { key, name, payTo: payToHint ?? (name ? null : key), declaration: null, standing: "UNKNOWN", view: null, health: null, reports: [], probes: [], rebuttals: [] };
  try {
    if (name) {
      base.declaration = await r.ens.fetch(name);
      base.payTo = base.declaration?.payTo ?? null;
    }
    if (!base.payTo) return base;
    const v = await r.read(base.payTo, now);
    base.view = v.view;
    base.standing = v.view.standing === "BLOCKED" || base.declaration ? v.view.standing : "UNKNOWN";
    base.health = healthOf(base.standing, v.view);
    // Structured fields only. Reason codes are written by guards, so only known shapes are shown.
    base.reports = v.rows.reports.map((x) => ({
      key: x.key, outcome: x.outcome, txId: x.txId, payer: x.payer, amountUsd: x.amountMicroUsd / 1e6,
      reason: /^[a-z-]{1,32}$/.test(x.reason) ? x.reason : "invalid", valid: x.valid, why: x.why, consensusTs: x.consensusTs, owner: x.owner,
    }));
    base.probes = v.rows.probes.map((x) => ({ key: x.key, result: x.result, txId: x.txId, consensusTs: x.consensusTs }));
    base.rebuttals = v.rows.rebuttals.map((x) => ({ reason: /^[a-z-]{1,32}$/.test(x.reason) ? x.reason : "invalid", filedAt: x.filedAt, signer: x.signer }));
  } catch (e) {
    base.error = safeError(e);
  }
  return base;
}

/** Wallets whose audit messages the live feed shows. The topic accepts anyone's messages, so others are ignored. */
export function auditAccounts(): Set<string> {
  const e = process.env;
  const ids = ["A", "B", "C", "F1", "F2"].map((l) => e[`AGENT_${l}_ACCOUNT`]).concat(e.PROBER_ACCOUNT, ...(e.LEASH_AUDIT_ACCOUNTS ?? "").split(","));
  return new Set(ids.filter((x): x is string => !!x && ACCOUNT_ID.test(x.trim())).map((x) => x.trim()));
}

/** Real agents for the demo page, operator machine only. SHOW_AGENTS=A:F1,B:F2 stands in aged wallets, as in show.ts. */
const agents = new Map<string, ReturnType<typeof buildAgent>>();
export function demoAgent(letter: string) {
  const stand = Object.fromEntries((process.env.SHOW_AGENTS ?? "").split(",").filter(Boolean).map((p) => p.split(":") as [string, string]));
  const id = stand[letter] ?? letter;
  let a = agents.get(id);
  if (!a) agents.set(id, (a = buildAgent(id, { ...process.env, LEASH_DB: ROOT_DB() })));
  return a;
}
