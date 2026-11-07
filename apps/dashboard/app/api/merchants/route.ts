import { NextResponse } from "next/server";
import { isAddress, isHex } from "viem";
import { normalize } from "viem/ens";
import { LEASH_KEYS, checkEndpoint, holdsTextRole, listingMessage, parseDeclaration, safeError, validName } from "@leash/guard";
import { reader, registrar } from "../../../lib/server";

export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const failed = (e: unknown) => json({ error: safeError(e) }, 502);
/** An older signature is refused, so it cannot list a policy its owner has since replaced. */
const FRESH_SEC = 600;

/** The name's resolver and its live leash.* records, read straight from Sepolia. */
async function lookup(r: ReturnType<typeof reader>, ens: string) {
  const name = normalize(ens);
  const resolver = await r.client.getEnsResolver({ name }).catch(() => null);
  const values = await Promise.all(LEASH_KEYS.map((key) => r.client.getEnsText({ name, key }).catch(() => null)));
  const records = Object.fromEntries(LEASH_KEYS.map((k, i) => [k, values[i] ?? null]));
  return { resolver: resolver && !/^0x0{40}$/.test(resolver) ? resolver : null, records, declaration: parseDeclaration(records) };
}

/** Can this wallet set the name's Leash policy? Plus the policy as it stands, and the exact text to sign for it. */
export async function GET(req: Request) {
  try {
    const q = new URL(req.url).searchParams;
    const ens = (q.get("ens") ?? "").trim().toLowerCase();
    const address = q.get("address") ?? "";
    if (!validName(ens)) return json({ error: "Enter an ENS name such as yourshop.eth" }, 400);
    const r = reader(q.get("ns") ?? undefined);
    const { resolver, records, declaration } = await lookup(r, ens);
    if (!resolver) return json({ error: `${ens} has no resolver on Sepolia. Register the name and set a resolver first.` }, 404);
    const canWrite = isAddress(address) && (await holdsTextRole(r.client, resolver, address, "leash.payTo").catch(() => false));
    const signedAt = Math.floor(Date.now() / 1000);
    const message = declaration && listingMessage({ ns: r.ns, ens, payee: declaration.payTo, policyVersion: declaration.policyVersion, signedAt });
    const reg = registrar();
    const listed = reg ? ((await r.arkiv.listings(reg.address).catch(() => [])).find((l) => l.ens === ens) ?? null) : null;
    return json({ ens, ns: r.ns, resolver, records, declaration, canWrite, message, signedAt, listed, open: !!reg, testnet: { network: "hedera:testnet", asset: r.usdc } });
  } catch (e) {
    return failed(e);
  }
}

/**
 * Lists a merchant. The wallet must hold the text role on the name's resolver and sign the policy as it stands on
 * ENS now; a declared endpoint must answer 402 for that same policy. Only then does the registrar write to Arkiv.
 */
export async function POST(req: Request) {
  try {
    const reg = registrar();
    if (!reg) return json({ error: "The listing desk is closed on this deployment" }, 503);
    const b = (await req.json().catch(() => ({}))) as { ens?: unknown; address?: unknown; signedAt?: unknown; signature?: unknown; ns?: unknown };
    const ens = String(b.ens ?? "").trim().toLowerCase();
    const { address, signature, signedAt } = b;
    if (!validName(ens) || typeof address !== "string" || !isAddress(address) || typeof signature !== "string" || !isHex(signature) || !Number.isInteger(signedAt)) {
      return json({ error: "ens, address, signedAt and signature are required" }, 400);
    }
    if (Math.abs(Date.now() / 1000 - (signedAt as number)) > FRESH_SEC) return json({ error: "That signature has expired. Sign again." }, 400);
    const r = reader(typeof b.ns === "string" ? b.ns : undefined);
    const { resolver, declaration: d } = await lookup(r, ens);
    if (!resolver || !d) return json({ error: `${ens} declares no Leash policy: leash.payTo must be a Hedera account id such as 0.0.123456` }, 422);
    if (d.network !== "hedera:testnet" || d.asset !== r.usdc) return json({ error: `This registry lists Hedera testnet merchants paid in USDC ${r.usdc} only` }, 422);
    if (!(d.maxPriceUsd > 0)) return json({ error: "leash.maxPrice must be a price in USD above 0" }, 422);
    const message = listingMessage({ ns: r.ns, ens, payee: d.payTo, policyVersion: d.policyVersion, signedAt: signedAt as number });
    // Through the client, so a smart-contract wallet's signature verifies too.
    if (!(await r.client.verifyMessage({ address, message, signature }).catch(() => false))) {
      return json({ error: "The signature does not match this wallet and the policy now on ENS. Sign again." }, 403);
    }
    if (!(await holdsTextRole(r.client, resolver, address, "leash.payTo").catch(() => false))) {
      return json({ error: `This wallet cannot set records on ${ens}, so it cannot list it` }, 403);
    }
    const endpoint = d.probeUrl ? await checkEndpoint(ens, d) : null;
    if (endpoint && !endpoint.ok) return json({ error: `Endpoint check failed: ${endpoint.why}` }, 422);
    const row = { ens, payee: d.payTo, policyVersion: d.policyVersion, endpoint: endpoint ? ("verified" as const) : ("none" as const), signedAt: signedAt as number, signer: address, signature };
    // The same policy is listed once; a new policy version is a new listing.
    const same = (await r.arkiv.listings(reg.address)).find((l) => l.ens === ens && l.payee === d.payTo && l.policyVersion === d.policyVersion);
    if (same) return json({ status: "listed", existing: true, entityKey: same.key, ns: r.ns, endpoint: same.endpoint });
    const { entityKey, txHash } = await r.arkiv.writeListing(reg.key, row, r.params.reportTtlSec);
    return json({ status: "listed", entityKey, txHash, ns: r.ns, endpoint: row.endpoint, priceUsd: endpoint?.ok ? endpoint.amountUsd : null });
  } catch (e) {
    return failed(e);
  }
}
