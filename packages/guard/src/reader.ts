import { createPublicClient, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { normalize } from "viem/ens";
import { PROFILES, replay } from "@herd/core";
import { Arkiv } from "./arkiv.ts";
import { Ens } from "./ens.ts";
import { PUBLIC_FUNDERS, holdsRebuttalRole, readVerifiedEvidence, verifyRebuttalSignature } from "./evidence.ts";
import { Mirror } from "./mirror.ts";
import { Store } from "./store.ts";

const hex = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;

/** One honest evidence reader for scripts and pages. */
export function buildReader(env: NodeJS.ProcessEnv = process.env) {
  const params = PROFILES[(env.HERD_POLICY_PROFILE ?? "production") as "live" | "production"];
  const usdc = env.HEDERA_USDC ?? "0.0.429274";
  const ns = env.HERD_NAMESPACE ?? "dev";
  const store = new Store(env.HERD_DB ?? ".herd/herd.sqlite");
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
      verifyRebuttal: async (r) => {
        if (!(await verifyRebuttalSignature(ns, r))) return false;
        return holdsRebuttalRole(client, await client.getEnsResolver({ name: normalize(r.ens) }), r.signer as `0x${string}`);
      },
    });
    return { ...v, view: replay(v.evidence, now, params) };
  };
  return { params, usdc, ns, store, mirror, arkiv, ens, client, read };
}

