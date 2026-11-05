// Spike: real local merchant, real facilitator /supported, real 402, and a throwaway key.
// Proves what the hook sees and that abort stops payment creation. Spends nothing.
import { serve } from "@hono/node-server";
import { PrivateKey } from "@hiero-ledger/sdk";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { buildMerchant } from "@leash/merchant";

const facilitators = process.argv[2] ? [process.argv[2]] : ["https://api.testnet.blocky402.com", "https://x402.org/facilitator"];
const app = buildMerchant({
  kind: "weather", payTo: "0.0.11286079", claim: "leash-weather.eth", network: "hedera:testnet", usdc: "0.0.429274",
  facilitatorUrls: facilitators,
});
const srv = serve({ fetch: app.fetch, port: 4871 });
const url = "http://localhost:4871/forecast";

const raw = await fetch(url);
console.log("raw status", raw.status);
const body = await raw.json().catch(() => null);
console.log("402 header PAYMENT-REQUIRED present:", raw.headers.has("PAYMENT-REQUIRED"), "| body keys:", body && Object.keys(body));

const key = PrivateKey.generateECDSA();
const signer = createClientHederaSigner("0.0.1111", key, { network: "hedera:testnet" });
const client = new x402Client().register("hedera:*" as never, new ExactHederaScheme(signer));
let seen: any;
client.onBeforePaymentCreation(async (ctx) => {
  seen = ctx;
  return { abort: true, reason: "leash:DENY:spike" };
});
const paid = wrapFetchWithPayment(fetch, client);
try {
  const r = await paid(url);
  console.log("UNEXPECTED: no abort, status", r.status);
} catch (e) {
  console.log("aborted with:", String(e).slice(0, 200));
}
console.log("selectedRequirements:", JSON.stringify(seen?.selectedRequirements, null, 1));
console.log("resource:", JSON.stringify(seen?.paymentRequired?.resource));
srv.close();
process.exit(0);
