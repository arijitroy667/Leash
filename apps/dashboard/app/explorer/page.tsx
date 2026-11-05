"use client";
import { useEffect, useState } from "react";
import { MerchantCard, ProfileBanner } from "../ui";

export default function Explorer() {
  const [data, setData] = useState<any>(null);
  const [key, setKey] = useState("");
  const [active, setActive] = useState("");
  const [ns, setNs] = useState("");
  const [error, setError] = useState("");
  const [clock, setClock] = useState(Date.now() / 1000);

  useEffect(() => {
    const load = async () => {
      try {
        const q = new URLSearchParams();
        if (active) q.set("key", active);
        if (ns) q.set("ns", ns);
        const r = await fetch(`/api/explorer?${q}`, { cache: "no-store" });
        const j = await r.json();
        setData(j);
        setError(j.error ?? "");
      } catch {
        setError("Could not reach the registry. Try again in a moment.");
      }
    };
    load();
    const poll = setInterval(load, 4000);
    const tick = setInterval(() => setClock(Date.now() / 1000), 500);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [active, ns]);

  return (
    <main>
      <div className="top">
        <h1>Leash <span className="muted" style={{ fontWeight: 400 }}>merchant explorer</span></h1>
        {data?.namespaces?.length > 1 ? (
          <label className="muted">Registry{" "}
            <select value={data.namespace} onChange={(e) => setNs(e.target.value)}>
              {data.namespaces.map((n: any) => <option key={n.ns} value={n.ns}>{n.ns} ({n.profile})</option>)}
            </select>
          </label>
        ) : data && <span className="muted">registry namespace <code>{data.namespace}</code></span>}
      </div>
      {data && <ProfileBanner profile={data.profile} note={data.policyNote} />}
      <p className="muted">
        Live from ENSv2 on Sepolia, Arkiv and Hedera Mirror Node. Every report is re-verified here against its real payment before it counts. A report with no proof shows as ignored.
      </p>
      <form className="row" style={{ justifyContent: "flex-start", marginBottom: 16 }} onSubmit={(e) => { e.preventDefault(); setActive(key.trim()); }}>
        <label htmlFor="q" className="muted">ENS name, domain or Hedera account</label>
        <input id="q" value={key} onChange={(e) => setKey(e.target.value)} placeholder="leash-lemon.eth" />
        <button type="submit">Look up</button>
        {active && <button type="button" onClick={() => { setKey(""); setActive(""); }}>Show all</button>}
      </form>
      {error && <p className="err" role="alert">{error}</p>}
      {!data && !error && <p className="muted">Reading live registry…</p>}
      <div className="grid">{data?.merchants?.map((m: any) => <MerchantCard key={m.key} m={m} now={clock} />)}</div>
      {data?.merchants?.length === 0 && <p className="muted">No merchants found.</p>}
    </main>
  );
}
