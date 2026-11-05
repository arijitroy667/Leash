// Read-only readiness report against live networks. Prints no secrets.
import "../safe-exit.ts";
import "dotenv/config";
import { createPublicClient, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { rabdi } from "@arkiv-network/sdk/chains";
import { createPublicClient as createArkivClient } from "@arkiv-network/sdk";

const MIRROR = process.env.MIRROR_URL ?? "https://testnet.mirrornode.hedera.com";
const USDC = process.env.HEDERA_USDC ?? "0.0.429274";
const now = Date.now() / 1000;
const mirror = async (path: string) => (await fetch(`${MIRROR}/api/v1${path}`)).json() as Promise<any>;
const hex = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;

async function hedera(name: string) {
  const id = process.env[`${name}_ACCOUNT`];
  if (!id) return console.log(`  ${name.padEnd(18)} MISSING`);
  const a = await mirror(`/accounts/${id}`);
  const created = Number(a.created_timestamp);
  const usdc = a.balance?.tokens?.find((t: any) => t.token_id === USDC);
  const first = await mirror(`/transactions?account.id=${id}&timestamp=gte:${a.created_timestamp}&order=asc&limit=1`);
  const funder = first.transactions?.[0]?.transaction_id?.split("-")[0] ?? "?";
  const age = (now - created) / 3600;
  console.log(
    `  ${name.padEnd(18)} ${id.padEnd(14)} ${(a.balance.balance / 1e8).toFixed(1).padStart(7)} HBAR  ` +
    `USDC ${usdc ? (usdc.balance / 1e6).toFixed(3) : "not associated"}  age ${age.toFixed(1)}h  funder ${funder}  key ${a.key?._type}`,
  );
  return { name, funder, age };
}

console.log("Hedera");
const rows = [];
for (const n of ["FUNDER_1", "FUNDER_2", "FUNDER_3", "AGENT_A", "AGENT_B", "AGENT_C", "PROBER", "MERCHANT_WEATHER", "MERCHANT_LEMON", "MERCHANT_SPOOF", "MERCHANT_ROGUE"]) {
  rows.push(await hedera(n));
}
const a = rows.find((r) => r?.name === "AGENT_A");
const b = rows.find((r) => r?.name === "AGENT_B");
if (a && b) {
  console.log(`  A and B separate clusters: ${a.funder !== b.funder ? "yes" : "NO, a block cannot trigger"}`);
  const young = Math.min(a.age, b.age);
  console.log(`  Full weight in: ${young >= 24 ? "now" : `${(24 - young).toFixed(1)}h`}`);
}

console.log("Arkiv");
const key = process.env.ARKIV_ACCESS_KEY;
const arkiv = createArkivClient({ chain: rabdi({ accessKey: key ?? "" }), transport: http() } as any);
for (const n of ["AGENT_A", "AGENT_B", "AGENT_C", "PROBER"]) {
  const k = process.env[`${n}_KEY`];
  if (!k) continue;
  const address = privateKeyToAccount(hex(k)).address;
  const bal = await arkiv.getBalance({ address });
  console.log(`  ${n.padEnd(18)} ${address}  ${formatEther(bal)} tGLM`);
}
console.log(`  access key: ${key ? "set" : "MISSING"}`);

console.log("Sepolia");
const sep = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL) });
const managerKey = process.env.ENS_MANAGER_KEY ?? "";
if (managerKey.length === 42) {
  console.log("  ENS_MANAGER_KEY holds an address, not a private key. ENS setup cannot sign with it");
  console.log(`  that address has ${formatEther(await sep.getBalance({ address: managerKey as `0x${string}` }))} ETH`);
} else if (managerKey) {
  const address = privateKeyToAccount(hex(managerKey)).address;
  console.log(`  manager ${address}  ${formatEther(await sep.getBalance({ address }))} ETH`);
} else console.log("  ENS_MANAGER_KEY MISSING");
console.log(`  owner ${process.env.LEASH_OWNER_ADDRESS || "MISSING"}`);
process.exit(0);
