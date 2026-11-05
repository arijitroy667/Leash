"use client";
import { useEffect, useState } from "react";
import { Badge, MerchantCard, ProfileBanner, secondsLeft, short, usd } from "./ui";

const REASONS = ["outage", "config-error", "payment-mismatch", "dispute-customer-error", "compromised-key-rotated"];

async function connect(): Promise<`0x${string}`> {
  const eth = (window as any).ethereum;
  if (!eth) throw new Error("No browser wallet found");
  const [address] = await eth.request({ method: "eth_requestAccounts" });
  return address;
}
const sign = (message: string, address: string): Promise<`0x${string}`> =>
  (window as any).ethereum.request({ method: "personal_sign", params: [message, address] });

function ApprovalCard({ a, now, owner, onDone }: { a: any; now: number; owner: string | null; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = async (action: "approve" | "reject") => {
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
      onDone();
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
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
        <dt>24h cap left</dt><dd>{usd(c.remainingCap24h)}</dd>
        <dt>Expires in</dt><dd><strong>{secondsLeft(a.expiresAt, now)}</strong></dd>
      </dl>
      <div className="row" style={{ justifyContent: "flex-start" }}>
        <button className="primary" disabled={busy} onClick={() => act("approve")}>Approve once</button>
        <button disabled={busy} onClick={() => act("reject")}>Reject</button>
      </div>
      {error && <p className="err" role="alert">{error}</p>}
    </div>
  );
}

function RebuttalDesk({ merchants, onDone }: { merchants: any[]; onDone: () => void }) {
  const named = merchants.filter((m) => m.name);
  const [ens, setEns] = useState("");
  const [reason, setReason] = useState(REASONS[1]!);
  const [msg, setMsg] = useState("");
  const name = ens || named[0]?.name || "";
  const file = async () => {
    setMsg("");
    try {
      const signer = await connect();
      const filedAt = Math.floor(Date.now() / 1000);
      const q = await fetch(`/api/rebuttal?${new URLSearchParams({ ens: name, reason, filedAt: String(filedAt) })}`);
      const { message, error } = await q.json();
      if (!q.ok) throw new Error(error);
      const signature = await sign(message, signer);
      const r = await fetch("/api/rebuttal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ens: name, reason, filedAt, signer, signature }) });
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
      <p className="muted">Sign as the wallet holding the merchant&apos;s <code>herd.rebuttal</code> role. One per block episode.</p>
      <div className="row" style={{ justifyContent: "flex-start" }}>
        <label>Merchant <select value={name} onChange={(e) => setEns(e.target.value)}>{named.map((m) => <option key={m.name}>{m.name}</option>)}</select></label>
        <label>Reason <select value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map((r) => <option key={r}>{r}</option>)}</select></label>
        <button onClick={file} disabled={!name}>Sign and file</button>
      </div>
      {msg && <p role="status">{msg}</p>}
    </section>
  );
}

export default function Console() {
  const [s, setS] = useState<any>(null);
  const [error, setError] = useState("");
  const [clock, setClock] = useState(Date.now() / 1000);

  const load = async () => {
    try {
      const r = await fetch("/api/state", { cache: "no-store" });
      if (r.status === 403) return void (location.href = "/explorer");
      setS(await r.json());
      setError("");
    } catch {
      setError("Lost connection to the console server. Pending approvals stay unpaid.");
    }
  };
  useEffect(() => {
    load();
    const poll = setInterval(load, 2000);
    const tick = setInterval(() => setClock(Date.now() / 1000), 500);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, []);

  if (!s) return <main>{error ? <p className="err">{error}</p> : <p className="muted">Loading live state…</p>}</main>;
  const pending = s.approvals.filter((a: any) => a.status === "pending");
  const deps = ["ens", "arkiv", "mirror", "hcs"];

  return (
    <main>
      <div className="top">
        <h1>Herd Immunity <span className="muted" style={{ fontWeight: 400 }}>owner console</span></h1>
        <span className="muted">namespace <code>{s.namespace}</code> · <a href="/explorer">public explorer</a></span>
      </div>
      <ProfileBanner profile={s.profile} />
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
        </section>

        <section className="panel">
          <h2>Health</h2>
          <div className="health">
            {deps.map((d) => {
              const h = s.health.find((x: any) => x.dep === d);
              return <span key={d} title={h?.detail || ""}><span className={`dot ${h && !h.ok ? "down" : ""}`} />{d}{!h && <span className="muted"> (unused)</span>}{h && !h.ok && <strong className="err"> down</strong>}</span>;
            })}
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>
            Outbox {s.outbox.depth} queued{s.topic && <> · <a href={`https://hashscan.io/testnet/topic/${s.topic}`}>HCS audit topic {s.topic}</a></>}
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
                      <td className="muted">{d.reasons.join(", ") || "none"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
