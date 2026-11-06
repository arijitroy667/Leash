import { Icon, type IconName } from "./icons";

export interface Health { score: number; level: number; status: "good" | "warning" | "serious" | "critical"; label: string; risk: number; refUsd: number }

const ICON: Record<Health["status"], IconName> = { good: "check", warning: "alert", serious: "triangle", critical: "x" };

/**
 * A vertical meter in five levels. The fill carries severity in the fixed status colours, the track is a lighter step
 * of the same colour, and the score, label and icon say it in words, so the meter never relies on colour.
 */
export function HealthMeter({ health, standing }: { health: Health | null; standing: string }) {
  if (!health) {
    return (
      <div className="health-wrap">
        <div className="meter" data-status="none" role="meter" aria-label="Health" aria-valuemin={0} aria-valuemax={100} aria-valuetext="No verified evidence yet">
          {Array.from({ length: 5 }, (_, i) => <span key={i} className="seg" />)}
        </div>
        <div className="health-text"><span className="health-score muted">–</span><span className="muted">No verified evidence yet</span></div>
      </div>
    );
  }
  const text = `Health ${health.score} of 100, ${health.label}. Risk score ${health.risk} for a $${health.refUsd} payment. Standing ${standing}.`;
  return (
    <div className="health-wrap" title={text}>
      <div className="meter" data-status={health.status} role="meter" aria-label="Health" aria-valuemin={0} aria-valuemax={100} aria-valuenow={health.score} aria-valuetext={text}>
        {Array.from({ length: 5 }, (_, i) => <span key={i} className={`seg${i < health.level ? " on" : ""}`} />)}
      </div>
      <div className="health-text">
        <div>
          <div className="label">Live health</div>
          <div className="health-score num">{health.score}<span className="muted" style={{ fontSize: "0.95rem" }}> / 100</span></div>
        </div>
        <span className="health-label" style={{ ["--status" as string]: `var(--${health.status})` }}>
          <span className="status-dot" aria-hidden="true" /> <Icon name={ICON[health.status]} size={15} /> {health.label}
        </span>
        <span className="muted" style={{ fontSize: "0.82rem" }}>Risk {health.risk} at ${health.refUsd}</span>
      </div>
    </div>
  );
}

export function HealthLegend() {
  const rows: [Health["status"], string, string][] = [
    ["good", "Excellent, Good", "risk under 35"],
    ["warning", "Caution", "risk 35 to 50, the owner is asked"],
    ["serious", "Risky", "risk 50 to 70, the owner is asked"],
    ["critical", "Bad, Blocked", "risk 70 or more, or blocked"],
  ];
  return (
    <div className="legend" aria-label="Health levels">
      {rows.map(([s, name, what]) => (
        <span key={s} style={{ ["--status" as string]: `var(--${s})` }}>
          <span className="status-dot" aria-hidden="true" /> <Icon name={ICON[s]} size={14} /> <strong>{name}</strong> <span className="muted">{what}</span>
        </span>
      ))}
    </div>
  );
}
