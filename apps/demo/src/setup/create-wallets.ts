// Creates the real testnet accounts the demo needs and appends them to .env.
// Safe to rerun: accounts already in .env are kept. Prints ids only, never keys.
import "dotenv/config";
import { appendFileSync } from "node:fs";
import {
  AccountCreateTransaction, AccountId, Client, Hbar, PrivateKey, TokenAssociateTransaction, TokenId,
} from "@hiero-ledger/sdk";

const USDC = TokenId.fromString(process.env.HEDERA_USDC ?? "0.0.429274");
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is missing from .env`);
  return v;
};


/** The portal shows an EVM address; the Hedera SDK needs the 0.0.x id, so ask Mirror Node. */
async function accountId(raw: string): Promise<string> {
  if (!raw.startsWith("0x")) return raw;
  const r = await fetch(`${process.env.MIRROR_URL ?? "https://testnet.mirrornode.hedera.com"}/api/v1/accounts/${raw}`);
  const id = ((await r.json()) as { account?: string }).account;
  if (!id) throw new Error(`No Hedera account found for ${raw}`);
  return id;
}

async function funder(n: number) {
  const account = process.env[`FUNDER_${n}_ACCOUNT`];
  const key = process.env[`FUNDER_${n}_KEY`];
  if (!account || !key) return null;
  const k = PrivateKey.fromStringECDSA(key);
  const id = AccountId.fromString(await accountId(account));
  return { id, key: k, client: Client.forTestnet().setOperator(id, k) };
}

const f1 = await funder(1);
const f2 = await funder(2);
if (!f1 || !f2) throw new Error(`Set FUNDER_1 and FUNDER_2 first: ${need("FUNDER_1_ACCOUNT")}`);
const f3 = (await funder(3)) ?? f1;

async function associate(client: Client, id: AccountId, key: PrivateKey) {
  const tx = await new TokenAssociateTransaction().setAccountId(id).setTokenIds([USDC]).freezeWith(client).sign(key);
  try {
    await (await tx.execute(client)).getReceipt(client);
  } catch (e) {
    if (!String(e).includes("TOKEN_ALREADY_ASSOCIATED")) throw e;
  }
}

// [env prefix, funder, starting HBAR]
const plan = [
  ["AGENT_A", f1, 20], ["AGENT_B", f2, 20], ["AGENT_C", f3, 20], ["PROBER", f1, 20],
  ["MERCHANT_WEATHER", f1, 5], ["MERCHANT_LEMON", f1, 5], ["MERCHANT_SPOOF", f1, 5], ["MERCHANT_ROGUE", f2, 5], ["MERCHANT_INVOICE", f1, 5],
] as const;

for (const f of [f1, f2, f3]) await associate(f.client, f.id, f.key);
console.log("funders associated with USDC");

for (const [name, f, hbar] of plan) {
  if (process.env[`${name}_ACCOUNT`]) {
    console.log(`${name} exists: ${process.env[`${name}_ACCOUNT`]}`);
    continue;
  }
  const key = PrivateKey.generateECDSA();
  const tx = await new AccountCreateTransaction()
    .setECDSAKeyWithAlias(key.publicKey)
    .setInitialBalance(new Hbar(hbar))
    .freezeWith(f.client)
    .sign(key);
  const receipt = await (await tx.execute(f.client)).getReceipt(f.client);
  const id = receipt.accountId!;
  const own = Client.forTestnet().setOperator(id, key);
  await associate(own, id, key);
  own.close();
  appendFileSync(".env", `\n${name}_ACCOUNT=${id}\n${name}_KEY=${key.toStringRaw()}\n`);
  console.log(`${name} created: ${id} funded by ${f.id}, evm 0x${key.publicKey.toEvmAddress()}`);
}

console.log("\nNext: claim test USDC at https://faucet.circle.com for a funder, then run pnpm wallets:fund");
for (const f of [f1, f2, f3]) f.client.close();
process.exit(0);
