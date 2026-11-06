"use client";
import Link from "next/link";
import { useState } from "react";
import { Chip, hashscanTx } from "../components/bits";
import { Icon } from "../components/icons";
import { LiveFeed } from "../components/live";
import { LazyTile, useClock, type Entry } from "../components/merchant-tile";
import { ProfileBanner } from "../ui";

interface Scene { id: string; n: string; title: string; shows: string; expect: string }
const SCENES: Scene[] = [
  { id: "weather", n: "1", title: "Agent A buys a forecast from weather", shows: "A known merchant and a micro payment: paid with no human, then a signed good report once Mirror Node confirms settlement.", expect: "ALLOW" },
  { id: "lemon-a", n: "2", title: "Agent A buys from lemon", shows: "Lemon takes the payment and returns junk that misses its declared schema. The guard files a bad report at once.", expect: "ALLOW, then a bad report" },
  { id: "lemon-b", n: "2", title: "Agent B buys from lemon", shows: "One bad cluster lifts the risk score, so B must ask the owner. Approve it in the console, then run the same challenge again: a second cluster blocks lemon.", expect: "ESCALATE" },
  { id: "lemon-c", n: "2", title: "Agent C tries lemon", shows: "Two independent clusters proved lemon bad. C is protected without ever paying.", expect: "DENY blocked" },
  { id: "spoof", n: "3", title: "Agent A pays the spoof merchant", shows: "A 402 that claims the weather name but pays a different account contradicts the ENSv2 declaration.", expect: "DENY declared-mismatch" },
  { id: "rogue", n: "4", title: "Agent C pays rogue, which has no ENS name", shows: "An unknown merchant always escalates. One owner signature pays once; the same challenge again is a replay.", expect: "ESCALATE, then DENY replay" },
];

const token = () => Math.random().toString(36).slice(2, 10);

function SceneCard({ s, canRun }: { s: Scene; canRun: boolean }) {
  const [run, setRun] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);
  const go = async (same: boolean) => {
    const t = same && run ? run : token();
    setRun(t);
    setBusy(true);
    try {
      const r = await fetch("/api/demo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scene: s.id, run: t }) });
      setRes(await r.json());
    } catch {
      setRes({ error: "The console server did not answer. Nothing was paid from this page." });
    }
    setBusy(false);
  };
  return (
    <article className="glass scene" aria-labelledby={`scene-${s.id}`}>
      <div className="scene-head">
        <div className="row start" style={{ gap: 12, alignItems: "flex-start", flexWrap: "nowrap" }}>
          <span className="scene-n" aria-hidden="true">{s.n}</span>
          <div>
            <h3 id={`scene-${s.id}`} style={{ margin: 0 }}>{s.title}</h3>
            <p className="muted" style={{ margin: "6px 0 0" }}>{s.shows}</p>
          </div>
        </div>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <span className="muted" style={{ fontSize: "0.88rem" }}>Expected: <strong>{s.expect}</strong></span>
        <div className="row start" style={{ gap: 8 }}>
          <button type="button" className="primary" disabled={!canRun || busy} onClick={() => go(false)} aria-describedby={canRun ? undefined : "operator-note"}>
            <Icon name="bolt" /> {busy ? "Paying…" : run ? "New purchase" : "Run it live"}
          </button>
          {run && <button type="button" disabled={!canRun || busy} onClick={() => go(true)}>Same challenge again</button>}
        </div>
      </div>
      {res && (
        <div className="result" role="status" aria-live="polite">
          {res.error ? <p className="err" style={{ margin: 0 }}>{res.error}</p> : (
            <>
              <div className="row start" style={{ gap: 8 }}>
                <Chip v={res.outcome} />
                {res.verdict && <span className="muted">decided</span>} {res.verdict && <Chip v={res.verdict} />}
                {res.standing && <Chip v={res.standing} />}
                {typeof res.score === "number" && <span className="num">R {res.score.toFixed(1)}</span>}
                {typeof res.latencyMs === "number" && <span className="muted num">{res.latencyMs} ms</span>}
              </div>
              {res.reasons?.length > 0 && <p className="muted" style={{ margin: "8px 0 0" }}>Reasons: {res.reasons.join(", ")}</p>}
              {res.outcome === "paid" && <p style={{ margin: "8px 0 0" }}>{res.delivered ? "Delivered what it declared." : "Paid, but the merchant delivered junk: a bad report is on its way to Arkiv."} {res.txId && <a href={hashscanTx(res.txId)} target="_blank" rel="noreferrer">Payment on HashScan</a>}</p>}
              {res.outcome === "escalated" && <p style={{ margin: "8px 0 0" }}><Link href="/console">Approve it in the owner console</Link>, then press <strong>Same challenge again</strong>.</p>}
            </>
          )}
        </div>
      )}
    </article>
  );
}

export function DemoClient({ canRun, profile, note, merchants }: { canRun: boolean; profile: string; note: string; merchants: Entry[] }) {
  const now = useClock();
  return (
    <div>
      <div className="section-head">
        <div>
          <span className="kicker"><span className="live-dot" aria-hidden="true" /> Live on public testnets</span>
          <h1 style={{ marginTop: 12 }}>Live demo</h1>
          <p className="lead">Real agents paying real merchants with test USDC on Hedera. Every payment, report and name below is on a public network, with a link you can check. Nothing is mocked or replayed.</p>
        </div>
      </div>
      <ProfileBanner profile={profile} note={note} />
      {!canRun && (
        <div id="operator-note" className="banner" role="note">
          <Icon name="shield" />
          <span>The agents&apos; keys stay on the operator&apos;s machine, so the scenes run there. Watch them land here as they happen: the audit trail and the merchants&apos; health update live.</span>
        </div>
      )}
      <div className="demo">
        <section aria-labelledby="scenes-h" className="stack">
          <h2 id="scenes-h" className="sr-only">Scenes</h2>
          {SCENES.map((s) => <SceneCard key={s.id} s={s} canRun={canRun} />)}
        </section>
        <aside className="glass panel demo-feed" aria-label="Live audit trail">
          <LiveFeed limit={10} />
        </aside>
      </div>
      <section className="section" aria-labelledby="demo-merchants">
        <div className="section-head">
          <h2 id="demo-merchants">The merchants, live</h2>
          <Link className="btn" href="/explorer">Every merchant <Icon name="arrow" /></Link>
        </div>
        <div className="tiles">{merchants.map((m) => <LazyTile key={m.key} entry={m} now={now} />)}</div>
      </section>
    </div>
  );
}
