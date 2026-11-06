"use client";
import { useEffect, useState } from "react";
import { Badge, MerchantCard, ProfileBanner, secondsLeft, short, usd } from "../ui";

const REASONS = ["outage", "config-error", "payment-mismatch", "dispute-customer-error", "compromised-key-rotated"];

async function connect(): Promise<`0x${string}`> {
  const eth = (window as any).ethereum;
  if (!eth) throw new Error("No browser wallet found");
  const [address] = await eth.request({ method: "eth_requestAccounts" });
  return address;
}
// Hex is the form every wallet accepts for personal_sign, and each still shows it as readable text.
const toHex = (text: string) => `0x${[...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
const sign = (message: string, address: string): Promise<`0x${string}`> =>
  (window as any).ethereum.request({ method: "personal_sign", params: [toHex(message), address] });

function ApprovalCard({ a, now, owner, onDone }: { a: any; now: number; owner: string | null; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = async (action: "approve" | "reject" | "reject-block") => {
    setBusy(true);
    setError("");
    try {
      let signature: string | undefined;
      if (action === "approve") {
        const address = await connect();
        if (owner && address.toLowerCase() !== owner.toLowerCase()) throw new Error(`Connect the owner wallet ${short(owner, 6)}`);
        signature = await sign(a.message, address);
      }
      const r = await fetch(`/api/approvals/${a.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, signature }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      onDone(); // the buttons stay disabled until the next read removes this card, so it cannot be clicked twice
    } catch (e: any) {
      setError(e.message ?? String(e));
      setBusy(false);
    }
  };
  const c = a.card;
  return (
    <div className="card">
      <div className="row">
        <strong>{c.merchant}</strong>
        <span><Badge v={c.standing} /> <strong style={{ marginLeft: 6 }}>{usd(c.amountUsd)}</strong></span>
      </div>
      <dl className="kv">
        <dt>Agent</dt><dd>{a.agent}</dd>
        <dt>Score</dt><dd>{c.score}</dd>
        <dt>Reasons</dt><dd>{(c.reasons as string[]).join(", ")}</dd>
        <dt>Declared max</dt><dd>{c.declaredMaxUsd === null ? "No declaration" : `${usd(c.declaredMaxUsd)} (asks ${usd(c.amountUsd)})`}</dd>
        <dt>24h cap left</dt><dd>{c.standing === "UNKNOWN" ? "No cap: always asks you" : usd(c.remainingCap24h)}</dd>
        <dt>Expires in</dt><dd><strong>{secondsLeft(a.expiresAt, now)}</strong></dd>
      </dl>
      <div className="row" style={{ justifyContent: "flex-start" }}>
        <button className="primary" disabled={busy} onClick={() => act("approve")}>Approve once</button>
        <button disabled={busy} onClick={() => act("reject")}>Reject</button>
        <button disabled={busy} onClick={() => act("reject-block")}>Reject and block locally</button>
      </div>
      {error && <p className="err" role="alert">{error}</p>}
    </div>
  );
}

