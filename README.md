# Herd Immunity

A shared, proof-of-payment-backed payee-safety registry and guard for AI agents paying over x402. One agent's loss protects every other agent, no verdict is permanent, and a merchant coming out of a block earns trust back through probation.

An agent's payment gets one of three verdicts before anything is signed:

| Verdict | Meaning | Typical cause |
| --- | --- | --- |
| ALLOW | Pay now | Known merchant, amount within limit, low score |
| ESCALATE | Stop and ask the owner | Unknown merchant, amount above limit, medium score, probation, outage |
| DENY | Never pay this challenge | Blocked merchant, spoof, replay, over declared price |

**How it works:** the guard identifies the payee through ENSv2, reads proven history from Arkiv, re-verifies every report against Hedera Mirror Node, decides, and files a signed report after each paid call.

## Status

Work in progress: see `BUILD_PLAN.md`. Settled transaction ids, writer wallets and the live link are added here as they exist.

## Run it

Requires Node 22.13 or later and pnpm.

```bash
pnpm install
pnpm test                 # engine, guard and MCP tests; no network
cp .env.example .env      # fill in the funders, Arkiv key and Sepolia wallets
pnpm wallets:create       # real testnet accounts for agents, prober and merchants
pnpm wallets:fund         # after claiming test USDC at faucet.circle.com
pnpm wallets:check        # readiness report, prints no secrets
pnpm hcs:create
pnpm ens:setup            # real ENSv2 names, resolvers, records and roles on Sepolia
```

Then, each in its own terminal:

```bash
pnpm --filter @herd/dashboard dev          # owner console on :3100
npx tsx apps/demo/src/prober.ts            # probe retests
npx tsx apps/demo/src/show.ts all          # the demo scenes
```

## Use it

**SDK**

```ts
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createHerdGuard } from "@herd/guard";

const guard = createHerdGuard({ agent, hederaAccount, hederaKey, ownerAddress, arkivAccessKey, namespace: "mumbai-1" });
const client = new x402Client(); // register your Hedera scheme here
guard.attach(client);
const paidFetch = guard.guardedFetch(wrapFetchWithPayment(fetch, client));
```

A developer can still call the raw client, so the SDK does not prevent bypass. The MCP server does.

**MCP**, where the server holds the signer and there is no approve tool:

```json
{
  "mcpServers": {
    "herd": {
      "command": "npx",
      "args": ["tsx", "packages/mcp/src/server.ts"],
      "env": { "HERD_ENV_FILE": ".env", "HERD_MCP_AGENT": "C" }
    }
  }
}
```

## Repo

| Path | What |
| --- | --- |
| `packages/core` | Pure engine: score, standing replay, limits, decide. No I/O, takes `now` |
| `packages/guard` | SDK, ENS, Arkiv and Mirror adapters, SQLite store, outbox |
| `packages/mcp` | MCP server over stdio |
| `apps/dashboard` | Owner console and public read-only explorer |
| `apps/demo` | Real merchants, prober, scene runner, setup scripts |
| `arkiv/` | Arkiv submission files |

## Changes from PRD v2.1

The PRD asks for any rule it does not contain to be recorded here, with a reason.

| Change | Reason |
| --- | --- |
| New DENY reason `unsupported-asset`: only the configured USDC token is payable | A challenge in another token has no USD value to score |
| New ESCALATE reason `unknown-origin` | A call that bypasses `guardedFetch` has no real origin to check against ENS |
| The G5 per-payee window is a live-profile duration (18 s) | Otherwise agent A's second bad report in scene 6 would be ignored |
| Evidence scope stays at probation entry after probation ends | In the live profile, decay is not shortened, so evidence from before a block could trigger another |
| `stale-challenge` uses the time this request received its 402 | A fresh 402 for the same price has the same hash, so a first-seen time could never clear |
| "Reject and block locally" is not built | Reject is enough for the demo; add a local deny list if it is needed |
| Safe mode ends on the next healthy read, not after three | Simpler; the upgrade is a counter on the health table |
| Merchant facilitator failover is a redeploy, not automatic | Two facilitators made the advertised `feePayer` vary by deployment, which is part of the signed payment |
| Rebuttals expire with reports (60 days), not at 30 days | A rebuttal only matters while the block it refers to is in evidence |

## Disclosures

- **AI use:** this project was built with Claude Code, which wrote most of the code under the team's direction.
- **Pre-existing work:** `Herd Immunity PRDv2.1.md` is planning material written before the event, and is disclosed as such. All code was written during the event.
- **Testnets:** Hedera testnet, Arkiv testnet and ENSv2 on Sepolia, with test tokens. ENS's Sepolia registrar charges fees in its own test token, named `MockUSDC`. We deploy no mock contracts.
- **Live profile:** the demo uses a disclosed policy profile where 1 policy day = 18 real seconds. See `arkiv/friction.md`.

## License

MIT. See `LICENSE`.
