// Creates the HCS audit topic and appends its id to .env.
import "dotenv/config";
import { appendFileSync } from "node:fs";
import { AccountId, Client, PrivateKey, TopicCreateTransaction } from "@hiero-ledger/sdk";

if (process.env.HCS_TOPIC_ID) {
  console.log(`topic exists: ${process.env.HCS_TOPIC_ID}`);
  process.exit(0);
}

/** The portal shows an EVM address; the Hedera SDK needs the 0.0.x id, so ask Mirror Node. */
async function accountId(raw: string): Promise<string> {
  if (!raw.startsWith("0x")) return raw;
  const r = await fetch(`${process.env.MIRROR_URL ?? "https://testnet.mirrornode.hedera.com"}/api/v1/accounts/${raw}`);
  const id = ((await r.json()) as { account?: string }).account;
  if (!id) throw new Error(`No Hedera account found for ${raw}`);
  return id;
}

const client = Client.forTestnet().setOperator(
  AccountId.fromString(await accountId(process.env.FUNDER_1_ACCOUNT!)),
  PrivateKey.fromStringECDSA(process.env.FUNDER_1_KEY!),
);
const receipt = await (await new TopicCreateTransaction().setTopicMemo("herd immunity audit trail").execute(client)).getReceipt(client);
const id = receipt.topicId!.toString();
appendFileSync(".env", `\nHCS_TOPIC_ID=${id}\n`);
console.log(`topic created: ${id} https://hashscan.io/testnet/topic/${id}`);
client.close();
process.exit(0);