function RebuttalDesk({ merchants, onDone }: { merchants: any[]; onDone: () => void }) {
  const named = merchants.filter((m) => m.name);
  const [ens, setEns] = useState("");
  const [reason, setReason] = useState(REASONS[1]!);
  const [evidence, setEvidence] = useState("");
  const [msg, setMsg] = useState("");
  const name = ens || named[0]?.name || "";
  const m = named.find((x) => x.name === name);
  const file = async () => {
    setMsg("");
    try {
      const signer = await connect();
      const filedAt = Math.floor(Date.now() / 1000);
      const q = await fetch(`/api/rebuttal?${new URLSearchParams({ ens: name, reason, filedAt: String(filedAt), evidence })}`);
      const { message, error } = await q.json();
      if (!q.ok) throw new Error(error);
      const signature = await sign(message, signer);
      const r = await fetch("/api/rebuttal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ens: name, reason, filedAt, signer, signature, evidence }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setMsg("Filed. A probe will run next; the rebuttal alone never unblocks.");
      onDone();
    } catch (e: any) {
      setMsg(`Rejected: ${e.message ?? e}`);
    }
  };
  return (
    <section className="panel">
      <h2>Rebuttal desk</h2>
      <p className="muted">Sign as the wallet holding the merchant&apos;s <code>leash.rebuttal</code> role. One per block episode.</p>
      <div className="row" style={{ justifyContent: "flex-start" }}>
        <label>Merchant <select value={name} onChange={(e) => setEns(e.target.value)}>{named.map((m) => <option key={m.name}>{m.name}</option>)}</select></label>
        <label>Reason <select value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map((r) => <option key={r}>{r}</option>)}</select></label>
        <label>Evidence URL or hash <input value={evidence} maxLength={500} onChange={(e) => setEvidence(e.target.value)} placeholder="optional, only its hash is stored" /></label>
        <button onClick={file} disabled={!name}>Sign and file</button>
      </div>
      {msg && <p role="status">{msg}</p>}
      {m && (
        <p className="muted" style={{ marginBottom: 0 }}>
          <Badge v={m.standing} /> {m.view?.rebuttalUsed ? "Rebuttal used this episode" : "Rebuttal available"}
          {" · "}Last probe: {m.probes[0] ? <Badge v={m.probes[0].result} /> : "none"}
          {m.view?.standing === "PROBATION" && <> · Recovery: {m.view.goodClusters} of 3 good clusters, {usd(m.view.D)} of $0.15 delivered</>}
        </p>
      )}
    </section>
  );
}

