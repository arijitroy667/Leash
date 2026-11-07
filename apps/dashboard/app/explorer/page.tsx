"use client";
import { useEffect, useState } from "react";
import { Skeleton } from "../components/bits";
import { Icon } from "../components/icons";
import { HealthLegend } from "../components/health-meter";
import { usePoll } from "../components/live";
import { LazyTile, useClock, type Entry } from "../components/merchant-tile";
import { MerchantCard, ProfileBanner } from "../ui";

export default function Explorer() {
  const now = useClock();
  const [ns, setNs] = useState("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState("");
  // ?q= and ?ns= open a lookup directly, as the create page links to its new merchant.
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (p.get("ns")) setNs(p.get("ns")!);
    if (p.get("q")) {
      setQuery(p.get("q")!);
      setActive(p.get("q")!);
    }
  }, []);
  const list = usePoll<any>(`/api/explorer${ns ? `?ns=${encodeURIComponent(ns)}` : ""}`, 20000);
  const found = usePoll<any>(active ? `/api/explorer?key=${encodeURIComponent(active)}${ns ? `&ns=${encodeURIComponent(ns)}` : ""}` : null, 8000);
  const d = list.data;
  const registry = ns || d?.namespace || "";
  const entries: Entry[] = d?.list ?? [];

  return (
    <div>
      <div className="section-head">
        <div>
          <span className="kicker">Public · read-only · live</span>
          <h1 style={{ marginTop: 12 }}>Merchant explorer</h1>
          <p className="lead">Every merchant in the registry, read live from ENSv2 on Sepolia, Arkiv and Hedera Mirror Node. Each report is re-verified against its real payment before it counts; a row with no proof shows as ignored.</p>
        </div>
        <div className="row start" style={{ alignItems: "end" }}>
          {d?.namespaces?.length > 1 && (
            <div className="field">
              <label htmlFor="registry">Registry</label>
              <select id="registry" value={registry} onChange={(e) => { setNs(e.target.value); setActive(""); }}>
                {d.namespaces.map((n: any) => <option key={n.ns} value={n.ns}>{n.ns} ({n.profile === "live" ? "live clock" : "production"})</option>)}
              </select>
            </div>
          )}
          <a className="btn primary" href={`/explorer/new${registry ? `?ns=${encodeURIComponent(registry)}` : ""}`}><Icon name="plus" /> Create merchant</a>
        </div>
      </div>

      {d && <ProfileBanner profile={d.profile} note={d.policyNote} />}

      <form className="glass panel search" role="search" onSubmit={(e) => { e.preventDefault(); setActive(query.trim()); }}>
        <div className="field" style={{ flex: "1 1 280px" }}>
          <label htmlFor="q">Look up an ENS name, domain or Hedera account</label>
          <input id="q" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="leash-lemon.eth" autoComplete="off" spellCheck={false} />
        </div>
        <button type="submit" className="primary">Look up</button>
        {active && <button type="button" onClick={() => { setQuery(""); setActive(""); }}>Show all</button>}
      </form>

      <div className="glass panel" style={{ marginTop: 18 }}>
        <p className="label">How to read the health bar</p>
        <HealthLegend />
        <p className="muted" style={{ margin: "10px 0 0", fontSize: "0.88rem" }}>Health is 100 minus the risk score Leash would give a ${d?.healthRefUsd ?? 0.005} payment now, from verified evidence only. Five levels follow the decision bands.</p>
      </div>

      <div className="section" style={{ marginTop: 26 }} aria-live="polite">
        {active ? (
          <>
            <h2 style={{ fontSize: "1.3rem" }}>Result for <code>{active}</code></h2>
            {found.error && <p className="err" role="alert">{found.error}</p>}
            {!found.data && !found.error && <Skeleton lines={4} />}
            <div className="tiles">{found.data?.merchants?.map((m: any) => <MerchantCard key={m.key} m={m} now={now} />)}</div>
            {found.data?.merchants?.length === 0 && <p className="muted">Nothing found for that. Try an ENS name such as leash-weather.eth, a merchant domain, or an account id.</p>}
          </>
        ) : (
          <>
            <div className="row" style={{ marginBottom: 14 }}>
              <h2 style={{ fontSize: "1.3rem", margin: 0 }}>{entries.length ? `${entries.length} merchants in ${registry}` : "Merchants"}</h2>
              <span className="muted" style={{ fontSize: "0.88rem" }}>Cards load as you scroll and refresh while on screen</span>
            </div>
            {list.error && <p className="err" role="alert">{list.error}</p>}
            {!d && !list.error && <div className="tiles">{[0, 1, 2].map((k) => <div key={k} className="card tile"><Skeleton lines={5} /></div>)}</div>}
            {d && entries.length === 0 && <p className="muted">No merchants in this registry right now. On the live clock, entities expire 18 minutes after they are written; on production, after 60 days.</p>}
            <div className="tiles">{entries.map((e) => <LazyTile key={`${registry}:${e.key}`} entry={e} ns={registry} now={now} />)}</div>
          </>
        )}
      </div>
    </div>
  );
}
