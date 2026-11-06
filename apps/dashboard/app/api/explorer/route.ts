import { NextResponse } from "next/server";
import { policySummary } from "@leash/core";
import { originOf, payeesForDomain, safeError, validName } from "@leash/guard";
import { ACCOUNT_ID, HEALTH_REF_USD, knownMerchants, listMerchants, merchantRow, namespaces, reader } from "../../../lib/server";

export const dynamic = "force-dynamic";

/**
 * Read-only and public. No key: every merchant in the registry, as a light list. `key`: full verified detail for an
 * ENS name, domain or account. `summary`: live entity counts. Each detail is a verified read, so the page loads them
 * one card at a time as they scroll into view.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const r = reader(q.get("ns") ?? undefined);
  const base = { now: Date.now() / 1000, profile: r.params.name, policyNote: policySummary(r.params), namespace: r.ns, namespaces: namespaces(), healthRefUsd: HEALTH_REF_USD };
  // Arkiv's keyless endpoint is rate limited, so the CDN answers repeat lookups for a few seconds.
  const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "public, s-maxage=4, stale-while-revalidate=10" } });
  try {
    if (q.has("summary")) {
      const [counts, list] = await Promise.all([r.arkiv.counts(), listMerchants(r)]);
      return json({ ...base, counts, merchants: list.length });
    }
    const key = q.get("key")?.trim();
    if (!key) return json({ ...base, list: await listMerchants(r) });
    if (ACCOUNT_ID.test(key) || (validName(key) && key.endsWith(".eth"))) return json({ ...base, merchants: [await merchantRow(key, undefined, r)] });
    const origin = originOf(key);
    if (origin) {
      const own = await Promise.all(knownMerchants().map((m) => merchantRow(m.name ?? m.payTo!, m.payTo, r)));
      const listed = own.filter((m) => m.declaration?.domains.includes(origin));
      if (listed.length) return json({ ...base, merchants: listed });
      const hits = await payeesForDomain(r.arkiv, r.ens, origin).catch(() => []);
      return json({ ...base, merchants: await Promise.all(hits.map((h) => merchantRow(h.name ?? h.payTo, h.payTo, r))) });
    }
    return json({ ...base, error: "Enter an ENS name, a domain or a Hedera account id" }, 400);
  } catch (e) {
    return json({ ...base, error: safeError(e) }, 502);
  }
}
