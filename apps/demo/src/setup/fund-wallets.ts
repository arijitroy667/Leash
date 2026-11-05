// Tops up agents and the prober with test USDC from the funders. Rerun whenever they run low.
import "dotenv/config";
import { AccountId, Client, PrivateKey, TokenId, TransferTransaction } from "@hiero-ledger/sdk";

const USDC = TokenId.fromString(process.env.HEDERA_USDC ?? "0.0.429274");
const TARGET_ATOMIC = 2_000_000n; // 2 USDC is plenty: demo payments are under 0.10 USD


/** The portal shows an EVM address; the Hedera SDK needs the 0.0.x id, so ask Mirror Node. */
async function accountId(raw: string): Promise<string> {
  if (!raw.startsWith("0x")) return raw;
  const r = await fetch(`${process.env.MIRROR_URL ?? "https://testnet.mirrornode.hedera.com"}/api/v1/accounts/${raw}`);
  const id = ((await r.json()) as { account?: string }).account;
  if (!id) throw new Error(`No Hedera account found for ${raw}`);
  return id;
}

const funders = await Promise.all([1, 2, 3]
  .filter((n) => process.env[`FUNDER_${n}_ACCOUNT`] && process.env[`FUNDER_${n}_KEY`])
  .map(async (n) => {
    const id = AccountId.fromString(await accountId(process.env[`FUNDER_${n}_ACCOUNT`]!));
    const key = PrivateKey.fromStringECDSA(process.env[`FUNDER_${n}_KEY`]!);
    return { id, client: Client.forTestnet().setOperator(id, key) };
  }));

// AccountBalanceQuery now throws in the Hiero SDK, so balances come from Mirror Node.
const balance = async (_client: Client, id: AccountId) => {
  const r = await fetch(`${process.env.MIRROR_URL ?? "https://testnet.mirrornode.hedera.com"}/api/v1/accounts/${id}`);
  const a = (await r.json()) as { balance?: { tokens?: { token_id: string; balance: number }[] } };
  return BigInt(a.balance?.tokens?.find((t) => t.token_id === USDC.toString())?.balance ?? 0);
};

for (const name of ["AGENT_A", "AGENT_B", "AGENT_C", "PROBER", "AGENT_F2"]) {
  const raw = process.env[`${name}_ACCOUNT`];
  if (!raw) throw new Error(`${name} is missing. Run pnpm wallets:create first`);
  const to = AccountId.fromString(raw);
  const have = await balance(funders[0]!.client, to);
  if (have >= TARGET_ATOMIC) {
    console.log(`${name} has ${have} atomic USDC`);
    continue;
  }
  const want = TARGET_ATOMIC - have;
  let done = false;
  for (const f of funders) {
    if ((await balance(f.client, f.id)) < want) continue;
    const tx = new TransferTransaction()
      .addTokenTransfer(USDC, f.id, -Number(want))
      .addTokenTransfer(USDC, to, Number(want));
    await (await tx.execute(f.client)).getReceipt(f.client);
    console.log(`${name} topped up by ${want} atomic USDC from ${f.id}`);
    done = true;
    break;
  }
  if (!done) console.log(`${name} NOT funded: no funder holds enough USDC. Use https://faucet.circle.com`);
}
process.exit(0);
