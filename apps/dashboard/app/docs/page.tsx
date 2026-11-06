import Link from "next/link";
import type { ReactNode } from "react";
import { DEFAULT_LIMITS, HARD_CAP_MULTIPLE, PROBE_BUDGET_PER_DAY, PROBE_USD, PROFILES, REASON_CODES, REPORTER_BAD_PER_DAY, SOFT_CAPS } from "@leash/core";
import { REASON_TEXT } from "./reasons";
import { Chip } from "../components/bits";
import { REPO } from "../components/footer";

export const metadata = { title: "Docs", description: "How Leash decides: verdicts, the risk score, standing, limits, proof of payment, expiry, outages and failure modes." };

const P = PROFILES.production;
const L = DEFAULT_LIMITS;
const day = (s: number) => {
  const [n, unit] = s % 86400 === 0 ? [s / 86400, "day"] : s % 3600 === 0 ? [s / 3600, "hour"] : s % 60 === 0 ? [s / 60, "minute"] : [s, "second"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
};
const usd = (n: number) => `$${n.toFixed(2)}`;

const TOC: [string, string][] = [
  ["overview", "Overview"], ["verdicts", "Verdicts and reasons"], ["pipeline", "How a decision is made"], ["score", "The risk score"],
  ["standing", "Standing"], ["limits", "Limits and caps"], ["proof", "Proof of payment"], ["forgiveness", "Expiry and forgiveness"],
  ["rebuttal", "Probation, rebuttal and probes"], ["outages", "Outages and safe mode"], ["approvals", "Replay and approvals"],
  ["failures", "Failure modes, tested live"], ["profiles", "Policy clocks"], ["schema", "Registry schema"], ["ens", "ENS records"],
];

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="glass doc-section" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{title}</h2>
      {children}
    </section>
  );
}

function Table({ caption, head, rows }: { caption: string; head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="scroll">
      <table>
        <caption>{caption}</caption>
        <thead><tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => (j === 0 ? <th key={j} scope="row" style={{ textTransform: "none", letterSpacing: 0, fontSize: "0.92rem", color: "var(--ink)", borderBottom: 0 }}>{c}</th> : <td key={j}>{c}</td>))}</tr>)}</tbody>
      </table>
    </div>
  );
}

const FAILURES: [string, string, string][] = [
  ["F1", "Spoof or prompt injection", "A spoof claiming weather's name was denied; a 402 whose payTo was instructions was denied before signing; through MCP, a paid body came back marked untrusted and no other result carried merchant text."],
  ["F2", "Merchant takes payment, returns junk", "0.03 to a NEW merchant escalated; two clusters blocked lemon; the next agent was denied without paying."],
  ["F3", "Price above the declared maximum, bait and switch", "0.30 against a 0.25 maximum was denied; a doubled price escalated price-drift."],
  ["F4", "Slow ramp", "Ten 0.005 payments filled the cap; the next escalated; a real 0.20 request was denied by the hard cap."],
  ["F5", "Unknown merchant", "Rogue, with no ENS name, escalated every time and was never paid."],
  ["F6", "Replay and stale challenges", "A 402 held 61 s by the network was denied; replay was still denied after a real process restart."],
  ["F7", "ENS or Arkiv outage", "Through relays that were really cut: a cached block still denied, a guard with no cache escalated, safe mode came and went by itself, and a held report was filed after recovery."],
  ["F8", "Griefing with bad reports", "Three wallets from one funding cluster could not block; forged and flipped rows were ignored."],
  ["F9", "Settlement failure", "With a facilitator failing at settle, nothing was paid twice and retries waited for Mirror Node; a dropped connection after paying was reported once it settled."],
  ["F10", "Approval abuse", "The eleventh escalation in an hour was denied; approvals were single use, bound to one challenge and expired after 120 s; the MCP server has no approve tool."],
  ["F11", "Scam, wait, scam again", "Block, probation, a hold on the next bad report, then strike 2 with the block doubled."],
  ["F12", "Identity rotation", "A merchant at a blocked payTo with no ENS name was still denied; NEW merchants share one daily budget."],
  ["F13", "Rebuttal abuse", "No-role and off-list rebuttals were refused, a second rebuttal bought no second probe, and a forged passing probe was ignored."],
  ["F14", "Bypass", "The raw client was stopped as unknown-origin; an approval forged in the database did not pay."],
  ["F15", "Spam and time manipulation", "Future-dated and wrong-time rows were ignored, and a 210-row flood could not hide the real reports."],
];

