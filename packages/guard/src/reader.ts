import { AccountId, Client, PrivateKey, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import { createPublicClient, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { DEFAULT_LIVE_BLOCK_SEC, DEFAULT_LIVE_DAY_SEC, PROFILES, liveProfile, replay, type PolicyParams } from "@leash/core";
import { Arkiv } from "./arkiv.ts";
import { Ens } from "./ens.ts";
import { PUBLIC_FUNDERS, readVerifiedEvidence, verifyRebuttalRow } from "./evidence.ts";
import { Mirror } from "./mirror.ts";
import { safeError, Store } from "./store.ts";

const hex = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;

/**
 * The policy from the environment. Only the live profile can be tuned: LEASH_LIVE_BLOCK_SEC is the block length per
 * strike and LEASH_LIVE_DAY_SEC is the length of a policy day. Production always uses the PRD's durations.
 */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): PolicyParams {
  const profile = env.LEASH_POLICY_PROFILE || "production";
  if (profile === "production") return PROFILES.production;
  if (profile !== "live") throw new RangeError(`LEASH_POLICY_PROFILE must be production or live, not ${profile}`);
  const day = env.LEASH_LIVE_DAY_SEC?.trim() ? Number(env.LEASH_LIVE_DAY_SEC) : DEFAULT_LIVE_DAY_SEC;
  const blocks = env.LEASH_LIVE_BLOCK_SEC?.trim() ? env.LEASH_LIVE_BLOCK_SEC.split(",").map((v) => (v.trim() ? Number(v) : NaN)) : DEFAULT_LIVE_BLOCK_SEC;
  return liveProfile(day, blocks);
}

/** One honest evidence reader for scripts and pages. */
export function buildReader(env: NodeJS.ProcessEnv = process.env) {
  const params = policyFromEnv(env);
  const usdc = env.HEDERA_USDC ?? "0.0.429274";
  const ns = env.LEASH_NAMESPACE ?? "dev";
  const store = new Store(env.LEASH_DB ?? ".leash/leash.sqlite");
  const mirror = new Mirror(env.MIRROR_URL ?? "https://testnet.mirrornode.hedera.com", usdc, store);
  const arkiv = new Arkiv(env.ARKIV_ACCESS_KEY ?? "", ns, env.ARKIV_RPC_URL);
  const ens = new Ens(env.SEPOLIA_RPC_URL, store, params);
  const client = createPublicClient({ chain: sepolia, transport: http(env.SEPOLIA_RPC_URL) }) as PublicClient;
  // The public explorer holds no keys, so it takes the prober's address instead.
  const prober = env.PROBER_KEY ? privateKeyToAccount(hex(env.PROBER_KEY)).address : env.PROBER_ADDRESS;
  const proberOwners = new Set(prober ? [prober.toLowerCase()] : []);
  const read = async (payee: string, now: number) => {
    const v = await readVerifiedEvidence({
      arkiv, mirror, ns, payee, usdc, publicFunders: new Set(PUBLIC_FUNDERS), proberOwners,
      badPerPayeeWindowSec: params.badPerPayeeWindowSec,
      verifyRebuttal: (r) => verifyRebuttalRow(r, ns, ens, client),
    });
    return { ...v, view: replay(v.evidence, now, params) };
  };

  /** Rebuttals and probes go to the audit topic too. The outbox keeps them if HCS is down. */
  const audit = (type: "rebuttal" | "probe", dedupe: string, body: Record<string, unknown>) => {
    if (env.HCS_TOPIC_ID) store.enqueue("hcs", `hcs:${type}:${dedupe}`, { type, ...body });
  };
  let hcs: Client | undefined;
  async function flushAudit() {
    if (!env.HCS_TOPIC_ID || !env.PROBER_ACCOUNT || !env.PROBER_KEY) return;
    const now = Date.now() / 1000;
    for (const item of store.dueOutbox(now, 25)) {
      if (item.kind !== "hcs" || !store.claimOutbox(item.id, now)) continue;
      try {
        hcs ??= Client.forTestnet().setOperator(AccountId.fromString(env.PROBER_ACCOUNT), PrivateKey.fromStringECDSA(env.PROBER_KEY));
        await new TopicMessageSubmitTransaction().setTopicId(env.HCS_TOPIC_ID).setMessage(JSON.stringify(item.payload)).execute(hcs);
        store.setHealth("hcs", true, now);
        store.outboxDone(item.id);
      } catch (e) {
        store.setHealth("hcs", false, now, safeError(e));
        store.outboxRetry(item.id, item.attempts, now);
      }
    }
  }
  return { params, usdc, ns, store, mirror, arkiv, ens, client, prober, read, audit, flushAudit };
}

