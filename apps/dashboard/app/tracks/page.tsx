"use client";
import { useEffect, useState, type ReactNode } from "react";
import { ago, Chip, HASHSCAN, hashscanTx, short, Skeleton, usd } from "../components/bits";
import { REPO } from "../components/footer";
import { usePoll } from "../components/live";

const ARKIV_X = "https://rabdi.explorer.arkiv.network";
const ETHERSCAN = "https://sepolia.etherscan.io";
const TABS = [["hedera", "Hedera"], ["arkiv", "Arkiv"], ["ens", "ENS"]] as const;
type Tab = (typeof TABS)[number][0];

const A = ({ href, children }: { href: string; children: ReactNode }) => <a className="mono" href={href} target="_blank" rel="noreferrer">{children}</a>;
const doc = (path: string) => `${REPO}/blob/master/${path}`;

/** A track's own qualification list (sponsor_tracks.md), each item with its status and where to check it. */
type Req = [status: "done" | "todo" | "no", text: string, proof?: ReactNode];
const STATUS = { done: ["good", "Done"], todo: ["pending", "To do"], no: ["UNKNOWN", "Not used"] } as const;
function Checklist({ title, items }: { title: string; items: Req[] }) {
  return (
    <div className="glass panel">
      <p className="label">{title}</p>
      <div className="scroll">
        <table>
          <thead><tr><th scope="col">Status</th><th scope="col">Requirement</th><th scope="col">Where to check</th></tr></thead>
          <tbody>{items.map(([s, text, proof]) => (
            <tr key={text}><td><span className={`chip ${STATUS[s][0]}`}>{STATUS[s][1]}</span></td><td>{text}</td><td>{proof}</td></tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

function Panel({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="glass panel" style={{ marginTop: 18 }}>
      <h2 style={{ fontSize: "1.2rem", marginTop: 0 }}>{title}</h2>
      {note && <p className="muted" style={{ marginTop: 0 }}>{note}</p>}
      {children}
    </section>
  );
}

function useTrack(t: Tab, ns: string) {
  return usePoll<any>(`/api/tracks?t=${t}${ns ? `&ns=${encodeURIComponent(ns)}` : ""}`, 30000);
}
function Loading({ q }: { q: { data: any; error: string } }) {
  if (q.error) return <p className="err" role="alert">{q.error}</p>;
  return q.data ? null : <div style={{ marginTop: 18 }}><Skeleton lines={5} /></div>;
}

function Hedera({ ns }: { ns: string }) {
  const q = useTrack("hedera", ns);
  const feed = usePoll<any>("/api/feed", 15000);
  const d = q.data;
  const first = d?.payments?.find((p: any) => p.kind === "report");
  return (
    <>
      <Checklist title="Hedera: AI Agents That Pay, qualification" items={[
        ["done", "An x402-protected endpoint that settles on Hedera testnet through a listed facilitator (Blocky402)", <A key="m" href="https://leash-merchant-weather.vercel.app/">leash-merchant-weather</A>],
        ["done", "An agent completes a paid request end to end with no human approving", first ? <A key="p" href={hashscanTx(first.txId)}>{short(first.txId, 10)}</A> : "below"],
        ["done", "Public GitHub repo, README with setup, architecture, payment flow and a settled transaction ID", <A key="r" href={`${REPO}#proof-on-public-networks`}>README proof table</A>],
        ["todo", "Demo video of 5 minutes or less showing a payment settle, linked to HashScan", "Recorded before submission"],
      ]} />
      <div style={{ marginTop: 18 }}>
        <Checklist title="Hedera: extra points" items={[
          ["done", "Spending controls: budgets, per-merchant limits, owner approval above a set amount", "Spending controls, below"],
          ["done", "An HCS topic as a tamper-evident audit log of each agent's spending", d?.topic ? <A key="t" href={`${HASHSCAN}/topic/${d.topic}`}>topic {d.topic}</A> : null],
          ["done", "Settling in an HTS token: USDC", d ? <A key="u" href={`${HASHSCAN}/token/${d.usdc}`}>USDC {d.usdc}</A> : null],
          ["no", "Agent identity and reputation through HCS-14 or ERC-8004"],
          ["no", "Multi-agent negotiation (A2A or ACP)"],
          ["no", "Scheduled Transactions; Hedera Agent Kit or Network MCP"],
        ]} />
      </div>
      <Loading q={q} />
      {d && (
        <>
          <Panel title="On Hedera testnet" note="The accounts and token every payment and audit message use.">
            <dl className="kv">
              <dt>Facilitator (fee payer)</dt><dd><A href={`${HASHSCAN}/account/${d.facilitator}`}>{d.facilitator}</A> Blocky402, listed in Hedera's docs</dd>
              <dt>Settlement token</dt><dd><A href={`${HASHSCAN}/token/${d.usdc}`}>{d.usdc}</A> testnet USDC (HTS)</dd>
              {d.topic && <><dt>Audit topic</dt><dd><A href={`${HASHSCAN}/topic/${d.topic}`}>{d.topic}</A> every decision, report, approval, probe and rebuttal</dd></>}
              <dt>Agent and prober accounts</dt><dd>{d.accounts.map((a: string) => <span key={a} style={{ marginRight: 10 }}><A href={`${HASHSCAN}/account/${a}`}>{a}</A></span>)}</dd>
            </dl>
          </Panel>
          <Panel title="Spending controls" note="Enforced by the guard before anything is signed. Approvals are signed by the owner's wallet, single-use, and expire; the MCP server has no approve tool.">
            <dl className="kv">
              <dt>Per call ceiling</dt><dd>{usd(d.limits.perCallCeiling)}</dd>
              <dt>Session budget</dt><dd>{usd(d.limits.sessionBudget)}</dd>
              <dt>Daily budget</dt><dd>{usd(d.limits.dailyBudget)}, and {usd(d.limits.newIdentityDailyBudget)} a day to new merchants</dd>
              <dt>Per-merchant caps</dt><dd>NEW {usd(d.limits.softCaps.NEW)} · ESTABLISHED {usd(d.limits.softCaps.ESTABLISHED)} · PROBATION {usd(d.limits.softCaps.PROBATION)} · hard cap {d.limits.hardCapMultiple}×</dd>
              <dt>Verdict bands</dt><dd>ALLOW under {d.limits.allowThreshold} · ask the owner between · DENY at {d.limits.denyThreshold} or above</dd>
            </dl>
          </Panel>
          <Panel title={`USDC payments (${d.payments.length})`} note={`Every payment that filed a report or probe in ${d.namespace}. The transaction's account is the facilitator; the USDC moves from the agent to the merchant.`}>
            <div className="scroll" style={{ maxHeight: 460 }}>
              <table>
                <thead><tr><th scope="col">What</th><th scope="col">Merchant</th><th scope="col">Payer</th><th scope="col">Amount</th><th scope="col">When</th><th scope="col">HashScan</th></tr></thead>
                <tbody>{d.payments.map((p: any) => (
                  <tr key={`${p.kind}${p.txId}`}>
                    <td><Chip v={p.outcome}>{p.kind} {p.outcome}</Chip></td>
                    <td>{p.ens ?? <span className="mono">{p.payee}</span>}</td>
                    <td className="mono">{p.payer ?? "prober"}</td>
                    <td className="num">{usd(p.amountUsd)}</td>
                    <td className="muted">{ago(p.at)}</td>
                    <td><A href={hashscanTx(p.txId)}>{short(p.txId, 9)}</A></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
      <Panel title={`HCS audit messages${feed.data?.total ? ` (${feed.data.total} on the topic)` : ""}`} note="The newest messages from this deployment's wallets, read through Mirror Node. Each links to its HCS transaction.">
        {!feed.data && <Skeleton lines={4} />}
        <div className="scroll" style={{ maxHeight: 460 }}>
          <table>
            <thead><tr><th scope="col">#</th><th scope="col">Message</th><th scope="col">Merchant</th><th scope="col">When</th><th scope="col">HashScan</th></tr></thead>
            <tbody>{feed.data?.items?.map((i: any) => (
              <tr key={i.seq}>
                <td className="num">{i.seq}</td>
                <td><Chip v={i.verdict ?? i.outcome ?? i.result ?? i.state ?? "PROBATION"}>{i.type}{i.verdict ? ` ${i.verdict}` : i.outcome ? ` ${i.outcome}` : i.result ? ` ${i.result}` : i.state ? ` ${i.state}` : ""}</Chip></td>
                <td>{i.merchant ?? "—"}</td>
                <td className="muted">{ago(i.at)}</td>
                <td>{i.ts ? <A href={`${HASHSCAN}/transaction/${i.ts}`}>{i.ts}</A> : "—"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

function Arkiv({ ns }: { ns: string }) {
  const q = useTrack("arkiv", ns);
  const d = q.data;
  const [kind, setKind] = useState("all");
  const writes = (d?.writes ?? []).filter((w: any) => kind === "all" || w.kind === kind);
  return (
    <>
      <Checklist title="Arkiv: Build on Arkiv, qualification" items={[
        ["done", "Built from scratch at ETHGlobal Mumbai", <A key="d" href={`${REPO}#disclosures`}>README disclosures</A>],
        ["done", "Writes to Arkiv's Rabdi testnet with @arkiv-network/sdk; features users see read from it", "Writes and reads, below"],
        ["done", "README: the wallets that wrote the entities, and one query to run", <A key="w" href={`${REPO}#proof-on-public-networks`}>README: writer wallets and curl query</A>],
        ["done", "/arkiv/schema.md and /arkiv/friction.md", <span key="s"><A href={doc("arkiv/schema.md")}>schema</A> · <A href={doc("arkiv/friction.md")}>friction</A></span>],
        ["done", "One file per judging criterion", <span key="c"><A href={doc("arkiv/reach.md")}>reach</A> · <A href={doc("arkiv/why-arkiv.md")}>why-arkiv</A> · <A href={doc("arkiv/how-you-use-arkiv.md")}>how-you-use-arkiv</A></span>],
        ["todo", "Public repo with an open-source license, and how AI was used", <span key="l"><A href={doc("LICENSE")}>MIT license</A> · repo goes public at submission</span>],
      ]} />
      <Loading q={q} />
      {d && (
        <>
          <Panel title="Reads: the queries the guard runs" note={<>Run just now against {d.namespace}, timed from this server. A read is free and writes no transaction, so it has no hash; the rows it returns are the entities listed below. Rabdi block {d.block}.</>}>
            <div className="scroll">
              <table>
                <thead><tr><th scope="col">Query</th><th scope="col">When it runs</th><th scope="col">Filter</th><th scope="col">Rows</th><th scope="col">Time</th></tr></thead>
                <tbody>{d.queries.map((x: any) => (
                  <tr key={x.what}>
                    <td>{x.what}</td>
                    <td className="muted">{x.when}</td>
                    <td><code style={{ overflowWrap: "anywhere" }}>{x.query}</code></td>
                    <td className="num">{x.error ? <span className="err">failed</span> : x.rows}</td>
                    <td className="num">{x.ms} ms</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </Panel>
          <Panel title={`Writes: every entity in ${d.namespace} (${d.writes.length})`} note="Each entity links to its page on the Rabdi explorer, which shows the transaction that created it. Reports and probes also link the Hedera payment they cite. Expiry is forgiveness: when an entity expires, it stops counting.">
            <div className="row start" role="group" aria-label="Entity kind" style={{ marginBottom: 12 }}>
              {["all", "report", "probe", "rebuttal"].map((k) => <button key={k} type="button" className={kind === k ? "primary" : undefined} aria-pressed={kind === k} onClick={() => setKind(k)}>{k === "all" ? "All" : `leash.${k}`} ({k === "all" ? d.writes.length : d.writes.filter((w: any) => w.kind === k).length})</button>)}
            </div>
            <div className="scroll" style={{ maxHeight: 520 }}>
              <table>
                <thead><tr><th scope="col">Entity</th><th scope="col">Merchant</th><th scope="col">Written by</th><th scope="col">Block</th><th scope="col">Expires in</th><th scope="col">Arkiv</th><th scope="col">Payment</th></tr></thead>
                <tbody>{writes.map((w: any) => (
                  <tr key={w.key}>
                    <td><Chip v={w.kind === "rebuttal" ? "PROBATION" : w.outcome}>{w.kind} {w.outcome}</Chip></td>
                    <td>{w.ens ?? <span className="mono">{w.payee}</span>}</td>
                    <td><A href={`${ARKIV_X}/address/${w.creator}`}>{short(w.creator, 6)}</A></td>
                    <td className="num">{w.createdBlock}</td>
                    <td className="muted">{w.expiresInSec > 86400 ? `${Math.round(w.expiresInSec / 86400)} d` : w.expiresInSec > 3600 ? `${Math.round(w.expiresInSec / 3600)} h` : `${Math.round(w.expiresInSec / 60)} min`}</td>
                    <td><A href={`${ARKIV_X}/entity/${w.key}`}>{short(w.key, 6)}</A></td>
                    <td>{w.txId ? <A href={hashscanTx(w.txId)}>HashScan</A> : "—"}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            {d.writes.length === 0 && <p className="muted">No live entities in this registry. On the live clock they expire 18 minutes after they are written.</p>}
          </Panel>
          <Panel title={`Writer wallets (${d.writers.length})`} note="Each wallet owns the entities it wrote. Its explorer page lists every transaction it sent to Arkiv.">
            <p>{d.writers.map((w: string) => <span key={w} style={{ marginRight: 12 }}><A href={`${ARKIV_X}/address/${w}`}>{w}</A></span>)}</p>
          </Panel>
        </>
      )}
    </>
  );
}

function Ens({ ns }: { ns: string }) {
  const q = useTrack("ens", ns);
  const d = q.data;
  return (
    <>
      <Checklist title="ENS: Best Use of ENSv2, qualification" items={[
        ["done", "Built on ENSv2 on Sepolia, with ENS's own ETHRegistrar, Permissioned Resolver and Universal Resolver", <A key="e" href={`${REPO}#proof-on-public-networks`}>README: ENSv2 features</A>],
        ["done", "ENSv2 is central: the guard reads each merchant's payment policy from its Permissioned Resolver before every payment, and denies a mismatch", "Policy check, below"],
        ["done", "Enhanced Access Control: one wallet may edit only the leash.rebuttal record", "Role matrix, below"],
        ["done", "Functional demo with no hard-coded values: every record on this page is read live from Sepolia", "This page"],
        ["todo", "Live demo link and open-source code on GitHub", "Repo goes public at submission"],
        ["no", "Bonus: agents as namespaces (only merchants have names)"],
      ]} />
      <Loading q={q} />
      {d && (
        <>
          <Panel title="Policy check: what each merchant claims vs. what ENS declares" note="Each merchant's server says which name it is and where to pay. The guard checks that against the name's leash.payTo before paying. A mismatch is DENY declared-mismatch.">
            <div className="scroll">
              <table>
                <thead><tr><th scope="col">Merchant</th><th scope="col">Claims name</th><th scope="col">Asks payment to</th><th scope="col">ENS leash.payTo</th><th scope="col">Result</th></tr></thead>
                <tbody>{d.claims.map((c: any) => (
                  <tr key={c.merchant}>
                    <td>{c.merchant}</td>
                    <td>{c.claim ?? <span className="muted">none</span>}</td>
                    <td>{c.payTo ? <A href={`${HASHSCAN}/account/${c.payTo}`}>{c.payTo}</A> : "—"}</td>
                    <td className="mono">{c.ensPayTo ?? "—"}</td>
                    <td>{c.verdict === "match" ? <Chip v="ALLOW">matches ENS</Chip> : c.verdict === "mismatch" ? <Chip v="DENY">declared-mismatch</Chip> : c.verdict === "no-name" ? <Chip v="ESCALATE">no ENS name</Chip> : <span className="muted">unreachable</span>}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </Panel>
          {d.records.map((m: any) => (
            <Panel key={m.name} title={m.name} note={<>Permissioned Resolver <A href={`${ETHERSCAN}/address/${m.resolver}`}>{m.resolver}</A>, read live through the Universal Resolver.</>}>
              <div className="grid-2">
                <div className="scroll">
                  <table>
                    <caption>Payment policy (text records)</caption>
                    <thead><tr><th scope="col">Key</th><th scope="col">Value</th></tr></thead>
                    <tbody>{m.records.map((r: any) => <tr key={r.key}><td className="mono">{r.key}</td><td style={{ overflowWrap: "anywhere" }}>{r.value ?? <span className="muted">not set</span>}</td></tr>)}</tbody>
                  </table>
                </div>
                <div className="scroll">
                  <table>
                    <caption>Enhanced Access Control: may <span className="mono">{short(d.signer, 6)}</span> set this key?</caption>
                    <thead><tr><th scope="col">Key</th><th scope="col">hasRoles(ROLE_SET_TEXT)</th></tr></thead>
                    <tbody>{m.roles.map((r: any) => <tr key={r.key}><td className="mono">{r.key}</td><td>{r.allowed === null ? <span className="muted">could not read</span> : <Chip v={r.allowed ? "ALLOW" : "DENY"}>{String(r.allowed)}</Chip>}</td></tr>)}</tbody>
                  </table>
                  <p className="muted" style={{ fontSize: "0.86rem" }}>The rebuttal wallet <A href={`${ETHERSCAN}/address/${d.signer}`}>{short(d.signer, 6)}</A> can file a signed rebuttal only where it holds the role, and can never change where payments go.</p>
                </div>
              </div>
            </Panel>
          ))}
          <Panel title="ENSv2 contracts on Sepolia">
            <dl className="kv">
              <dt>ETHRegistrar</dt><dd><A href={`${ETHERSCAN}/address/0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3`}>0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3</A></dd>
              <dt>Universal Resolver</dt><dd><A href={`${ETHERSCAN}/address/0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe`}>0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe</A></dd>
              <dt>Registrations</dt><dd><A href={`${ETHERSCAN}/tx/0xfb221a6208ae20faf5b6730dc08acfeac71b2f6bad80715aaff814ce36bf0427`}>leash-weather.eth</A> · <A href={`${ETHERSCAN}/tx/0xc5ff82de88f34612b4117b3dbd04461e43933e3ef45c288128296e3632887981`}>leash-lemon.eth</A></dd>
            </dl>
          </Panel>
        </>
      )}
    </>
  );
}

export default function Tracks() {
  const [tab, setTab] = useState<Tab>("hedera");
  const [ns, setNs] = useState("");
  const list = usePoll<any>("/api/explorer?summary", 60000);
  useEffect(() => {
    const h = location.hash.slice(1);
    if (TABS.some(([k]) => k === h)) setTab(h as Tab);
  }, []);
  const pick = (t: Tab) => {
    setTab(t);
    history.replaceState(null, "", `#${t}`);
  };
  const spaces = list.data?.namespaces ?? [];
  return (
    <div>
      <div className="section-head">
        <div>
          <span className="kicker">Partner tracks · live proof</span>
          <h1 style={{ marginTop: 12 }}>Partner tracks</h1>
          <p className="lead">Each track's qualification requirements, and the live testnet evidence for each: Hedera payments and audit messages, Arkiv writes and queries, and ENSv2 records and roles.</p>
        </div>
        {spaces.length > 1 && (
          <div className="field">
            <label htmlFor="registry">Registry</label>
            <select id="registry" value={ns || list.data?.namespace || ""} onChange={(e) => setNs(e.target.value)}>
              {spaces.map((n: any) => <option key={n.ns} value={n.ns}>{n.ns} ({n.profile === "live" ? "live clock" : "production"})</option>)}
            </select>
          </div>
        )}
      </div>
      <div className="row start" role="tablist" aria-label="Partner track" style={{ marginBottom: 18 }}>
        {TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" id={`tab-${k}`} aria-selected={tab === k} aria-controls="track-panel" className={tab === k ? "primary" : undefined} onClick={() => pick(k)}>{label}</button>
        ))}
      </div>
      <div id="track-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "hedera" ? <Hedera ns={ns} /> : tab === "arkiv" ? <Arkiv ns={ns} /> : <Ens ns={ns} />}
      </div>
    </div>
  );
}
