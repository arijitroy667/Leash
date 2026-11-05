"use client";
import type { ReactNode } from "react";

export const short = (s: string, n = 10) => (s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-6)}` : s);
export const hashscanTx = (id: string) => {
  const [acct, time = ""] = id.split("@");
  const [sec, nano = "0"] = time.split(".");
  return `https://hashscan.io/testnet/transaction/${acct}-${sec}-${nano.padEnd(9, "0")}`;
};
export const usd = (n: number) => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;

export function Badge({ v }: { v: string }) {
  return <span className={`badge ${v}`}>{v}</span>;
}

export function secondsLeft(end: number, now: number) {
  const s = Math.max(0, Math.round(end - now));
  return s >= 3600 ? `${(s / 3600).toFixed(1)}h` : s >= 120 ? `${Math.round(s / 60)}m ${s % 60}s` : `${s}s`;
}

export function ProfileBanner({ profile }: { profile: string }) {
  if (profile !== "live") return null;
  return (
    <div className="banner" role="status">
      Live policy profile: 1 policy day = 18 real seconds. Every payment, entity and name on this page is real on public testnets.
    </div>
  );
}

function Stat({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

export function MerchantCard({ m, now }: { m: any; now: number }) {
  const v = m.view;
  return (
    <div className="card">
      <div className="row">
        <strong>{m.name ?? m.payTo ?? m.key}</strong>
        <Badge v={m.standing} />
      </div>
      <dl className="kv">
        {m.payTo && <Stat k="payTo" v={<a className="mono" href={`https://hashscan.io/testnet/account/${m.payTo}`}>{m.payTo}</a>} />}
        {m.declaration && <Stat k="Declared max" v={usd(m.declaration.maxPriceUsd)} />}
        {m.declaration && <Stat k="Domains" v={m.declaration.domains.join(", ") || "none"} />}
        {!m.declaration && <Stat k="ENS" v="No declaration" />}
        {v?.blockEnd && <Stat k="Block ends in" v={<strong>{secondsLeft(v.blockEnd, now)}</strong>} />}
        {v?.holdUntil && <Stat k="Hold ends in" v={<strong>{secondsLeft(v.holdUntil, now)}</strong>} />}
        {v?.standing === "PROBATION" && v.probationStart && <Stat k="In probation for" v={secondsLeft(now, v.probationStart)} />}
        {v && <Stat k="Strikes" v={v.strikes} />}
        {v && <Stat k="Evidence" v={`b ${v.b.toFixed(2)} · L ${usd(v.L)} · g ${v.g.toFixed(2)} · D ${usd(v.D)}`} />}
        {v && <Stat k="Clusters" v={`${v.badClusters} bad · ${v.goodClusters} good`} />}
      </dl>
      {m.error && <p className="err">Could not read the registry: {m.error}</p>}
      {m.reports.length > 0 && (
        <div className="scroll">
          <table>
            <thead><tr><th>Report</th><th>Amount</th><th>Why</th><th>Proof</th></tr></thead>
            <tbody>
              {m.reports.slice(0, 6).map((r: any) => (
                <tr key={r.txId + r.owner}>
                  <td><Badge v={r.valid ? r.outcome : "ignored"} /></td>
                  <td>{usd(r.amountUsd)}</td>
                  <td className="muted">{r.valid ? r.reason : r.why}</td>
                  <td><a className="mono" href={hashscanTx(r.txId)}>{short(r.txId, 8)}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {m.probes.length > 0 && (
        <p className="muted">Probes: {m.probes.slice(0, 4).map((p: any) => <a key={p.txId} className="mono" href={hashscanTx(p.txId)} style={{ marginRight: 8 }}>{p.result}</a>)}</p>
      )}
      {m.rebuttals.length > 0 && <p className="muted">Rebuttal: {m.rebuttals[0].reason}, signed by <span className="mono">{short(m.rebuttals[0].signer, 6)}</span></p>}
    </div>
  );
}
