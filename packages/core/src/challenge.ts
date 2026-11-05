import { createHash } from "node:crypto";
import type { Challenge } from "./types.ts";

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export function normalizeUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = "";
  u.searchParams.sort();
  return u.toString();
}

export function challengeHash(c: Challenge): string {
  const body = canonical({
    scheme: c.scheme, network: c.network, asset: c.asset, amountUsd: c.amountUsd, payTo: c.payTo,
    resource: normalizeUrl(c.resourceUrl), maxTimeoutSeconds: c.maxTimeoutSeconds, extra: c.extra ?? {},
  });
  return createHash("sha256").update(body).digest("hex");
}
