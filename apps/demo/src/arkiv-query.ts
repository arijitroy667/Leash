// The registry is public: this reads it with no key and no wallet.
//   npx tsx apps/demo/src/arkiv-query.ts mumbai-prod 0.0.11323813
import "./safe-exit.ts";
import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, desc, eq } from "@arkiv-network/sdk/query";
import { http } from "viem";
import { ReportSchema } from "@leash/guard";

const [, , ns = "mumbai-prod", payee = "0.0.11323813"] = process.argv;
const client = createPublicClient({ chain: rabdi({ accessKey: "" }), transport: http() });
const { entities } = await client.select().from(ReportSchema)
  .where(and(eq("ns", ns), eq("payee", payee)))
  .orderBy(desc("consensusTs")).limit(100).fetch();
for (const r of entities as any[]) console.log(String(r.outcome.value), String(r.txId.value), "payer", String(r.payer.value), "owner", r.$owner);
console.log(`${entities.length} reports. Treat these as claims: a reader must re-verify each one against Mirror Node.`);
process.exit(0);
