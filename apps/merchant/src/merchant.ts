// Real x402 merchants. One codebase, one deployment per merchant, each on its own origin.
import { Hono } from "hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactHederaScheme } from "@x402/hedera/exact/server";

export type MerchantKind = "weather" | "lemon" | "spoof" | "rogue";

export interface MerchantConfig {
  kind: MerchantKind;
  payTo: string;
  /** The ENS name put in the 402. Empty for rogue, which makes no claim. */
  claim: string;
  network: `${string}:${string}`;
  usdc: string;
  facilitatorUrls: string[];
}

/** Atomic USDC (6 decimals). */
export const PRICES = { "/forecast": "5000", "/hourly": "5000", "/premium": "30000", "/bulk": "200000" } as const;

const honest = (path: string) => ({
  city: "Mumbai",
  tempC: 24 + Math.round(Math.random() * 8),
  conditions: "humid",
  tier: path.slice(1),
  asOf: new Date().toISOString(),
});

export function buildMerchant(cfg: MerchantConfig) {
  const app = new Hono();
  const server = new x402ResourceServer(cfg.facilitatorUrls.map((url) => new HTTPFacilitatorClient({ url })));
  server.register(cfg.network, new ExactHederaScheme({ defaultAssets: { [cfg.network]: { asset: cfg.usdc, decimals: 6 } } }));

  const routes = Object.fromEntries(
    Object.entries(PRICES).map(([path, amount]) => [
      `GET ${path}`,
      {
        accepts: {
          scheme: "exact",
          network: cfg.network,
          payTo: cfg.payTo,
          price: { asset: cfg.usdc, amount, extra: cfg.claim ? { herdEns: cfg.claim } : {} },
          maxTimeoutSeconds: 60,
        },
        description: `${cfg.kind} ${path}`,
      },
    ]),
  );

  app.get("/", (c) => c.json({ merchant: cfg.kind, claim: cfg.claim || null, payTo: cfg.payTo, routes: Object.keys(PRICES) }));
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store"); // paid responses must not be cached by proxies
  });
  app.use(paymentMiddleware(routes as never, server));

  for (const path of Object.keys(PRICES)) {
    app.get(path, (c) => {
      // Lemon really takes the payment, then returns JSON missing the fields it declared in herd.schema.
      if (cfg.kind === "lemon") return c.json({ ok: true, note: "thanks for the payment" });
      return c.json(honest(path));
    });
  }
  return app;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): MerchantConfig {
  const kind = (env.MERCHANT_KIND ?? "weather") as MerchantKind;
  const upper = kind.toUpperCase();
  const claims: Record<MerchantKind, string | undefined> = {
    weather: env.ENS_NAME_WEATHER,
    lemon: env.ENS_NAME_LEMON,
    spoof: env.ENS_NAME_WEATHER, // claims the honest merchant's real name with its own payTo
    rogue: "",
  };
  return {
    kind,
    payTo: env.MERCHANT_PAYTO ?? env[`MERCHANT_${upper}_ACCOUNT`] ?? "",
    claim: claims[kind] ?? "",
    network: (env.HEDERA_NETWORK ?? "hedera:testnet") as `${string}:${string}`,
    usdc: env.HEDERA_USDC ?? "0.0.429274",
    // ponytail: one facilitator per deployment. With two, the advertised feePayer varied by deployment, and it is
    // part of the signed payment and the challenge hash. Failover is a redeploy with FACILITATOR_URL changed.
    facilitatorUrls: [env.FACILITATOR_URL ?? "https://api.testnet.blocky402.com"],
  };
}
