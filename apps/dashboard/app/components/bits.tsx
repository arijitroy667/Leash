import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { CopyButton } from "./copy-button";

const VERDICT_ICON: Record<string, IconName> = {
  ALLOW: "check", ESCALATE: "pause", DENY: "x", paid: "check", escalated: "pause", denied: "x",
  BLOCKED: "x", PROBATION: "alert", NEW: "plus", ESTABLISHED: "check", UNKNOWN: "alert",
  good: "check", bad: "x", pass: "check", fail: "x", pending: "pause", approved: "check", rejected: "x", used: "check", expired: "x", requested: "pause",
};

/** A state chip: icon plus the word, on a tint. Never colour alone. */
export function Chip({ v, children }: { v: string; children?: ReactNode }) {
  const icon = VERDICT_ICON[v];
  return (
    <span className={`chip ${v}`}>
      {icon && <Icon name={icon} size={14} />}
      {children ?? v}
    </span>
  );
}

export function Skeleton({ lines = 3, height = 14 }: { lines?: number; height?: number }) {
  return (
    <div aria-hidden="true" className="stack" style={{ minWidth: 0 }}>
      {Array.from({ length: lines }, (_, i) => <div key={i} className="skeleton" style={{ height, width: `${92 - i * 14}%` }} />)}
    </div>
  );
}

export function CodeBlock({ code, label = "Code", lang }: { code: string; label?: string; lang?: string }) {
  return (
    <figure className="code" aria-label={label} style={{ margin: undefined }}>
      <figcaption className="code-head">
        <span>{label}{lang ? ` · ${lang}` : ""}</span>
        <CopyButton text={code} />
      </figcaption>
      <pre tabIndex={0}><code>{code}</code></pre>
    </figure>
  );
}

export const HASHSCAN = "https://hashscan.io/testnet";
/** Arkiv's Rabdi explorer: an entity's page shows its attributes and the transaction that wrote it. */
export const arkivEntity = (key: string) => `https://rabdi.explorer.arkiv.network/entity/${key}`;
export const hashscanTx = (id: string) => {
  const [acct, time = ""] = id.split("@");
  const [sec, nano = "0"] = time.split(".");
  return `${HASHSCAN}/transaction/${acct}-${sec}-${nano.padEnd(9, "0")}`;
};
export const usd = (n: number) => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;
export const short = (s: string, n = 10) => (s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-6)}` : s);
export function ago(sec: number, now = Date.now() / 1000) {
  const s = Math.max(0, Math.round(now - sec));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}
