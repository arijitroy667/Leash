"use client";
import { useEffect, useRef, useState } from "react";
import { ago, Chip, hashscanTx, HASHSCAN, short, Skeleton, usd } from "./bits";
import { Icon, type IconName } from "./icons";

/** True once the element has been on screen. Live widgets start polling only then, and stop while hidden. */
export function useInView<T extends Element>(margin = "200px") {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return void (setSeen(true), setVisible(true));
    const io = new IntersectionObserver(([e]) => {
      setVisible(!!e?.isIntersecting);
      if (e?.isIntersecting) setSeen(true);
    }, { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [margin]);
  return { ref, seen, visible };
}

/** Polls `url` every `ms` while `active` and the tab is visible. Keeps the last good answer through a failed poll. */
export function usePoll<T>(url: string | null, ms: number, active = true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!url || !active) return;
    let stop = false;
    const load = async () => {
      if (document.hidden) return;
      try {
        const r = await fetch(url, { cache: "no-store" });
        const j = await r.json();
        if (stop) return;
        if (j.error && !r.ok) setError(j.error);
        else setError("");
        setData(j);
      } catch {
        if (!stop) setError("Could not reach the live data. Retrying.");
      }
    };
    load();
    const t = setInterval(load, ms);
    return () => { stop = true; clearInterval(t); };
  }, [url, ms, active]);
  return { data, error };
}

export interface FeedItem {
  seq: number; at: number; payer: string; type: "decision" | "report" | "approval" | "probe" | "rebuttal";
  agent: string | null; merchant: string | null; verdict: string | null; reasons: string[]; standing: string | null;
  score: number | null; amountUsd: number | null; outcome: string | null; result: string | null; state: string | null; reason: string | null; txId: string | null;
}

const TYPE_ICON: Record<FeedItem["type"], IconName> = { decision: "bolt", report: "doc", approval: "shield", probe: "eye", rebuttal: "alert" };

function FeedLine({ i, now }: { i: FeedItem; now: number }) {
  let what;
  if (i.type === "decision") what = <><Chip v={i.verdict ?? "UNKNOWN"} /> <strong>{i.merchant ?? "merchant"}</strong> {i.amountUsd !== null && usd(i.amountUsd)}{i.reasons.length > 0 && <span className="muted"> · {i.reasons.join(", ")}</span>}{i.score !== null && <span className="muted"> · R {i.score}</span>}</>;
  else if (i.type === "report") what = <><Chip v={i.outcome ?? "UNKNOWN"}>{i.outcome} report</Chip> <strong>{i.merchant}</strong>{i.reason && <span className="muted"> · {i.reason}</span>}{i.txId && <> · <a href={hashscanTx(i.txId)} target="_blank" rel="noreferrer">payment</a></>}</>;
  else if (i.type === "approval") what = <><Chip v={i.state ?? "pending"}>approval {i.state}</Chip> <strong>{i.merchant}</strong> {i.amountUsd !== null && usd(i.amountUsd)}</>;
  else if (i.type === "probe") what = <><Chip v={i.result ?? "UNKNOWN"}>probe {i.result}</Chip> <strong>{i.merchant}</strong>{i.txId && <> · <a href={hashscanTx(i.txId)} target="_blank" rel="noreferrer">payment</a></>}</>;
  else what = <><Chip v="PROBATION">rebuttal</Chip> <strong>{i.merchant}</strong>{i.reason && <span className="muted"> · {i.reason}</span>}</>;
  return (
    <li>
      <span className="feed-type" title={i.type}><Icon name={TYPE_ICON[i.type]} size={16} label={i.type} /></span>
      <span className="what">{what}<br /><span className="muted" style={{ fontSize: "0.8rem" }}>{i.agent ?? short(i.payer, 8)} · message {i.seq}</span></span>
      <time className="when" dateTime={new Date(i.at * 1000).toISOString()}>{ago(i.at, now)}</time>
    </li>
  );
}

/** The guards' audit trail as it lands on Hedera Consensus Service, read through Mirror Node. */
export function LiveFeed({ limit = 12, compact = false }: { limit?: number; compact?: boolean }) {
  const { ref, seen, visible } = useInView<HTMLDivElement>();
  const { data, error } = usePoll<{ topic: string | null; total: number | null; items: FeedItem[] }>(seen ? "/api/feed" : null, 4000, visible);
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);
  const items = data?.items.slice(0, limit) ?? [];
  return (
    <div ref={ref}>
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="row start" style={{ gap: 8 }}><span className="live-dot" aria-hidden="true" /> <strong>Live audit trail</strong></span>
        {data?.topic && <a className="muted" href={`${HASHSCAN}/topic/${data.topic}`} target="_blank" rel="noreferrer">HCS topic {data.topic}{data.total ? ` · ${data.total} messages` : ""}</a>}
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      {!data && !error && <Skeleton lines={compact ? 3 : 5} height={44} />}
      {data && !data.topic && <p className="muted">No audit topic is configured for this deployment.</p>}
      {data?.topic && items.length === 0 && !error && <p className="muted">No messages from this deployment&apos;s guards yet.</p>}
      <ul className="feed" aria-live="polite" aria-relevant="additions" aria-label="Latest audit messages">
        {items.map((i) => <FeedLine key={i.seq} i={i} now={now} />)}
      </ul>
    </div>
  );
}

/** Live entity counts for each registry. They fall as entities expire: expiry is how Leash forgives. */
export function LiveStats() {
  const { ref, seen, visible } = useInView<HTMLDivElement>();
  const first = usePoll<any>(seen ? "/api/explorer?summary=1" : null, 15000, visible);
  const regs: { ns: string; profile: string }[] = first.data?.namespaces ?? [];
  return (
    <div ref={ref} className="grid-3">
      {!first.data && !first.error && [0, 1, 2].map((k) => <div key={k} className="glass stat"><Skeleton lines={2} height={22} /></div>)}
      {first.error && <p className="err" role="alert">{first.error}</p>}
      {regs.map((r) => <RegistryStat key={r.ns} ns={r.ns} profile={r.profile} active={visible} initial={r.ns === first.data?.namespace ? first.data : null} />)}
    </div>
  );
}

function RegistryStat({ ns, profile, active, initial }: { ns: string; profile: string; active: boolean; initial: any }) {
  const { data } = usePoll<any>(`/api/explorer?summary=1&ns=${encodeURIComponent(ns)}`, 15000, active);
  const d = data ?? initial;
  const tone = profile === "live" ? "tone-lime" : "tone-violet";
  return (
    <div className={`glass stat ${tone}`}>
      <div className="label">{ns} · {profile === "live" ? "live clock" : "production clock"}</div>
      {!d ? <Skeleton lines={2} height={22} /> : (
        <>
          <div className="stat-value num">{d.counts ? d.counts.reports + d.counts.probes + d.counts.rebuttals : "–"}</div>
          <div className="stat-label">entities on Arkiv now</div>
          <p className="muted" style={{ margin: "8px 0 0", fontSize: "0.88rem" }}>
            {d.counts ? `${d.counts.reports} reports, ${d.counts.probes} probes, ${d.counts.rebuttals} rebuttals` : ""} · {d.merchants ?? 0} merchants
          </p>
        </>
      )}
    </div>
  );
}
