# Reach

## Who it is for

- **Developers who give an AI agent a wallet** and let it pay x402 merchants per call. Leash gives each payment a verdict before anything is signed: through four lines of SDK, or one entry in an MCP client's config.
- **The people who own those agents.** They set budgets and per-merchant caps, and they get an approval card, signed with their wallet, whenever the agent should ask instead of pay.
- **x402 merchants.** An honest merchant declares itself in ENS and builds a record from real payments. A blocked one can file a rebuttal and earn its way back through probation, because no verdict is permanent.
- **Anyone building agent wallets, marketplaces or paying MCP servers.** The registry is public data: they can read it with one query and apply their own rules.

## Would they use it?

The problem is real for anyone whose agent pays on its own. A merchant can take the money and return junk, or a spoofed `payTo` can stand in for an honest name, and today every agent learns that alone. With Leash, the first agent that pays a bad merchant files a report backed by its payment, and every other agent reading the same registry is protected before it pays.

What it costs to adopt:

- **Code:** `guard.attach(client)` on an existing x402 client, or the MCP server, which holds the signer and has no approve tool.
- **Trust:** none in us. Every report is re-verified against Hedera Mirror Node by each reader, and the rules are open source.
- **Time:** the guard reads ENS, Arkiv and Mirror Node before paying. `npx tsx apps/demo/src/latency.ts` measures what that adds on the real networks.

What has happened so far, all on public testnets, from the [audit topic](https://hashscan.io/testnet/topic/0.0.11326849):

| | Count |
| --- | --- |
| Guard decisions | 377: 129 ALLOW, 157 ESCALATE, 91 DENY |
| Reports filed to Arkiv, each backed by a real payment | 150: 100 good, 50 bad |
| Approvals, probes and rebuttals | 135, 12 and 14 |

To be clear about the limit: every one of those came from the team's own agents. Nobody outside the team has used it yet.

## Can they try it today?

Yes, with no account:

- **Look up a merchant:** https://leash-explorer.vercel.app/explorer reads ENS, Arkiv and Mirror Node live, with no wallet or key.
- **Query the registry:** the `curl` in the README goes straight to Arkiv's public RPC.
- **Put it in an agent:** https://leash-explorer.vercel.app/integrate has the SDK code and the MCP config for Claude Desktop and Claude Code.
- **Check our claims:** `pnpm mcp:live` runs every MCP tool against the live merchants and checks each payment on Hedera, each report on Arkiv and each decision on the audit topic.

## Will we keep building it after Mumbai?

Yes. These are the next steps, from the gaps the code already points to:

- **Open the prober allow-list:** each reader trusts only probers it chooses, and ours trusts only our own prober.
- **More reporters:** agents protect each other only when they read the same namespace, so the next step is other teams' agents filing into `mumbai-prod`.
- **Mainnet:** Hedera mainnet settlement and ENS mainnet names, once ENSv2 resolution moves there.

## Who can read and write the registry

The registry belongs to no one in this project. It is a set of public Arkiv entities, and the rules for using them are in open-source code. Anyone can read it with no key, wallet or account. Arkiv lets any funded wallet write an entity, so being written does not make a row count: each reader decides that by checking it.

| Entity | Who can write one | When a reader counts it |
| --- | --- | --- |
| `leash.report` | Any wallet | The payment exists on Mirror Node, succeeded, used the configured USDC, and matches the payee, payer and amount, and the payer's Hedera key signed the report. Only one bad report per payer per payee counts in the window, and at most 5 a day across payees |
| `leash.probe` | Any wallet | The creator is on that reader's prober allow-list, and the payment is real and went to that payee |
| `leash.rebuttal` | Any wallet | The named ENS record declares that payee, and the signer holds `ROLE_SET_TEXT` for the `leash.rebuttal` key on that resolver. It only asks for a probe and never unblocks a merchant |

So a stranger can join in by paying a merchant and reporting honestly, with no sign-up. A report costs a real payment, and it counts only for the wallet that paid.

**Limits:** funding-source clusters and age weighting raise the cost of faking several reporters, but a well-funded attacker can still get past them. Everything runs on Arkiv's Rabdi testnet and Hedera testnet.
