import { createPublicClient, http, type PublicClient } from "viem";
import { sepolia } from "viem/chains";
import { normalize } from "viem/ens";
import type { Declaration, PolicyParams } from "@herd/core";
import type { Store } from "./store.ts";

export const HERD_KEYS = ["herd.payTo", "herd.network", "herd.asset", "herd.maxPrice", "herd.domains", "herd.schema", "herd.probeUrl", "herd.policyVersion"] as const;

// The last label must start with a letter, so a Hedera account id such as 0.0.123 is never a name.
const NAME = /^([a-z0-9-]+\.)+[a-z][a-z0-9-]*$/;

/** Merchant-supplied, so validated before it goes anywhere. */
export const validName = (n: unknown): n is string => typeof n === "string" && n.length <= 255 && NAME.test(n);

export function parseDeclaration(rec: Record<string, string | null>): Declaration | null {
  const payTo = rec["herd.payTo"];
  if (!payTo) return null;
  const list = (v: string | null | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    payTo,
    network: rec["herd.network"] ?? "",
    asset: rec["herd.asset"] ?? "",
    maxPriceUsd: Number(rec["herd.maxPrice"] ?? 0),
    domains: list(rec["herd.domains"]),
    schema: list(rec["herd.schema"]),
    probeUrl: rec["herd.probeUrl"] ?? undefined,
    policyVersion: Number(rec["herd.policyVersion"] ?? 0),
  };
}

export type DeclarationResult = { status: "fresh" | "stale" | "none"; value?: Declaration; fetchedAt?: number; outage?: boolean };

export class Ens {
  private client: PublicClient;
  constructor(rpcUrl: string | undefined, private store: Store, private params: PolicyParams, private timeoutMs = 4000) {
    this.client = createPublicClient({ chain: sepolia, transport: http(rpcUrl, { timeout: timeoutMs }) }) as PublicClient;
  }

  async fetch(name: string): Promise<Declaration | null> {
    const n = normalize(name);
    const vals = await Promise.all(HERD_KEYS.map((key) => this.client.getEnsText({ name: n, key })));
    return parseDeclaration(Object.fromEntries(HERD_KEYS.map((k, i) => [k, vals[i] ?? null])));
  }

  /** Follows the staleness table in PRD section 12. */
  async resolve(name: string | null, now: number): Promise<DeclarationResult> {
    if (!name) return { status: "none" };
    const cached = this.store.policyGet(name);
    if (cached && now - cached.fetchedAt <= this.params.ensFreshSec) {
      return cached.value ? { status: "fresh", value: cached.value, fetchedAt: cached.fetchedAt } : { status: "none" };
    }
    try {
      const value = await this.fetch(name);
      this.store.policyPut(name, value, now);
      this.store.setHealth("ens", true, now);
      return value ? { status: "fresh", value, fetchedAt: now } : { status: "none" };
    } catch (e) {
      this.store.setHealth("ens", false, now, String(e).slice(0, 120));
      if (cached?.value && now - cached.fetchedAt <= this.params.ensStaleSec) {
        return { status: "stale", value: cached.value, fetchedAt: cached.fetchedAt };
      }
      return { status: "none", outage: true };
    }
  }
}
