import Link from "next/link";
import type { ReactNode } from "react";
import { CodeBlock } from "../components/bits";
import { REPO } from "../components/footer";

export const metadata = { title: "Integrate", description: "Add Leash to an x402 agent with the SDK, connect an LLM through the MCP server, or declare a merchant in ENSv2." };

const SDK = `import { wrapFetchWithPayment } from "@x402/fetch";
import { createLeashGuard, rawClient, LeashDenied, LeashEscalated } from "@leash/guard";

const guard = createLeashGuard({
  agent: "agent-a",                       // a label for this agent's ledger and audit trail
  hederaAccount: process.env.AGENT_A_ACCOUNT!,
  hederaKey: process.env.AGENT_A_KEY!,    // signs payments and the agent's own reports
  ownerAddress: process.env.LEASH_OWNER_ADDRESS as \`0x\${string}\`,
  arkivAccessKey: process.env.ARKIV_ACCESS_KEY!,
  namespace: "mumbai-1",                  // which shared registry to read and write
  hcsTopicId: process.env.HCS_TOPIC_ID,   // optional audit trail on Hedera Consensus Service
});

// A real x402 client for Hedera. Its own spend controls are off: the guard decides everything.
const client = rawClient(process.env.AGENT_A_ACCOUNT!, process.env.AGENT_A_KEY!);
guard.attach(client);
const paidFetch = guard.guardedFetch(wrapFetchWithPayment(fetch, client));`;

const SDK_USE = `try {
  const res = await paidFetch("https://leash-merchant-weather.vercel.app/forecast");
  console.log(res.leash);   // { decisionId, txId, delivered }
} catch (e) {
  if (e instanceof LeashEscalated) {
    // The owner signs in the console. Retry the same URL once approved.
    await guard.waitForApproval(e.approvalId, 120_000);
  } else if (e instanceof LeashDenied) {
    console.log(e.decision.reasons);  // e.g. ["blocked"] or ["declared-mismatch"]
  } else throw e;
}`;

const SDK_MORE = `const d = await guard.check({ url, requirements });  // a dry run: the verdict, nothing paid
guard.explain(d.id);                                   // factors, limits, reasons, latency
await guard.merchant("0.0.11323814");                  // a payee's verified standing`;

const MCP_DESKTOP = `{
  "mcpServers": {
    "leash": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/Leash", "exec", "tsx", "packages/mcp/src/server.ts"],
      "env": { "LEASH_MCP_AGENT": "C" }
    }
  }
}`;

const MCP_WINDOWS = `"command": "cmd",
"args": ["/c", "pnpm", "--dir", "C:/path/to/Leash", "exec", "tsx", "packages/mcp/src/server.ts"]`;

const MCP_CODE = `claude mcp add leash -e LEASH_MCP_AGENT=C -- pnpm --dir /path/to/Leash exec tsx packages/mcp/src/server.ts`;

const RUN = `git clone ${REPO}
cd Leash && pnpm install
pnpm test                    # engine, guard and MCP tests, no network
cp .env.example .env         # funders, Arkiv key, Sepolia wallets
pnpm wallets:create && pnpm wallets:fund && pnpm wallets:check
pnpm hcs:create && pnpm ens:setup
pnpm --filter @leash/dashboard dev   # this site, with the owner console, on :3100`;

const ENS_RECORDS = `leash.payTo        0.0.11323813
leash.network      hedera:testnet
leash.asset        0.0.429274
leash.maxPrice     0.25
leash.domains      https://leash-merchant-weather.vercel.app
leash.schema       city,tempC,conditions
leash.probeUrl     https://leash-merchant-weather.vercel.app/forecast
leash.policyVersion 1793897963`;

const X402 = `// In the merchant's x402 route config: name yourself in the 402.
price: { asset: "0.0.429274", amount: "5000", extra: { leashEns: "leash-weather.eth" } }`;

const QUERY = `npx tsx apps/demo/src/arkiv-query.ts mumbai-prod 0.0.11323813`;

const TOOLS: [string, string, string][] = [
  ["leash_pay_request", "url, method, maxUsd, idempotencyKey?", "paid (with an untrusted body), pending_approval, denied, no_payment, unconfirmed, failed"],
  ["leash_check_merchant", "key: ENS name, domain or account", "standing, factors, strikes, block and hold ends, rebuttal"],
  ["leash_explain_decision", "decisionId", "the stored decision: reasons, factors, limits, latency"],
  ["leash_report_outcome", "txId, outcome", "queued, already-filed or refused; reports are filed automatically"],
  ["leash_list_pending_approvals", "none", "structured cards: merchant, standing, amount, score, reasons"],
  ["leash_await_approval", "approvalId, timeoutMs", "approved, rejected, expired or still_pending; it cannot approve"],
  ["leash_get_budget", "none", "session and daily budget, and spend per merchant"],
];

const CONFIG: [string, string][] = [
  ["agent", "Label for this agent's ledger, approvals and audit messages"],
  ["hederaAccount, hederaKey", "The paying wallet. The key signs payments and the agent's reports"],
  ["ownerAddress", "The only wallet whose signature can release an escalated payment"],
  ["arkivAccessKey, namespace", "The registry to read and write"],
  ["policy or policyProfile", "production (default) or a tuned live clock"],
  ["limits", "Override the per-call ceiling, budgets, thresholds or replay window"],
  ["hcsTopicId", "Optional audit topic"],
  ["proberAddresses", "Arkiv addresses whose probes count"],
  ["mode", "enforce (default) or observe: decide and log, never block"],
  ["awaitApprovalMs", "Wait this long for the owner before throwing LeashEscalated"],
  ["autoReport", "File reports after each paid call (default true)"],
];

