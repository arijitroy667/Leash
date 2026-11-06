import Link from "next/link";
import { Chip } from "./components/bits";
import { REPO } from "./components/footer";
import { Icon } from "./components/icons";
import { LiveFeed, LiveStats } from "./components/live";

export const metadata = { title: { absolute: "Leash: payee safety for AI agents on x402" } };

const VERDICTS = [
  { v: "ALLOW", head: "Pay now", body: "A known merchant, an amount inside its limit and a low risk score. The agent pays with no human in the loop." },
  { v: "ESCALATE", head: "Ask the owner", body: "An unknown merchant, a price above the limit, a medium score, probation or an outage. Only the owner's wallet can release it." },
  { v: "DENY", head: "Never pay this", body: "A blocked merchant, a spoofed payTo, a replay or a price above what the merchant declared. Nothing is signed." },
];

const STEPS = [
  { t: "Identify", d: "The merchant's ENSv2 name declares its payTo, network, asset, maximum price and domains. A 402 that contradicts it is denied." },
  { t: "Read the history", d: "Arkiv holds reports from every agent that paid this merchant, each signed by its payer and written only after settlement." },
  { t: "Re-verify", d: "Each report is checked on Hedera Mirror Node: a real USDC transfer from that payer to that payee, in that amount." },
  { t: "Decide", d: "A five-factor risk score, the merchant's standing, spend caps and hard rules give ALLOW, ESCALATE or DENY before anything is signed." },
  { t: "Report", d: "After delivery the guard files its own signed report, and an audit message to Hedera Consensus Service." },
];

const WHY = [
  { icon: "doc" as const, tone: "tone-lime", t: "Proof, not points", d: "A report counts only with a settled payment behind it. Forged, flipped and flooded rows are ignored, and one funding cluster can never block a merchant." },
  { icon: "check" as const, tone: "tone-cyan", t: "Forgiving by design", d: "Blocks end, strikes are forgotten after 60 days, and a blocked merchant can rebut once, pass a paid probe and recover through probation." },
  { icon: "shield" as const, tone: "tone-violet", t: "Fails safe", d: "If ENS, Arkiv or Mirror Node fails, payments escalate to the owner. An outage never turns into a silent ALLOW." },
  { icon: "x" as const, tone: "tone-pink", t: "The LLM cannot approve", d: "There is no approve tool. Only the owner's signature, bound to one challenge for 120 seconds, releases an escalated payment." },
];

const TRACKS = [
  { name: "Hedera x402", d: "Agents pay merchants in test USDC through the Blocky402 facilitator. Mirror Node gates every report, and every decision goes to an HCS audit topic." },
  { name: "Arkiv", d: "The registry itself: wallet-owned entities with attribute queries, and expiry as the way a merchant is forgiven." },
  { name: "ENSv2", d: "Merchants declare themselves in leash.* text records on a Permissioned Resolver, with a per-key role for rebuttals." },
];

export default function Landing() {
  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <div>
          <span className="kicker">ETHGlobal Mumbai · Hedera x402 · Arkiv · ENSv2</span>
          <h1 id="hero-title">Your agent pays. <span className="hl">Leash</span> checks who it is paying.</h1>
          <p className="lead">A shared, proof-of-payment-backed safety registry and guard for AI agents paying over x402. One agent&apos;s loss protects every other agent, no verdict is permanent, and a merchant coming out of a block earns trust back through probation.</p>
          <div className="cta">
            <Link className="btn primary big" href="/demo"><Icon name="bolt" /> Watch it live</Link>
            <Link className="btn big" href="/explorer">Explore merchants</Link>
            <Link className="btn pink big" href="/integrate">Add it to your agent</Link>
          </div>
        </div>
        <div className="glass panel" aria-label="Latest decisions">
          <p className="label">Happening on Hedera now</p>
          <LiveFeed limit={4} compact />
        </div>
      </section>

      <section className="section" aria-labelledby="verdicts">
        <div className="section-head"><h2 id="verdicts">Three verdicts, before anything is signed</h2></div>
        <div className="grid-3">
          {VERDICTS.map((x) => (
            <article key={x.v} className="glass verdict-card lift">
              <h3><Chip v={x.v} /> {x.head}</h3>
              <p className="muted" style={{ margin: 0 }}>{x.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section" aria-labelledby="how">
        <div className="section-head"><h2 id="how">How a payment is checked</h2><Link className="btn" href="/docs">Read the docs <Icon name="arrow" /></Link></div>
        <ol className="steps">
          {STEPS.map((s) => <li key={s.t} className="glass"><h3>{s.t}</h3><p className="muted" style={{ margin: 0 }}>{s.d}</p></li>)}
        </ol>
      </section>

      <section className="section" aria-labelledby="live-registry">
        <div className="section-head">
          <div>
            <h2 id="live-registry">The registry, live</h2>
            <p className="muted" style={{ margin: 0 }}>These counts fall as entities expire: on Arkiv, expiry is how the registry forgives.</p>
          </div>
          <Link className="btn" href="/explorer">Open the explorer <Icon name="arrow" /></Link>
        </div>
        <LiveStats />
      </section>

      <section className="section" aria-labelledby="why">
        <div className="section-head"><h2 id="why">Why it holds up</h2></div>
        <div className="grid-2">
          {WHY.map((w) => (
            <article key={w.t} className={`glass panel lift ${w.tone}`}>
              <h3 className="row start" style={{ gap: 10 }}><Icon name={w.icon} /> {w.t}</h3>
              <p style={{ margin: 0 }}>{w.d}</p>
            </article>
          ))}
        </div>
        <p className="muted" style={{ marginTop: 16 }}>All fifteen failure modes in the spec were caused for real on the testnets, from spoofed merchants to cut connections and flooded registries. <Link href="/docs#failures">See what was tested</Link>.</p>
      </section>

      <section className="section" aria-labelledby="tracks">
        <div className="section-head"><h2 id="tracks">Built on</h2></div>
        <div className="grid-3">
          {TRACKS.map((t) => <article key={t.name} className="glass panel"><h3>{t.name}</h3><p className="muted" style={{ margin: 0 }}>{t.d}</p></article>)}
        </div>
      </section>

      <section className="section glass panel tone-lime" aria-labelledby="start" style={{ padding: "28px 22px" }}>
        <h2 id="start">Put your agent on a leash</h2>
        <p className="lead">One SDK call wraps your x402 client, or run the MCP server and let your LLM pay through it. Either way, the owner stays in charge.</p>
        <div className="cta">
          <Link className="btn primary big" href="/integrate">SDK and MCP setup</Link>
          <a className="btn big" href={REPO} target="_blank" rel="noreferrer">Source on GitHub</a>
        </div>
      </section>
    </>
  );
}