export default function Console() {
  const [s, setS] = useState<any>(null);
  const [error, setError] = useState("");
  const [clock, setClock] = useState(Date.now() / 1000);
  const [locked, setLocked] = useState(false);

  /** Returns false once the server says this is the public site, so polling stops. */
  const load = async () => {
    try {
      const r = await fetch("/api/state", { cache: "no-store" });
      if (r.status === 403) {
        setLocked(true);
        return false;
      }
      setS(await r.json());
      setError("");
    } catch {
      setError("Lost connection to the console server. Pending approvals stay unpaid.");
    }
    return true;
  };
  useEffect(() => {
    let poll: ReturnType<typeof setInterval> | undefined;
    load().then((ok) => {
      if (ok) poll = setInterval(load, 2000);
    });
    const tick = setInterval(() => setClock(Date.now() / 1000), 500);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, []);

  if (locked) {
    return (
      <div className="panel" style={{ maxWidth: 680 }}>
        <h1 style={{ fontSize: "2rem" }}>The owner console runs on the operator&apos;s machine</h1>
        <p className="lead">Approvals are signed there with the owner&apos;s wallet, next to the agents&apos; keys, which never reach a public server. This public site is read-only.</p>
        <div className="cta"><a className="btn primary" href="/explorer">Open the explorer</a><a className="btn" href="/demo">Watch the live demo</a></div>
      </div>
    );
  }
  if (!s) return <div className="panel" aria-busy="true">{error ? <p className="err" role="alert">{error}</p> : <p className="muted">Loading live state…</p>}</div>;
  const pending = s.approvals.filter((a: any) => a.status === "pending");
  const deps = ["ens", "arkiv", "mirror", "facilitator", "hcs"];

  return (
    <div>
      <div className="section-head">
        <div>
          <span className="kicker">Operator only</span>
          <h1 style={{ marginTop: 12 }}>Owner console</h1>
        </div>
        <span className="muted">namespace <code>{s.namespace}</code> · <a href="/explorer">public explorer</a></span>
      </div>
      <ProfileBanner profile={s.profile} note={s.policyNote} />
      {s.safeMode && <div className="banner alert" role="alert">Safe mode: two critical dependencies are down, so every payment escalates. Cached blocks still deny.</div>}
      {error && <div className="banner alert" role="alert">{error}</div>}

      <div className="grid">
        <section className="panel">
          <h2>Approvals {pending.length > 0 && `(${pending.length})`}</h2>
          {pending.length === 0 && <p className="muted">Nothing waiting. Normal payments need no attention.</p>}
          {pending.map((a: any) => <ApprovalCard key={a.id} a={a} now={clock} owner={s.owner} onDone={load} />)}
          {s.approvals.filter((a: any) => a.status !== "pending").slice(0, 4).map((a: any) => (
            <p key={a.id} className="muted" style={{ margin: "4px 0" }}><Badge v={a.status} /> {a.card.merchant} {usd(a.card.amountUsd)}</p>
          ))}
          {s.escalations.length > 0 && (
            <p className="muted" style={{ marginBottom: 0 }}>
              New escalations this hour: {s.escalations.map((e: any) => `${e.agent} ${e.count} of ${s.escalationLimit}`).join(" · ")}
            </p>
          )}
        </section>

        <section className="panel">
          <h2>Health</h2>
          <div className="health">
            {deps.map((d) => {
              const h = s.health.find((x: any) => x.dep === d);
              return <span key={d} title={h?.detail || ""}><span className={`dot ${h && !h.ok ? "down" : ""}`} />{d}{!h && <span className="muted"> (unused)</span>}{h && !h.ok && <strong className="err"> down</strong>}{h?.recovering && <span className="muted"> recovering</span>}</span>;
            })}
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>
            Outbox {s.outbox.depth} queued{s.topic && <> · <a href={`https://hashscan.io/testnet/topic/${s.topic}`}>HCS audit topic {s.topic}</a></>}
          </p>
          <p className="muted" style={{ marginBottom: 0 }}>
            Decision latency {s.latency.n ? `p50 ${s.latency.p50} ms, p95 ${s.latency.p95} ms over the last ${s.latency.n}` : "not measured yet"}
            {" · "}Probe spend today {usd(s.probeSpend.today)} of {usd(s.probeSpend.budget)}
          </p>
        </section>

        <RebuttalDesk merchants={s.merchants} onDone={load} />

        <section className="panel full">
          <h2>Merchants</h2>
          <div className="grid">{s.merchants.map((m: any) => <MerchantCard key={m.key} m={m} now={clock} />)}</div>
          {s.merchants.length === 0 && <p className="muted">No merchants configured yet. Run pnpm ens:setup.</p>}
        </section>

        <section className="panel full">
          <h2>Decision log</h2>
          {s.topic && <p className="muted" style={{ marginTop: 0 }}>Each decision is also published to <a href={`https://hashscan.io/testnet/topic/${s.topic}`}>HCS audit topic {s.topic}</a>.</p>}
          {s.decisions.length === 0 && <p className="muted">No decisions yet.</p>}
          {s.decisions.length > 0 && (
            <div className="scroll">
              <table>
                <thead><tr><th>Time</th><th>Agent</th><th>Verdict</th><th>Merchant</th><th>Standing</th><th>Amount</th><th>R</th><th>Reasons</th></tr></thead>
                <tbody>
                  {s.decisions.map((d: any) => (
                    <tr key={d.id}>
                      <td className="mono">{new Date(d.at * 1000).toLocaleTimeString()}</td>
                      <td>{d.agent}</td>
                      <td><Badge v={d.verdict} /></td>
                      <td>{d.merchantKey}</td>
                      <td>{d.standing}</td>
                      <td>{usd(d.amountUsd)}</td>
                      <td>{d.score.toFixed(1)}</td>
                      <td className="muted">
                        <details>
                          <summary>{d.reasons.join(", ") || "none"}</summary>
                          bad {d.factors.bad.toFixed(2)} · loss {d.factors.loss.toFixed(2)} · trust {d.factors.trust.toFixed(2)} · exposure {d.factors.exposure.toFixed(2)} · identity {d.factors.identity.toFixed(2)}
                          <br />auto limit {usd(d.limits.autoApprove)} · cap {usd(d.limits.cap24h)} · used {usd(d.limits.capUsed24h)}
                          {d.degraded && <><br />degraded: {d.degraded.dependency}, {Math.round(d.degraded.staleSec)} s stale</>}
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