function Section({ id, title, kicker, children }: { id: string; title: string; kicker: string; children: ReactNode }) {
  return (
    <section id={id} className="glass doc-section" aria-labelledby={`${id}-h`}>
      <span className="kicker">{kicker}</span>
      <h2 id={`${id}-h`} style={{ marginTop: 12 }}>{title}</h2>
      {children}
    </section>
  );
}

export default function Integrate() {
  return (
    <>
      <div className="section-head">
        <div>
          <span className="kicker">Integrate</span>
          <h1 style={{ marginTop: 12 }}>Put your agent on a leash</h1>
          <p className="lead">Wrap an x402 client with the SDK, or let an LLM pay only through the MCP server. Merchants declare themselves in ENSv2 to be recognised.</p>
        </div>
      </div>
      <nav className="row start" aria-label="On this page" style={{ gap: 10, marginBottom: 22 }}>
        <a className="btn" href="#run">Run it</a>
        <a className="btn" href="#sdk">SDK</a>
        <a className="btn" href="#mcp">MCP server</a>
        <a className="btn" href="#merchants">Merchants</a>
        <a className="btn" href="#registry">Read the registry</a>
      </nav>

      <Section id="run" title="Run the stack" kicker="Start here">
        <p>Node 22.13 or later and pnpm. Everything runs on public testnets with test tokens.</p>
        <CodeBlock label="Terminal" code={RUN} />
      </Section>

      <Section id="sdk" title="SDK: guard a real x402 client" kicker="@leash/guard">
        <p>The guard hooks the client&apos;s payment creation, decides before anything is signed, and files a signed report after delivery. Use <code>guardedFetch</code> so the guard knows the real origin; a call around it has none, and always escalates.</p>
        <CodeBlock label="Set up" lang="TypeScript" code={SDK} />
        <CodeBlock label="Pay" lang="TypeScript" code={SDK_USE} />
        <CodeBlock label="Dry runs and explanations" lang="TypeScript" code={SDK_MORE} />
        <div className="scroll">
          <table>
            <caption>Configuration</caption>
            <thead><tr><th scope="col">Field</th><th scope="col">What it does</th></tr></thead>
            <tbody>{CONFIG.map(([k, v]) => <tr key={k}><td><code>{k}</code></td><td>{v}</td></tr>)}</tbody>
          </table>
        </div>
        <p className="muted" style={{ marginTop: 12 }}>A developer can still call the raw client, so the SDK does not prevent bypass. The MCP server does.</p>
      </Section>

      <Section id="mcp" title="MCP server: the LLM pays only through Leash" kicker="@leash/mcp">
        <p>The server holds the signer. There is no approve tool, results carry structured fields only, and the body of a paid call comes back length-capped and marked <code>untrusted: true</code>. It speaks MCP over stdio and logs to stderr.</p>
        <p><code>pnpm --dir</code> starts the server in the repo, so it finds <code>.env</code> and shares the console&apos;s database: an approval you sign there reaches the server.</p>
        <CodeBlock label="Claude Desktop: claude_desktop_config.json" lang="JSON" code={MCP_DESKTOP} />
        <CodeBlock label="Claude Desktop on Windows: the same entry, through cmd" lang="JSON" code={MCP_WINDOWS} />
        <CodeBlock label="Claude Code" lang="Terminal" code={MCP_CODE} />
        <div className="scroll">
          <table>
            <caption>Tools</caption>
            <thead><tr><th scope="col">Tool</th><th scope="col">Input</th><th scope="col">Returns</th></tr></thead>
            <tbody>{TOOLS.map(([t, i, o]) => <tr key={t}><td><code>{t}</code></td><td>{i}</td><td>{o}</td></tr>)}</tbody>
          </table>
        </div>
        <p className="muted" style={{ marginTop: 12 }}>On <code>pending_approval</code>, call <code>leash_await_approval</code>, then <code>leash_pay_request</code> again with the same URL. The owner signs in the console.</p>
      </Section>

      <Section id="merchants" title="Merchants: declare yourself in ENSv2" kicker="Be recognised">
        <p>Set <code>leash.*</code> text records on your name&apos;s resolver, and name yourself in each 402. Without a declaration every payment to you asks the agent&apos;s owner; with one, a NEW merchant can take micro payments straight away, and a 402 that contradicts it is denied as a spoof.</p>
        <CodeBlock label="Text records, example: the weather merchant" code={ENS_RECORDS} />
        <CodeBlock label="x402 route config" lang="TypeScript" code={X402} />
        <p>To file rebuttals, grant <code>ROLE_SET_TEXT</code> for only the <code>leash.rebuttal</code> key to the wallet that will sign them. A rebuttal never unblocks by itself: it buys one paid probe of your <code>leash.probeUrl</code>, which must return what <code>leash.schema</code> declares.</p>
      </Section>

      <Section id="registry" title="Read the registry yourself" kicker="Arkiv">
        <p>The registry is public. Anyone can read it with no key or wallet, and anyone can write to it, which is why every reader re-verifies each row against Mirror Node before it counts.</p>
        <CodeBlock label="Terminal" code={QUERY} />
        <p>Schema: <a href={`${REPO}/blob/master/arkiv/schema.md`} target="_blank" rel="noreferrer">arkiv/schema.md</a>. How the decision uses it: <Link href="/docs#proof">proof of payment</Link>.</p>
      </Section>
    </>
  );
}
