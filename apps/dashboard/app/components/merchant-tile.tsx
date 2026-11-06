"use client";
import { useEffect, useState } from "react";
import { MerchantDetail } from "../ui";
import { Chip, Skeleton } from "./bits";
import { HealthMeter } from "./health-meter";
import { usePoll, useInView } from "./live";

export interface Entry { key: string; name: string | null; payTo: string | null; source?: "deployment" | "registry" }

export function useClock() {
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** One merchant. Its verified read is costly, so it starts only when the card scrolls into view, and pauses off screen. */
export function LazyTile({ entry, ns, now, details = true }: { entry: Entry; ns?: string; now: number; details?: boolean }) {
  const { ref, seen, visible } = useInView<HTMLElement>("300px");
  const q = `key=${encodeURIComponent(entry.key)}${ns ? `&ns=${encodeURIComponent(ns)}` : ""}`;
  const { data, error } = usePoll<any>(seen ? `/api/explorer?${q}` : null, 8000, visible);
  const m = data?.merchants?.[0];
  return (
    <article ref={ref} className="card tile lift" aria-busy={!m} aria-label={`Merchant ${entry.name ?? entry.payTo}`}>
      <div className="tile-head">
        <div style={{ minWidth: 0 }}>
          <div className="tile-name">{entry.name ?? entry.payTo}</div>
          <div className="row start" style={{ gap: 6, marginTop: 6 }}>
            {m ? <Chip v={m.standing} /> : <span className="skeleton" style={{ width: 70, height: 22, display: "inline-block" }} />}
            {entry.source === "registry" && <span className="chip">found on Arkiv</span>}
          </div>
        </div>
        {m ? <HealthMeter health={m.health} standing={m.standing} /> : <div className="meter" data-status="none" aria-hidden="true">{[0, 1, 2, 3, 4].map((i) => <span key={i} className="seg" />)}</div>}
      </div>
      {details && (m ? <MerchantDetail m={m} now={now} /> : <Skeleton lines={4} />)}
      {error && !m && <p className="err">{error}</p>}
    </article>
  );
}
