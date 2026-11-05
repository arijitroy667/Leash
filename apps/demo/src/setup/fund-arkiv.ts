// Splits tGLM from whichever wallet holds the most, so the faucet only has to fund one address.
// Also writes AGENT_F1 and AGENT_F2: the aged funder accounts, used to rehearse a real block before
// the agents turn 24 hours old. Prints no secrets.
import "dotenv/config";
import { appendFileSync } from "node:fs";
import { createPublicClient, createWalletClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { formatEther, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const env = process.env;
const hex = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;
const chain = rabdi({ accessKey: env.ARKIV_ACCESS_KEY ?? "" });
const pub = createPublicClient({ chain, transport: http() });
const TARGET = parseEther(env.TGLM_TARGET ?? "1");

for (const n of [1, 2]) {
  if (env[`AGENT_F${n}_ACCOUNT`]) continue;
  const raw = env[`FUNDER_${n}_ACCOUNT`]!;
  const r = await fetch(`${env.MIRROR_URL}/api/v1/accounts/${raw}`);
  const id = ((await r.json()) as { account: string }).account;
  appendFileSync(".env", `\nAGENT_F${n}_ACCOUNT=${id}\nAGENT_F${n}_KEY=${env[`FUNDER_${n}_KEY`]}\n`);
  console.log(`AGENT_F${n} is ${id}`);
}

const wallets = ["AGENT_A_KEY", "AGENT_B_KEY", "AGENT_C_KEY", "PROBER_KEY", "FUNDER_1_KEY", "FUNDER_2_KEY"].map((k) => ({ name: k.replace("_KEY", ""), account: privateKeyToAccount(hex(env[k]!)) }));
const balances = await Promise.all(wallets.map((w) => pub.getBalance({ address: w.account.address })));
const richest = balances.indexOf(balances.reduce((a, b) => (a > b ? a : b)));
const from = wallets[richest]!;
console.log(`richest: ${from.name} with ${formatEther(balances[richest]!)} tGLM`);
if (balances[richest] === 0n) {
  console.log(`No tGLM yet. Fund ${wallets[0]!.account.address} at https://hub.arkiv.network/faucet`);
  process.exit(0);
}
const share = balances.reduce((a, b) => a + b, 0n) / BigInt(wallets.length);
const amountEach = share < TARGET ? share : TARGET;
const w = createWalletClient({ chain, transport: http(), account: from.account });
for (const [i, t] of wallets.entries()) {
  if (i === richest || balances[i]! >= amountEach) continue;
  const hash = await w.sendTransaction({ to: t.account.address, value: amountEach - balances[i]! } as never);
  await pub.waitForTransactionReceipt({ hash });
  console.log(`sent ${formatEther(amountEach - balances[i]!)} tGLM to ${t.name}`);
}
process.exit(0);
