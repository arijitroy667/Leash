import { NextResponse } from "next/server";
import { originOf, payeesForDomain, validName } from "@leash/guard";
import { ACCOUNT_ID, knownMerchants, merchantRow, namespaces, reader } from "../../../lib/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const key = q.get("key")?.trim();
  const r = reader(q.get("ns") ?? undefined);
  const base = { now: Date.now() / 1000, profile: r.params.name, namespace: r.ns, namespaces: namespaces() };
  // Arkiv's keyless endpoint is rate limited, so the CDN answers repeat lookups for 5 seconds.
  const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "public, s-maxage=5, stale-while-revalidate=10" } });
  const known = () => Promise.all(knownMerchants().map((m) => merchantRow(m.name ?? m.payTo!, m.payTo, r)));
  if (!key) return json({ ...base, merchants: await known() });
  if (ACCOUNT_ID.test(key) || (validName(key) && key.endsWith(".eth"))) return json({ ...base, merchants: [await merchantRow(key, undefined, r)] });
  const origin = originOf(key);
  if (origin) {
    const listed = (await known()).filter((m) => m.declaration?.domains.includes(origin));
    if (listed.length) return json({ ...base, merchants: listed });
    const hits = await payeesForDomain(r.arkiv, r.ens, origin).catch(() => []);
    return json({ ...base, merchants: await Promise.all(hits.map((h) => merchantRow(h.name ?? h.payTo, h.payTo, r))) });
  }
  return json({ ...base, error: "Enter an ENS name, a domain or a Hedera account id" }, 400);
}
