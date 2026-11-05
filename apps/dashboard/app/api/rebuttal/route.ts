import { NextResponse } from "next/server";
import { normalize } from "viem/ens";
import { REBUTTAL_REASONS, digest, holdsRebuttalRole, rebuttalMessage, safeError, verifyRebuttalSignature } from "@leash/guard";
import { PUBLIC_MODE, reader } from "../../../lib/server";

const hex = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;
/** A network error quotes its RPC url, which can carry a key, so it is cleaned here rather than thrown to the server log. */
const failed = (e: unknown) => NextResponse.json({ error: safeError(e) }, { status: 502 });
export const POST = (req: Request) => file(req).catch(failed);
export const GET = (req: Request) => message(req).catch(failed);
/** Only the hash is ever stored: a rebuttal shows others a reason code and a time, never free text. */
const evidenceHash = (reason: string, filedAt: number, evidence?: string | null) => digest(evidence?.trim().slice(0, 500) || `${reason}:${filedAt}`);

/** Filed by the holder of the merchant's leash.rebuttal role. It only queues a probe; it never unblocks. */
async function file(req: Request) {
  if (PUBLIC_MODE) return NextResponse.json({ error: "rebuttal desk is not public" }, { status: 403 });
  const b = (await req.json()) as { ens: string; reason: string; filedAt: number; signer: `0x${string}`; signature: string; evidence?: string };
  if (!REBUTTAL_REASONS.includes(b.reason as never)) return NextResponse.json({ error: "unknown reason" }, { status: 400 });

  const r = reader();
  const decl = await r.ens.fetch(b.ens);
  if (!decl) return NextResponse.json({ error: "name has no declaration" }, { status: 404 });

  const { view } = await r.read(decl.payTo, Date.now() / 1000);
  const row = { owner: "", payee: decl.payTo, ens: b.ens, reason: b.reason, evidenceHash: evidenceHash(b.reason, b.filedAt, b.evidence), filedAt: b.filedAt, signer: b.signer, signature: b.signature, episodeStart: view.blockStart ?? 0 };
  if (!(await verifyRebuttalSignature(r.ns, row).catch(() => false))) return NextResponse.json({ error: "bad signature" }, { status: 403 });
  const resolver = await r.client.getEnsResolver({ name: normalize(b.ens) });
  if (!(await holdsRebuttalRole(r.client, resolver, b.signer))) {
    return NextResponse.json({ error: "this wallet holds no role on the merchant's resolver" }, { status: 403 });
  }
  const { entityKey } = await r.arkiv.writeRebuttal(hex(process.env.PROBER_KEY!), row, r.params.reportTtlSec);
  r.audit("rebuttal", entityKey, { payee: decl.payTo, ens: b.ens, reason: b.reason, signer: b.signer, entityKey, at: b.filedAt });
  void r.flushAudit();
  return NextResponse.json({ status: "filed", entityKey });
}

/** The exact text the wallet must sign. */
async function message(req: Request) {
  if (PUBLIC_MODE) return NextResponse.json({ error: "rebuttal desk is not public" }, { status: 403 });
  const u = new URL(req.url);
  const ens = u.searchParams.get("ens") ?? "";
  const reason = u.searchParams.get("reason") ?? "";
  const filedAt = Number(u.searchParams.get("filedAt"));
  const r = reader();
  const decl = await r.ens.fetch(ens);
  if (!decl) return NextResponse.json({ error: "name has no declaration" }, { status: 404 });
  return NextResponse.json({ message: rebuttalMessage({ ns: r.ns, ens, payee: decl.payTo, reason, evidenceHash: evidenceHash(reason, filedAt, u.searchParams.get("evidence")), filedAt }) });
}
