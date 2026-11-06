"use client";
import type { ReactNode } from "react";
import { arkivEntity, Chip, hashscanTx, HASHSCAN, short, usd } from "./components/bits";
import { HealthMeter } from "./components/health-meter";
import { Icon } from "./components/icons";

export { short, usd, hashscanTx };
export const Badge = ({ v }: { v: string }) => <Chip v={v} />;

export function secondsLeft(end: number, now: number) {
  const s = Math.max(0, Math.round(end - now));
  return s >= 3600 ? `${(s / 3600).toFixed(1)}h` : s >= 120 ? `${Math.round(s / 60)}m ${s % 60}s` : `${s}s`;
}

export function ProfileBanner({ profile, note }: { profile: string; note?: string }) {
  if (profile !== "live") return null;
  return (
    <div className="banner" role="status">
      <Icon name="bolt" />
      <span><strong>Live policy profile.</strong> {note} Every payment, entity and name on this page is real, on public testnets.</span>
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

/** Everything the registry proves about one merchant. Reports, probes and rebuttals are verified rows only. */
export function MerchantDetail({ m, now }: { m: any; now: number }) {
  const v = m.view;
  return (
    <>
      <dl className="kv">
        {m.payTo && <Stat k="payTo" v={<a className="mono" href={`${HASHSCAN}/account/${m.payTo}`} target="_blank" rel="noreferrer">{m.payTo}</a>} />}
        {m.declaration && <Stat k="Declared max" v={usd(m.declaration.maxPriceUsd)} />}
        {m.declaration && <Stat k="Domains" v={m.declaration.domains.join(", ") || "none"} />}
        {!m.declaration && <Stat k="ENS" v="No declaration, so every payment asks the owner" />}
        {v?.blockEnd && <Stat k="Block ends in" v={<strong>{secondsLeft(v.blockEnd, now)}</strong>} />}
        {v?.holdUntil && <Stat k="Hold ends in" v={<strong>{secondsLeft(v.holdUntil, now)}</strong>} />}
        {v?.standing === "PROBATION" && v.probationStart && <Stat k="In probation for" v={secondsLeft(now, v.probationStart)} />}
        {v?.standing === "PROBATION" && <Stat k="Recovery" v={`${v.goodClusters} of 3 good clusters · ${usd(v.D)} of $0.15 delivered`} />}
        {v && <Stat k="Strikes" v={v.strikes} />}
        {v && <Stat k="Evidence" v={`b ${v.b.toFixed(2)} · L ${usd(v.L)} · g ${v.g.toFixed(2)} · D ${usd(v.D)}`} />}
        {v && <Stat k="Clusters" v={`${v.badClusters} bad · ${v.goodClusters} good`} />}
      </dl>
      {m.error && <p className="err">Could not read the registry: {m.error}</p>}
      {m.reports.length > 0 && (
        <details className="more">
          <summary>{m.reports.filter((r: any) => r.valid).length} verified reports{m.reports.some((r: any) => !r.valid) ? `, ${m.reports.filter((r: any) => !r.valid).length} ignored` : ""}</summary>
          <div className="scroll">
            <table>
              <caption className="sr-only">Reports for {m.name ?? m.payTo}</caption>
              <thead><tr><th scope="col">Report</th><th scope="col">Amount</th><th scope="col">Why</th><th scope="col">Arkiv entity</th></tr></thead>
              <tbody>
                {m.reports.slice(0, 8).map((r: any, i: number) => (
                  <tr key={`${r.txId}${r.owner}${i}`}>
                    <td><Chip v={r.valid ? r.outcome : "expired"}>{r.valid ? r.outcome : "ignored"}</Chip></td>
                    <td className="num">{usd(r.amountUsd)}</td>
                    <td className="muted">{r.valid ? r.reason : r.why}</td>
                    <td>{r.key ? <a className="mono" href={arkivEntity(r.key)} target="_blank" rel="noreferrer" title="The report on Arkiv: its attributes and the transaction that wrote it">{short(r.key, 6)}</a> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {m.probes.length > 0 && (
        <p className="muted" style={{ marginTop: 10 }}>Probes: {m.probes.slice(0, 4).map((p: any) => <a key={p.txId} className="mono" href={p.key ? arkivEntity(p.key) : hashscanTx(p.txId)} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>{p.result}</a>)}</p>
      )}
      {m.rebuttals.length > 0 && <p className="muted">Rebuttal: {m.rebuttals[0].reason}, signed by <span className="mono">{short(m.rebuttals[0].signer, 6)}</span></p>}
    </>
  );
}

export function MerchantCard({ m, now }: { m: any; now: number }) {
  return (
    <article className="card tile">
      <div className="tile-head">
        <div style={{ minWidth: 0 }}>
          <div className="tile-name">{m.name ?? m.payTo ?? m.key}</div>
          <Chip v={m.standing} />
        </div>
        <HealthMeter health={m.health} standing={m.standing} />
      </div>
      <MerchantDetail m={m} now={now} />
    </article>
  );
}
