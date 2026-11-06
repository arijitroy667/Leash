import { NextResponse } from "next/server";
import { keccak256, parseAbi, toBytes } from "viem";
import { normalize } from "viem/ens";
import { DEFAULT_LIMITS, HARD_CAP_MULTIPLE, policySummary, SOFT_CAPS } from "@leash/core";
import { LEASH_KEYS, ROLE_SET_TEXT, safeError, validAccount, validName } from "@leash/guard";
import { auditAccounts, knownMerchants, namespaces, reader } from "../../../lib/server";

export const dynamic = "force-dynamic";

/** Public: the rebuttal wallet that holds ROLE_SET_TEXT on lemon's resolver for the leash.rebuttal key (README). */
const REBUTTAL_SIGNER = (process.env.LEASH_REBUTTAL_SIGNER ?? "0xa51B1B8EC0608FA2DafEC4E3D5D67a7348C0B5d7") as `0x${string}`;
const ROLES = parseAbi(["function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool)"]);
const MERCHANTS = ["weather", "lemon", "spoof", "rogue"] as const;
const merchantUrl = (m: string) => process.env[`MERCHANT_${m.toUpperCase()}_URL`] ?? `https://leash-merchant-${m}.vercel.app`;
const str = (x: any) => String(x?.value ?? "");
const num = (x: any) => Number(x?.value ?? 0);
const timed = async <T,>(f: () => Promise<T>) => {
  const t = performance.now();
  try {
    return { value: await f(), ms: Math.round(performance.now() - t) };
  } catch (e) {
    return { value: null, ms: Math.round(performance.now() - t), error: safeError(e) };
  }
};

/** Every write in the registry, each linked to its entity (and so its create transaction) on the Rabdi explorer. */
async function arkiv(r: ReturnType<typeof reader>) {
  const [reports, probes, rebuttals, block] = await Promise.all([
    r.arkiv.recent("report"), r.arkiv.recent("probe"), r.arkiv.recent("rebuttal"), r.arkiv.blockNumber().then(Number),
  ]);
  const base = (e: any) => ({ key: String(e.$key), creator: String(e.$creator), owner: String(e.$owner), createdBlock: Number(e.$createdAt), expiresInSec: Math.max(0, (Number(e.$expiresAt) - block) * 2) });
  const writes = [
    ...reports.map((e) => ({ ...base(e), kind: "report", payee: str(e.payee), ens: validName(str(e.ens)) ? str(e.ens) : null, outcome: str(e.outcome), txId: str(e.txId), payer: str(e.payer), amountUsd: num(e.amountMicroUsd) / 1e6, at: num(e.consensusTs) })),
    ...probes.map((e) => ({ ...base(e), kind: "probe", payee: str(e.payee), ens: null, outcome: str(e.result), txId: str(e.txId), payer: null, amountUsd: num(e.amountMicroUsd) / 1e6, at: num(e.consensusTs) })),
    ...rebuttals.map((e) => ({ ...base(e), kind: "rebuttal", payee: str(e.payee), ens: validName(str(e.ens)) ? str(e.ens) : null, outcome: /^[a-z-]{1,32}$/.test(str(e.reason)) ? str(e.reason) : "invalid", txId: null, payer: null, amountUsd: 0, at: num(e.filedAt) })),
  ].filter((w) => validAccount(w.payee)).sort((a, b) => b.at - a.at);

  // The reads the guard makes before a payment, run now against the weather merchant. Reads cost nothing and write no transaction.
  const weather = knownMerchants().find((m) => m.name?.includes("weather"))?.name;
  const decl = weather ? await r.ens.fetch(weather).catch(() => null) : null;
  const payee = decl?.payTo ?? writes[0]?.payee ?? "0.0.0";
  const payer = writes.find((w) => w.kind === "report")?.payer ?? "0.0.0";
  const origin = decl?.domains[0] ?? "";
  const ns = r.ns;
  const q = [
    { what: "Reports for this payee, newest first", when: "Before every payment", query: `leash.report  ns = '${ns}' AND payee = '${payee}' AND consensusTs <= now  ORDER BY consensusTs DESC`, run: () => r.arkiv.reports(payee).then((x) => x.length) },
    { what: "Probes by the allow-listed prober only", when: "Before every payment", query: `leash.probe  ns = '${ns}' AND payee = '${payee}' AND $creator = ${r.prober ?? "prober"}  ORDER BY consensusTs DESC`, run: () => r.arkiv.probes(payee, r.prober ? [r.prober] : []).then((x) => x.length) },
    { what: "Rebuttals for this payee", when: "Before every payment", query: `leash.rebuttal  ns = '${ns}' AND payee = '${payee}'  ORDER BY filedAt DESC`, run: () => r.arkiv.rebuttals(payee).then((x) => x.length) },
    { what: "One reporter's bad reports, for the daily limit", when: "While verifying each bad report", query: `leash.report  ns = '${ns}' AND payer = '${payer}' AND outcome = 'bad'  ORDER BY consensusTs DESC`, run: () => r.arkiv.badReportsByPayer(payer).then((x) => x.length) },
    { what: "Reports naming a domain", when: "Explorer lookup by domain", query: `leash.report  ns = '${ns}' AND domain = '${origin}'  ORDER BY consensusTs DESC`, run: () => r.arkiv.reportsByDomain(origin).then((x) => x.length) },
    { what: "Has this writer already filed this payment?", when: "Before writing a report (no duplicates)", query: `leash.report  ns = '${ns}' AND txId = '<txId>' AND $creator = <writer>  LIMIT 1`, run: async () => (writes[0]?.txId ? Number(await r.arkiv.hasReport(writes[0].txId, writes[0].creator)) : 0) },
    { what: "Live entity counts", when: "Explorer summary", query: `COUNT leash.report | leash.probe | leash.rebuttal  WHERE ns = '${ns}'`, run: () => r.arkiv.counts().then((c) => c.reports + c.probes + c.rebuttals) },
  ];
  const queries = await Promise.all(q.map(async ({ run, ...x }) => {
    const t = await timed(run);
    return { ...x, rows: t.value, ms: t.ms, error: t.error };
  }));
  return { block, writes, queries, writers: [...new Set(writes.map((w) => w.creator))] };
}

