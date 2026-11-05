import { PrivateKey } from "@hiero-ledger/sdk";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { createLeashGuard } from "./guard.ts";

const hex = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;

/**
 * Builds a real payment client for one wallet. Its own spend controls are off because they reject a challenge before
 * any hook sees it, which would leave a worthless token or an oversized price with no decision, reason or audit.
 * The guard or the prober's hook is the spend control. USDC is chosen when a merchant offers several assets.
 */
export function rawClient(account: string, key: string, usdc = "0.0.429274") {
  const signer = createClientHederaSigner(account, PrivateKey.fromStringECDSA(key), { network: "hedera:testnet" });
  const client = new x402Client((_version, requirements) => requirements.find((r) => r.asset === usdc) ?? requirements[0]!);
  client.setSpendControls({ allowedAssets: true, maxAmountPerPayment: false });
  return client.register("hedera:*" as never, new ExactHederaScheme(signer));
}

export function buildAgent(letter: string, env: NodeJS.ProcessEnv = process.env) {
  const account = env[`AGENT_${letter}_ACCOUNT`];
  const key = env[`AGENT_${letter}_KEY`];
  if (!account || !key) throw new Error(`AGENT_${letter} is missing. Run pnpm wallets:create`);
  const guard = createLeashGuard({
    agent: `agent-${letter.toLowerCase()}`,
    hederaAccount: account,
    hederaKey: key,
    ownerAddress: env.LEASH_OWNER_ADDRESS as `0x${string}`,
    arkivAccessKey: env.ARKIV_ACCESS_KEY ?? "",
    arkivRpcUrl: env.ARKIV_RPC_URL,
    namespace: env.LEASH_NAMESPACE ?? "dev",
    policyProfile: (env.LEASH_POLICY_PROFILE ?? "production") as "live" | "production",
    sepoliaRpcUrl: env.SEPOLIA_RPC_URL,
    mirrorUrl: env.MIRROR_URL,
    usdc: env.HEDERA_USDC ?? "0.0.429274",
    hcsTopicId: env.HCS_TOPIC_ID,
    dbPath: env.LEASH_DB ?? ".leash/leash.sqlite",
    proberAddresses: env.PROBER_KEY ? [privateKeyToAccount(hex(env.PROBER_KEY)).address] : [],
  });
  const client = rawClient(account, key, env.HEDERA_USDC);
  guard.attach(client as never);
  return { guard, client, paidFetch: guard.guardedFetch(wrapFetchWithPayment(fetch, client)) };
}