export default function Docs() {
  return (
    <>
      <div className="section-head">
        <div>
          <span className="kicker">Docs</span>
          <h1 style={{ marginTop: 12 }}>How Leash decides</h1>
          <p className="lead">Every number on this page is read from the engine that makes the decisions, so it cannot drift from the code.</p>
        </div>
      </div>
      <details className="glass panel toc-mobile">
        <summary>On this page</summary>
        <ol style={{ margin: "10px 0 0", paddingLeft: 20 }}>{TOC.map(([id, t]) => <li key={id}><a href={`#${id}`}>{t}</a></li>)}</ol>
      </details>
      <div className="docs">
        <nav className="glass toc" aria-label="On this page">
          <p className="label">On this page</p>
          <ol>{TOC.map(([id, t]) => <li key={id}><a href={`#${id}`}>{t}</a></li>)}</ol>
        </nav>
        <div>
          <Section id="overview" title="Overview">
            <p>AI agents pay merchants over x402: a server answers <code>402 Payment Required</code>, the agent signs a payment and retries. Nothing in x402 says whether the merchant will deliver, or is who it claims to be. Leash sits in the agent&apos;s payment hook and answers that before anything is signed.</p>
            <p>It reads a shared registry that every Leash agent writes to. One agent&apos;s loss becomes a signed, proof-backed report that protects every other agent. No verdict is permanent: blocks end, evidence expires, and a merchant earns trust back through probation.</p>
            <ul>
              <li><strong>SDK</strong> (<code>@leash/guard</code>): wraps a real x402 client. <Link href="/integrate#sdk">Set it up</Link>.</li>
              <li><strong>MCP server</strong> (<code>@leash/mcp</code>): the LLM pays only through it, and cannot approve. <Link href="/integrate#mcp">Connect it</Link>.</li>
              <li><strong>Owner console</strong>: approvals signed with the owner&apos;s wallet, on the operator&apos;s machine.</li>
            </ul>
          </Section>

          <Section id="verdicts" title="Verdicts and reasons">
            <p>Each payment gets one verdict, and every reason that fired. Any DENY reason makes the verdict DENY; otherwise any ESCALATE reason makes it ESCALATE; otherwise ALLOW.</p>
            <div className="row start" style={{ gap: 8, marginBottom: 12 }}><Chip v="ALLOW" /><Chip v="ESCALATE" /><Chip v="DENY" /></div>
            <Table caption="Every reason code" head={["Reason", "Verdict", "When"]} rows={REASON_CODES.map((c) => [<code key={c}>{c}</code>, REASON_TEXT[c][0], REASON_TEXT[c][1]])} />
          </Section>

          <Section id="pipeline" title="How a decision is made">
            <ol>
              <li><strong>Parse the 402.</strong> Anything that is not a plain account id or whole-number amount is refused and replaced, so merchant text never reaches a log, card or tool result.</li>
              <li><strong>Read the ENS declaration</strong> the 402 claims, in <code>extra.leashEns</code>, and the merchant&apos;s standing from Arkiv, in parallel.</li>
              <li><strong>Re-verify the evidence.</strong> Every report row is checked on Mirror Node before it counts. Probes count only if an allow-listed prober created them; rebuttals only if the ENS role holder signed one with a listed reason.</li>
              <li><strong>Replay the evidence</strong> into a standing with the same pure engine every reader uses, then score the payment.</li>
              <li><strong>Apply the hard rules</strong>, the limits for that standing, the budgets, and the outage rules.</li>
              <li><strong>Record</strong> the decision: one stored row, one structured log line and one HCS audit message, with its latency.</li>
            </ol>
            <p className="muted">Measured on the real networks: p95 of 2 ms with warm caches and 2.3 s cold, against targets of 800 ms and 3 s.</p>
          </Section>

          <Section id="score" title="The risk score">
            <p>R runs from 0 to 100. It rises with bad evidence, money lost and amount at risk, and falls with trust and value delivered.</p>
            <pre className="glass" style={{ padding: 14, overflowX: "auto", boxShadow: "none" }}>{`R = 100 × (0.30·bad + 0.20·loss + 0.15·trust + 0.20·exposure + 0.15·identity)

bad      = 1 − e^(−b)              b: decayed bad evidence, one per cluster
loss     = L / (L + D + 0.05)      L: money lost, D: value delivered
trust    = e^(−g / 2)              g: decayed good evidence
exposure = min(1, A / (D + 0.02))  A: this payment
identity = base(standing) + 0.1·min(strikes, 3)`}</pre>
            <p>Identity base: ESTABLISHED 0, NEW 0.5, BLOCKED 0.5, PROBATION 0.7, UNKNOWN 1. Under {L.allowThreshold} is clear; {L.allowThreshold} or more escalates; {L.denyThreshold} or more denies with two bad clusters. One cluster alone can never cause a DENY, whatever the score.</p>
            <p className="muted">Examples from the spec: a NEW merchant and a $0.005 payment score 27.5 (ALLOW). After one bad cluster, 42.0 (ESCALATE). After two, the merchant is BLOCKED.</p>
          </Section>

          <Section id="standing" title="Standing">
            <Table caption="Standing transitions" head={["From", "To", "When"]} rows={[
              [<Chip key="u" v="UNKNOWN" />, <Chip key="n" v="NEW" />, "The merchant declares itself in ENS."],
              [<Chip key="n" v="NEW" />, <Chip key="e" v="ESTABLISHED" />, `Good reports from 3 clusters, $0.10 delivered, little bad evidence, ${day(P.firstGoodAgeSec)} since the first good report, and no strikes.`],
              [<><Chip v="NEW" /> <Chip v="ESTABLISHED" /></>, <Chip key="b" v="BLOCKED" />, "Bad reports from 2 independent clusters (3 if a contested ESTABLISHED merchant) and enough weight. Wallets under 24 hours old count half."],
              [<Chip key="b" v="BLOCKED" />, <Chip key="p" v="PROBATION" />, `The block runs its length: ${P.blockSec.map(day).join(", then ")}, by strike. Or earlier: one rebuttal, a passing probe, and ${day(P.rebuttalCooldownSec)} of cooldown.`],
              [<Chip key="p" v="PROBATION" />, <Chip key="b2" v="BLOCKED" />, `One bad cluster starts a hold of ${day(P.holdSec)}, when every payment escalates; a second blocks again, one strike higher.`],
              [<Chip key="p" v="PROBATION" />, <Chip key="e2" v="ESTABLISHED" />, `Good reports from 3 clusters, $0.15 delivered, no bad reports, and at least ${day(P.probationMinUnitSec)} per strike, up to 3 strikes.`],
              [<Chip key="p" v="PROBATION" />, <Chip key="n2" v="NEW" />, `${day(P.probationToNewSec)} pass quietly. Waiting alone never reaches ESTABLISHED.`],
            ]} />
          </Section>

          <Section id="limits" title="Limits and caps">
            <Table caption="Per merchant, by standing" head={["Standing", "Pays alone up to", "24-hour soft cap", "Hard cap"]} rows={[
              [<Chip key="n" v="NEW" />, "$0.01", usd(SOFT_CAPS.NEW), usd(SOFT_CAPS.NEW * HARD_CAP_MULTIPLE)],
              [<Chip key="e" v="ESTABLISHED" />, "Half its delivered value, up to its declared max and $1.00", usd(SOFT_CAPS.ESTABLISHED), usd(SOFT_CAPS.ESTABLISHED * HARD_CAP_MULTIPLE)],
              [<Chip key="p" v="PROBATION" />, "$0.05 divided by strikes, at least $0.01", usd(SOFT_CAPS.PROBATION), usd(SOFT_CAPS.PROBATION * HARD_CAP_MULTIPLE)],
              [<Chip key="u" v="UNKNOWN" />, "Never: always asks", "–", "–"],
              [<Chip key="b" v="BLOCKED" />, "Never: denied", "–", "–"],
            ]} />
            <p style={{ marginTop: 12 }}>Across all merchants: {usd(L.perCallCeiling)} per call, {usd(L.sessionBudget)} per session, {usd(L.dailyBudget)} per day, and {usd(L.newIdentityDailyBudget)} a day across NEW merchants. With a stale cache the soft caps halve. Above the soft cap the owner is asked; above the hard cap, never.</p>
          </Section>

          <Section id="proof" title="Proof of payment">
            <p>Anyone can write a row to Arkiv, so every row is hostile until checked. A report counts only if all of these hold:</p>
            <ol>
              <li>Mirror Node shows a SUCCESS transfer of the pinned USDC, from the named payer to this payee, of at least the stated amount.</li>
              <li>The consensus time on Mirror Node matches the row, which uses Mirror&apos;s time, never its own.</li>
              <li>The payer&apos;s Hedera key signed the report: payee, transaction id, outcome, amount and the writer&apos;s address.</li>
              <li>One report per payment, one bad report per payer per payee per day, and at most {REPORTER_BAD_PER_DAY} bad reports a day per reporter across payees.</li>
            </ol>
            <p>Wallets are grouped by the account that funded them, so many wallets from one funder are one cluster. The reader takes the latest 200 reports that verify, reading past rows that do not; past 1,000 rows the read counts as incomplete, and the guard asks rather than allows.</p>
          </Section>

          <Section id="forgiveness" title="Expiry and forgiveness">
            <p>Reports expire on Arkiv after {day(P.reportTtlSec)}, and strikes are forgotten after {day(P.strikeMemorySec)} with no block. Expiry is not a cleanup job: it is how a merchant is forgiven, enforced by the storage itself. Blocks double with each strike, so a merchant that scams, waits and scams again is blocked for longer each time, and is never blocked forever.</p>
          </Section>

          <Section id="rebuttal" title="Probation, rebuttal and probes">
            <p>A blocked merchant gets no payments, so it could never prove itself. The answer is a probe: a real paid call by the prober, at most {usd(PROBE_USD)} each and {usd(PROBE_BUDGET_PER_DAY)} a day.</p>
            <ul>
              <li>A rebuttal is signed by the wallet holding <code>ROLE_SET_TEXT</code> for the <code>leash.rebuttal</code> key on the merchant&apos;s ENSv2 resolver, with one of five fixed reasons. Only the first per block counts.</li>
              <li>It never unblocks by itself. It buys one probe. A passing probe ends the block early, after the cooldown, in PROBATION; a failing one keeps it blocked.</li>
              <li>In probation the prober retests once a day. Probes all count as one cluster, so a probe alone can never supply the three clusters recovery needs.</li>
            </ul>
          </Section>

          <Section id="outages" title="Outages and safe mode">
            <Table caption="What a failure does to decisions" head={["Down", "Fallback", "Effect"]} rows={[
              ["ENS", `Cached declaration: fresh ${day(P.ensFreshSec)}, usable stale for ${day(P.ensStaleSec)}`, "Stale: caps halve and a mismatch escalates. No cache: UNKNOWN, so ESCALATE."],
              ["Arkiv", "Cached standing", `A cached block still denies until it ends; ESTABLISHED is usable for ${day(P.standingStaleSec)} with halved caps; otherwise ESCALATE registry-unavailable.`],
              ["Mirror Node", "Verdicts cached by transaction", "Evidence it cannot check escalates, never denies. Reports wait in the outbox until settlement is confirmed."],
              ["Facilitator", "Merchant-side", "After a failed settle, Mirror Node is asked before any new attempt; unknown is ESCALATE."],
              ["HCS", "Outbox", "None: the audit trail is delayed, never blocking."],
              ["Two of ENS, Arkiv, Mirror", "Safe mode", "Every payment escalates; a cached block still denies. It ends after three healthy reads in a row."],
            ]} />
          </Section>

          <Section id="approvals" title="Replay and approvals">
            <p>A challenge is hashed from its scheme, network, asset, amount, payee, resource and extras. Paying the same hash again within {L.replayWindowSec} seconds is a replay, unless the caller marks it as a deliberate repeat. The replay table, spend ledger, approvals and outbox live in SQLite, so they survive a restart.</p>
            <p>An escalation creates a card with structured fields only. The owner approves with a wallet signature over the approval id, the challenge hash and an expiry {L.replayWindowSec} seconds out. The guard checks that signature against the owner&apos;s address when it is used, once, so a row written straight into the database cannot approve anything.</p>
          </Section>

          <Section id="failures" title="Failure modes, tested live">
            <p>Each failure mode in the spec was caused for real on Hedera testnet, Arkiv and Sepolia, with real merchants and real local servers for faults a public merchant cannot show. 55 checks pass. The runner is <a href={`${REPO}/blob/master/apps/demo/src/failures.ts`} target="_blank" rel="noreferrer">apps/demo/src/failures.ts</a>.</p>
            <Table caption="F1 to F15" head={["", "Failure", "What happened on the testnets"]} rows={FAILURES.map(([id, name, what]) => [id, name, what])} />
          </Section>

          <Section id="profiles" title="Policy clocks">
            <p>Production uses the spec&apos;s durations: blocks of {P.blockSec.map(day).join(", ")}, a hold of {day(P.holdSec)} and {day(P.reportTtlSec)} of evidence. The demo uses the same engine on a shorter clock, shown in a banner whenever it is on. <code>LEASH_LIVE_BLOCK_SEC</code> and <code>LEASH_LIVE_DAY_SEC</code> set it; by default one policy day is 18 seconds and blocks last 1, 2 and 5 minutes.</p>
          </Section>

          <Section id="schema" title="Registry schema">
            <Table caption="Arkiv entities" head={["Entity", "Written by", "Attributes"]} rows={[
              ["leash.report", "The paying agent, after Mirror confirms settlement", "ns, payee, domain, ens, outcome, txId, payer, payerSig, consensusTs, amountMicroUsd, reason, v"],
              ["leash.probe", "An allow-listed prober", "ns, payee, result, txId, consensusTs, amountMicroUsd, deliveryDigest, v"],
              ["leash.rebuttal", "The rebuttal desk, signed by the ENS role holder", "ns, payee, ens, reason, evidenceHash, episodeStart, filedAt, signer, signature, v"],
            ]} />
            <p style={{ marginTop: 12 }}>No bodies, paths or queries are stored: a probe keeps only a hash of what it received, and a rebuttal only a hash of its evidence. Full details in <a href={`${REPO}/blob/master/arkiv/schema.md`} target="_blank" rel="noreferrer">arkiv/schema.md</a>.</p>
          </Section>

          <Section id="ens" title="ENS records">
            <p>A merchant declares itself with text records on its ENSv2 name, and names it in the 402 as <code>extra.leashEns</code>. See <Link href="/integrate#merchants">the merchant setup</Link>.</p>
          </Section>
        </div>
      </div>
    </>
  );
}
