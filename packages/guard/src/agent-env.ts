import { PrivateKey } from "@hiero-ledger/sdk";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { createHerdGuard } from "./guard.ts";

const hex = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;

/** Builds a real payment client for one wallet from the environment. */
export function rawClient(account: string, key: string) {
  const signer = createClientHederaSigner(account, PrivateKey.fromStringECDSA(key), { network: "hedera:testnet" });
  return new x402Client().register("hedera:*" as never, new ExactHederaScheme(signer));
}

export function buildAgent(letter: string, env: NodeJS.ProcessEnv = process.env) {
  const account = env[`AGENT_${letter}_ACCOUNT`];
  const key = env[`AGENT_${letter}_KEY`];
  if (!account || !key) throw new Error(`AGENT_${letter} is missing. Run pnpm wallets:create`);
  const guard = createHerdGuard({
    agent: `agent-${letter.toLowerCase()}`,
    hederaAccount: account,
    hederaKey: key,
    ownerAddress: env.HERD_OWNER_ADDRESS as `0x${string}`,
    arkivAccessKey: env.ARKIV_ACCESS_KEY ?? "",
    arkivRpcUrl: env.ARKIV_RPC_URL,
    namespace: env.HERD_NAMESPACE ?? "dev",
    policyProfile: (env.HERD_POLICY_PROFILE ?? "production") as "live" | "production",
    sepoliaRpcUrl: env.SEPOLIA_RPC_URL,
    mirrorUrl: env.MIRROR_URL,
    usdc: env.HEDERA_USDC ?? "0.0.429274",
    hcsTopicId: env.HCS_TOPIC_ID,
    dbPath: env.HERD_DB ?? ".herd/herd.sqlite",
    proberAddresses: env.PROBER_KEY ? [privateKeyToAccount(hex(env.PROBER_KEY)).address] : [],
  });
  const client = rawClient(account, key);
  guard.attach(client as never);
  return { guard, client, paidFetch: guard.guardedFetch(wrapFetchWithPayment(fetch, client)) };
}