/** Each merchant's payment declaration, read live from its own Permissioned Resolver, and who may edit which key. */
async function ens(r: ReturnType<typeof reader>) {
  const names = knownMerchants().filter((m) => m.name).map((m) => m.name!);
  const keys = [...LEASH_KEYS, "leash.rebuttal"];
  const records = await Promise.all(names.map(async (name) => {
    const n = normalize(name);
    const [resolver, vals] = await Promise.all([
      r.client.getEnsResolver({ name: n }),
      Promise.all(keys.map((key) => r.client.getEnsText({ name: n, key }).catch(() => null))),
    ]);
    const roles = await Promise.all(["leash.rebuttal", "leash.payTo", "leash.maxPrice"].map(async (key) => ({
      key,
      allowed: await r.client.readContract({ address: resolver, abi: ROLES, functionName: "hasRoles", args: [BigInt(keccak256(toBytes(key))), ROLE_SET_TEXT, REBUTTAL_SIGNER] }).catch(() => null),
    })));
    return { name, resolver, records: keys.map((key, i) => ({ key, value: vals[i] ? String(vals[i]).slice(0, 200) : null })), roles };
  }));

  // What each merchant says about itself, against what ENS says. A merchant that claims a name it is not paid for is denied.
  const declared = new Map(records.map((x) => [x.name, x.records.find((k) => k.key === "leash.payTo")?.value]));
  const claims = await Promise.all(MERCHANTS.map(async (m) => {
    try {
      const j = await fetch(merchantUrl(m), { signal: AbortSignal.timeout(8000), cache: "no-store" }).then((x) => x.json());
      const claim = validName(j.claim) ? j.claim : null;
      const payTo = validAccount(j.payTo) ? j.payTo : null;
      const ensPayTo = claim ? (declared.get(claim) ?? (await r.ens.fetch(claim).catch(() => null))?.payTo ?? null) : null;
      return { merchant: m, claim, payTo, ensPayTo, verdict: !claim ? "no-name" : ensPayTo === payTo ? "match" : "mismatch" };
    } catch (e) {
      return { merchant: m, claim: null, payTo: null, ensPayTo: null, verdict: "unreachable", error: safeError(e) };
    }
  }));
  return { signer: REBUTTAL_SIGNER, records, claims };
}

function hedera(r: ReturnType<typeof reader>) {
  return {
    topic: process.env.HCS_TOPIC_ID ?? null,
    usdc: r.usdc,
    facilitator: process.env.FACILITATOR_ACCOUNT ?? "0.0.7162784",
    accounts: [...auditAccounts()],
    policy: policySummary(r.params),
    limits: { ...DEFAULT_LIMITS, softCaps: SOFT_CAPS, hardCapMultiple: HARD_CAP_MULTIPLE },
  };
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const r = reader(q.get("ns") ?? undefined);
  const t = q.get("t");
  const base = { namespace: r.ns, namespaces: namespaces(), profile: r.params.name };
  const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "public, s-maxage=10, stale-while-revalidate=30" } });
  try {
    if (t === "arkiv") return json({ ...base, ...(await arkiv(r)) });
    if (t === "ens") return json({ ...base, ...(await ens(r)) });
    if (t === "hedera") {
      // Payments are the Hedera transactions that reports and probes point to; each is re-checked on Mirror Node by every reader.
      const [reports, probes] = await Promise.all([r.arkiv.recent("report"), r.arkiv.recent("probe")]);
      const pay = (kind: string, outcome: string) => (e: any) => ({ kind, outcome, ens: validName(str(e.ens)) ? str(e.ens) : null, txId: str(e.txId), payer: str(e.payer) || null, payee: str(e.payee), amountUsd: num(e.amountMicroUsd) / 1e6, at: num(e.consensusTs) });
      const payments = [...reports.map((e) => pay("report", str(e.outcome))(e)), ...probes.map((e) => pay("probe", str(e.result))(e))]
        .filter((p) => /^0\.0\.\d{1,12}@\d{1,12}\.\d{1,9}$/.test(p.txId) && validAccount(p.payee))
        .sort((a, b) => b.at - a.at);
      return json({ ...base, ...hedera(r), payments });
    }
    return json({ ...base, error: "t must be hedera, arkiv or ens" }, 400);
  } catch (e) {
    return json({ ...base, error: safeError(e) }, 502);
  }
}
