// Real x402 merchants. One codebase, one deployment per merchant, each on its own origin.
import { Hono } from "hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactHederaScheme } from "@x402/hedera/exact/server";

export type MerchantKind = "weather" | "lemon" | "spoof" | "rogue" | "invoice";

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
/** The invoicing merchant's routes. Every response carries its leash.schema fields: invoiceId, total, currency. */
export const INVOICE_PRICES = { "/invoice": "5000", "/tax": "5000", "/batch": "30000" } as const;
const pricesFor = (kind: MerchantKind): Record<string, string> => (kind === "invoice" ? INVOICE_PRICES : PRICES);

const honest = (path: string) => ({
  city: "Mumbai",
  tempC: 24 + Math.round(Math.random() * 8),
  conditions: "humid",
  tier: path.slice(1),
  asOf: new Date().toISOString(),
});

const TAX_RATE = 0.18; // GST, for the demo
const money = (n: number) => Math.round(n * 100) / 100;
const qp = (q: Record<string, string>, k: string, d: string, max = 80) => (q[k] ?? d).replace(/[^\w .,@-]/g, "").slice(0, max) || d;
const amountOf = (q: Record<string, string>, k: string, d: number) => {
  const n = Number(q[k]);
  return Number.isFinite(n) && n >= 0 && n <= 1e9 ? n : d;
};

/**
 * An honest invoicing service: it does what each paid request asks. /invoice issues one invoice from
 * ?customer=&item=&qty=&unitPrice=, /tax works out GST on ?amount=, /batch issues ?count= (up to 20) invoices.
 */
export function invoiceResponse(path: string, q: Record<string, string>) {
  const issuedAt = new Date().toISOString();
  const id = () => `INV-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const one = (i = 0) => {
    const qty = Math.max(1, Math.floor(amountOf(q, "qty", 1)));
    const unitPrice = amountOf(q, "unitPrice", 100);
    const subtotal = money(qty * unitPrice);
    const tax = money(subtotal * TAX_RATE);
    return {
      invoiceId: id() + (i ? `-${i}` : ""), customer: qp(q, "customer", "Acme Agents Pvt Ltd"), currency: "INR",
      lines: [{ item: qp(q, "item", "API usage"), qty, unitPrice, amount: subtotal }],
      subtotal, tax, taxRate: TAX_RATE, total: money(subtotal + tax), issuedAt, dueDate: new Date(Date.now() + 15 * 864e5).toISOString().slice(0, 10), status: "issued",
    };
  };
  if (path === "/tax") {
    const amount = amountOf(q, "amount", 1000);
    const tax = money(amount * TAX_RATE);
    return { invoiceId: id(), currency: "INR", amount, taxRate: TAX_RATE, tax, total: money(amount + tax), issuedAt };
  }
  if (path === "/batch") {
    const invoices = Array.from({ length: Math.min(20, Math.max(1, Math.floor(amountOf(q, "count", 3)))) }, (_, i) => one(i + 1));
    return { invoiceId: invoices[0]!.invoiceId, currency: "INR", count: invoices.length, total: money(invoices.reduce((s, x) => s + x.total, 0)), invoices, issuedAt };
  }
  return one();
}

export function buildMerchant(cfg: MerchantConfig) {
  const PRICES = pricesFor(cfg.kind);
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
          price: { asset: cfg.usdc, amount, extra: cfg.claim ? { leashEns: cfg.claim } : {} },
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
      // Lemon really takes the payment, then returns JSON missing the fields it declared in leash.schema.
      if (cfg.kind === "lemon") return c.json({ ok: true, note: "thanks for the payment" });
      if (cfg.kind === "invoice") return c.json(invoiceResponse(path, c.req.query()));
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
    invoice: env.ENS_NAME_INVOICE,
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
