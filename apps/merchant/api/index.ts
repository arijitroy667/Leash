// Vercel entry: one project per merchant, each with its own MERCHANT_KIND and MERCHANT_PAYTO.
import { buildMerchant, configFromEnv } from "../src/merchant.js";

const app = buildMerchant(configFromEnv());

export default { fetch: app.fetch };
