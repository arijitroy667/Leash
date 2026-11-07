// A merchant lists itself, so everything it declares is hostile until checked: its endpoint must answer for its own
// name and payee, and nothing but a plain https endpoint is ever fetched.
import { describe, expect, it } from "vitest";
import type { Declaration } from "@leash/core";
import { checkEndpoint, listingMessage } from "../src/evidence.ts";

const ENS = "shop.eth";
const decl: Declaration = {
  payTo: "0.0.100", network: "hedera:testnet", asset: "0.0.429274", maxPriceUsd: 0.25,
  domains: ["https://shop.example"], schema: [], probeUrl: "https://shop.example/check", policyVersion: 7,
};
const offer = { scheme: "exact", network: "hedera:testnet", amount: "5000", asset: "0.0.429274", payTo: "0.0.100", extra: { leashEns: ENS } };
/** A 402 the way @x402 v2 sends it: requirements in a base64 Payment-Required header. */
const answer = (status: number, accepts: unknown[] = [offer]) => async () =>
  new Response("{}", { status, headers: { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64") } });

describe("checkEndpoint", () => {
  it("accepts a 402 that claims the name and asks the declared payee", async () => {
    expect(await checkEndpoint(ENS, decl, answer(402) as typeof fetch)).toEqual({ ok: true, amountUsd: 0.005 });
  });

  it("reads x402 v1 requirements from the body", async () => {
    const v1 = async () => Response.json({ accepts: [{ ...offer, amount: undefined, maxAmountRequired: "5000" }] }, { status: 402 });
    expect(await checkEndpoint(ENS, decl, v1 as typeof fetch)).toEqual({ ok: true, amountUsd: 0.005 });
  });

  it.each([
    ["another payee", [{ ...offer, payTo: "0.0.999" }], /asks payment to 0.0.999/],
    ["no claim", [{ ...offer, extra: {} }], /does not claim shop.eth/],
    ["another name", [{ ...offer, extra: { leashEns: "other.eth" } }], /does not claim/],
    ["mainnet", [{ ...offer, network: "hedera:mainnet" }], /hedera:mainnet/],
    ["a price over the max", [{ ...offer, amount: "300000" }], /above the declared max/],
  ])("refuses %s", async (_, accepts, why) => {
    const r = await checkEndpoint(ENS, decl, answer(402, accepts) as typeof fetch);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toMatch(why);
  });

  it("refuses an endpoint that serves without payment", async () => {
    expect(await checkEndpoint(ENS, decl, answer(200) as typeof fetch)).toMatchObject({ ok: false, why: expect.stringMatching(/answered 200/) });
  });

  it.each(["http://shop.example/check", "https://127.0.0.1/check", "https://localhost/check", "https://shop.example:8443/check", "https://u@shop.example/check", "https://[::1]/check"])(
    "never fetches %s",
    async (probeUrl) => {
      let fetched = false;
      const spy = (async () => ((fetched = true), new Response(null, { status: 402 }))) as typeof fetch;
      const r = await checkEndpoint(ENS, { ...decl, probeUrl, domains: [new URL(probeUrl).origin] }, spy);
      expect(r.ok).toBe(false);
      expect(fetched).toBe(false);
    },
  );

  it("refuses a probe URL off the declared domains", async () => {
    expect(await checkEndpoint(ENS, { ...decl, domains: ["https://elsewhere.example"] }, answer(402) as typeof fetch)).toMatchObject({ ok: false });
  });
});

it("binds the signed text to the name, payee, version and registry", () => {
  const base = { ns: "mumbai-prod", ens: ENS, payee: "0.0.100", policyVersion: 7, signedAt: 1 };
  const m = listingMessage(base);
  for (const change of [{ ens: "x.eth" }, { payee: "0.0.101" }, { policyVersion: 8 }, { ns: "mumbai-1" }, { signedAt: 2 }]) {
    expect(listingMessage({ ...base, ...change })).not.toBe(m);
  }
});
