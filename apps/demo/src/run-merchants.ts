// Runs merchants locally for development. The demo uses public deployments, so ENS can name real origins.
import "dotenv/config";
import { serve } from "@hono/node-server";
import { buildMerchant, configFromEnv, type MerchantKind } from "@leash/merchant";

const kinds: MerchantKind[] = ["weather", "lemon", "spoof", "rogue", "invoice"];
kinds.forEach((kind, i) => {
  const port = 4801 + i;
  const cfg = configFromEnv({ ...process.env, MERCHANT_KIND: kind });
  serve({ fetch: buildMerchant(cfg).fetch, port });
  console.log(`${kind} http://localhost:${port} payTo ${cfg.payTo} claim ${cfg.claim || "none"}`);
});
