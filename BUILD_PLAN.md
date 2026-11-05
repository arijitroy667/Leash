# Leash: build plan

Source of truth: `Leash PRDv2.1.md`. Clock: hacking started Nov 5, 1 pm IST, so hour 36 is Nov 7, 1 am IST. This plan was re-cut at hour 2.

## What changed when the plan was re-checked

| Finding | Effect on the plan |
| --- | --- |
| Two hours are gone and wallets are still being set up | Everything that needs no keys comes first: `core`, then adapters coded against real API shapes |
| G5 allows 1 bad report per payee per 24 hours, so agent A's second bad report in scene 6 would be ignored | The per-payee window becomes a live-profile duration (18 s) |
| A challenge in a non-USD token has no USD value to score | New DENY reason `unsupported-asset`: only the configured USDC token is payable |
| Evidence from before a block could re-trigger a block in the live profile, because decay is not shortened | Evidence scope starts at probation entry and stays there until the next block |

## Rules while building

1. `packages/core` is pure: no I/O and no clock. Every verdict comes from it.
2. No mocks outside vitest. If an integration fails, cut the scene or disclose it.
3. Remote writes go through the outbox and never block a response.
4. Commit at every step, so history shows the build.
5. Secrets stay in `.env`, which is never committed.

## Milestones

| # | Target | Scope | Needs keys? | Done when | Status |
| --- | --- | --- | --- | --- | --- |
| M0 | Hour 3 | Monorepo, TypeScript, vitest, env template, wallet script | No | `pnpm test` runs | Done |
| M1 | Hour 6 | `core`: score, evidence, standing replay, limits, challenge hash, decide | No | S1 to S15 and property tests pass | Done |
| M2 | Hour 9 | Spikes: hook abort, paid call, Arkiv write and read, ENS read and role check | **Yes** | All four pass against live networks | Done, on live networks |
| M3 | Hour 12 | Real merchants on Vercel; ENS names, resolvers, `leash.*` keys, roles | **Yes** | Real lemon payment on HashScan | Done |
| M4 | Hour 18 | `guard`: store, adapters, signed reports, outbox, `guardedFetch`, HCS | **Yes** | **Scenes 1 to 3 live through the SDK** | Done, in rehearsal with aged funders |
| M5 | Hour 24 | `mcp`, owner console with wallet-signed approvals, decision log | **Yes** | Scenes 4 and 8 live; same verdicts on both surfaces | Done in rehearsal; owner wallet signing in the console still untested |
| M6 | Hour 30 | Prober, rebuttal desk, health, outage relay, public explorer, full run | **Yes** | **All scenes pass; feature freeze** | All scenes pass on the 1, 2 and 5 minute clock (rehearsal-11, after the NFR changes). FR and NFR audits done; decision latency measured (warm p95 2 ms, cold p95 2.3 s). F1 to F15 next. Explorer deployed. Console wallet test and final run with real agents remain |
| M7 | Hour 33 | `/arkiv` files, README, LICENSE, AI disclosure, rehearsal, backup | No | Checklist complete | Docs drafted; final tx links, rehearsal with a person and backup remain |
| M8 | Hour 35 | Film and submit to Hedera, Arkiv, ENS | No | Submitted | |

## Dependency order

```text
M0 -> M1 ----------------------> M4 -> M5 -> M6 -> M7 -> M8
M0 -> wallets -> M2 -> M3 ------^
```

`core` has no dependency on wallets. Everything from M2 onward does, so wallets are the main schedule risk.

## What the wallet setup must produce

Fill `.env` from `.env.example`. The full list and reasons are in that file.

| Item | Count | Used by |
| --- | --- | --- |
| Hedera testnet accounts, ECDSA keys | 8: agents A, B, C, prober, payTo for weather, lemon, spoof, rogue | Payments and reports |
| Separate funders | Agents A, B and C from different accounts (ideally different teammates) | Two independent bad clusters are required to block |
| Test USDC `0.0.429274` | Agents and prober | Payments. Association runs first: `pnpm wallets:associate` |
| Arkiv access key and tGLM | Key plus one funded EVM wallet per agent and the prober | Report writes |
| Sepolia ETH | Owner wallet and merchant manager wallet | ENS registration, resolvers, roles |
| HCS audit topic | 1, created by script | Audit trail |

**Wallet age:** agents count fully only once they are 24 hours old. Filming is at about hour 33, so they must exist by hour 9 at the very latest.

## Decision gates

| Gate | If not met | Cut |
| --- | --- | --- |
| Hour 9 | Spikes failing | Work only on the failing spike; note it in `friction.md` |
| Hour 18 | Scenes 1 to 3 not live | Stop all other work until they are |
| Hour 24 | Behind | Dashboard is approvals and decision log only; MCP Inspector for scene 4 |
| Hour 30 | Scene failing | Drop that scene from the demo rather than fake it |

Cut order and the never-cut list are in PRD section 20.

## Repo

```text
packages/core    pure engine
packages/guard   @leash/guard: SDK, adapters, sqlite store, outbox
packages/mcp     @leash/mcp: stdio server
apps/dashboard   owner console and public explorer
apps/demo        merchants, prober, agent scripts, setup scripts
arkiv/           submission files, started now (friction.md is scored)
```
