# HEDERA track target

🤖 AI Agents That Pay: x402 on Hedera ⸺ $6,500
🥇
1st place
$3,000
🥈
2nd place
$2,000
🥉
3rd place
$1,500
##
AI agents can reason, plan, and call tools, but most still can't pay for what they use. x402 gives them a way: it brings back the HTTP 402 Payment Required status code so a server can quote a price and a client can pay inside an ordinary request. There's no checkout page, signup, or API key.

On Hedera, an x402 payment settles in HBAR or HTS tokens (including USDC) with low, fixed fees and fast finality. The facilitator pays the network fee, so the paying agent doesn't need to hold HBAR for gas. That makes it practical to charge per call, per token, or per second.

Build the economy that agents run on: services that charge for each request, and agents that discover, compare, and pay for those services on their own.

Ideas

A pay-per-call AI inference or data API: model access, translation, OCR, market data, or regional-language speech-to-text, priced per request.
An agent marketplace where agents hire other agents for subtasks and pay each one through x402.
A metered MCP server whose tools charge per call.
A research agent that works within a budget: it compares the prices of paid sources, chooses which ones to use, and reports what it spent.
Micropaywalls for creators: pay a few cents per article, image, or dataset query instead of a subscription.
An open-source Hedera x402 facilitator with its own safety checks and replay protection.
Qualification Requirements
At least one x402-protected endpoint that settles on Hedera testnet or mainnet through any facilitator listed in the Hedera docs (Official x402, Ax402, or Blocky402), or through a facilitator you run yourself.
An agent or client that finds the endpoint and completes at least one paid request end to end, with no human approving.
A public GitHub repo with a README that covers setup, architecture, and the payment flow, including the Hedera transaction ID of at least one settled payment.
A demo video of 5 minutes or less that shows a payment settling and links to it on HashScan.
Extra points

Spending controls for agents: budgets, per-merchant limits, allowlists, or a human-in-the-loop approval above a set amount.
Agent identity and reputation through HCS-14 or ERC-8004
An HCS topic used as a tamper-evident audit log of each agent's spending.
Multi-agent negotiation (A2A or ACP) before the payment is made.
Settling in an HTS token such as USDC, or using HTS custom fees to split revenue.
Recurring or subscription-style payments through Scheduled Transactions.
Use of the Hedera Agent Kit or Hedera Network MCP.
Links and Resources
x402 on Hedera docs
https://docs.hedera.com/solutions/ai/x402
↗
How x402 works
https://docs.hedera.com/solutions/ai/x402/how-it-works
↗
Pay with x402 (client and agent setup)
https://docs.hedera.com/solutions/ai/x402/pay-with-x402
↗
Merchant integration
https://docs.hedera.com/solutions/ai/x402/merchant-integration
↗
Facilitators (testnet and mainnet)
https://docs.hedera.com/solutions/ai/x402/facilitators
↗
Hedera's exact scheme spec
https://docs.hedera.com/solutions/ai/x402/exact-scheme
↗
x402 protocol repo
https://github.com/x402-foundation/x402
↗
Blog post, "Hedera and the x402 Payment Standard"
https://hedera.com/blog/hedera-and-the-x402-payment-standard/
↗
Hedera Agent Kit
https://docs.hedera.com/solutions/ai/agent-kit
↗
Hedera Network MCP
https://docs.hedera.com/solutions/ai/hosted-mcp-server
↗
Scaffold HBAR
https://docs.hedera.com/solutions/tools/scaffold-hbar
↗
Hedera Discord
https://hedera.com/discord

# ARKIV track target

🧩 Build on Arkiv (from scratch) ⸺ $4,000
🥇
1st place
$3,000
🥈
2nd place
$1,000
##
Build a new app whose data lives in Arkiv. You query its entities with SQL-like filters, and each one has an owner wallet and an expiration you choose.

Some directions:

Agents: ephemeral coordination state: tasks, bids and claims that agents share, query and let expire.
Markets: listings or offers that expire at their deadline.
Publishing and media: posts, profiles and follows that any app can read.
Names and identity: profiles or service directories keyed by ENS names.
How we judge:

Arkiv feedback (25%): /arkiv/friction.md
What should we improve today to make Arkiv better: something that got in your way, or something we don't have yet that would make building easier?
When something broke, what did you expect, what happened, and how can we reproduce it?
Reach (25%): /arkiv/reach.md
Who is it for, and would they use it?
Can they try it today, and will you keep building it after Mumbai?
Why Arkiv (25%): /arkiv/why-arkiv.md
If you swapped Arkiv for Postgres or any other database, what would your users lose?
What did you keep off Arkiv, and why?
How you use Arkiv (25%): /arkiv/how-you-use-arkiv.md
Do the things you filter on, who can edit each entity, and when it expires fit what your app does?
Does each Arkiv feature you use change something your users see?
Qualification Requirements
Built from scratch at ETHGlobal Mumbai, following ETHGlobal's rules.
Your app writes to Arkiv's current testnet (see the docs) with @arkiv-network/sdk or the JSON-RPC API, and at least one feature users see reads its data from Arkiv.
In your README: the wallet address(es) that wrote your entities, and one query we can run.
/arkiv/schema.md: your entities, the fields you query, who owns them and when they expire. /arkiv/friction.md: your feedback.
One file per criterion in How we judge, at the path next to it, answering its questions with links, numbers or a query we can run.
A public repo with an open-source license. Say how you used AI, as ETHGlobal's rules require.
Not counted: the SDK installed but never used to read, or Arkiv used only as a log that nothing reads.
Each team can win one Arkiv track prize; the Arkiv + Swarm bonus can come on top of it.
Links and Resources
Docs
https://docs.arkiv.network
↗
AI tools (MCP + plugin)
https://hub.arkiv.network/ai-tools

# ENS track target

🧬 Best Use of ENSv2 ⸺ $7,000
🥇
1st place
$3,000
🥈
2nd place
$2,000
🥉
3rd place
$1,000
🏅
3rd place
$1,000
##
ENSv2 is now live on Ethereum mainnet. Be among the first to build on it. Explore the new hierarchical registry structure: resolve subnames straight off a parent's resolver with wildcard resolution, or deploy your own subname registry to tokenize and manage subnames under your own rules. Use Enhanced Access Control, the shared, role-based permission system behind both registries and resolvers, to delegate specific rights, like letting an account edit only certain text records on a name. Give subnames their own Permissioned Resolver so they fully own their data, mix in record aliasing at the resolver level or namespace aliasing via a shared registry, and combine it all to build subname setups: expiring, revocable, non-transferable vs. transferable, even forever names with no parent control. Bonus points if you bring AI agents into the mix. Think agents as namespaces, each with their own identity and permissions.

Qualification Requirements
Project must be built on ENSv2 on Ethereum mainnet or Sepolia. ENSv2 features should be central to the product, not a cosmetic add-on. Your demo must be functional and not just include hard-coded values. Upon submission, your project showcase must have a link to a live demo and the code needs to be open source and accessible on Github or a similar platform.

Links and Resources
Permissioned Registry docs
https://docs.ens.domains/ensv2/permissioned-registry
↗
Permissioned Resolver docs
https://docs.ens.domains/ensv2/permissioned-resolver/
↗
Enhanced Access Control docs
https://docs.ens.domains/ensv2/enhanced-access-control/
↗
Guide for Contract Developers
https://docs.ens.domains/ensv2/tutorial-contract-develop