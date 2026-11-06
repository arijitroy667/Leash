// Small inline icons. Every status icon sits beside a text label, so colour never carries meaning alone.
const P = {
  check: "M5 12.5 10 17 19 7",
  x: "M6 6l12 12M18 6 6 18",
  alert: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5v5.5M12 16.5h.01",
  plus: "M12 5v14M5 12h14",
  pause: "M9 7v10M15 7v10",
  triangle: "M12 4 21 19H3z",
  dot: "M12 12h.01",
  shield: "M12 2.8 4.5 5.6v5.9c0 4.6 3.2 8.6 7.5 9.8 4.3-1.2 7.5-5.2 7.5-9.8V5.6z",
  bolt: "M13 3 5 14h6l-1 7 8-11h-6z",
  eye: "M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12zM12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z",
  doc: "M7 3h7l5 5v13H7zM14 3v5h5",
  plug: "M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5",
  sun: "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 1.5v3M12 19.5v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1.5 12h3M19.5 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1",
  moon: "M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z",
  menu: "M4 7h16M4 12h16M4 17h16",
  arrow: "M5 12h14M13 6l6 6-6 6",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
} as const;

export type IconName = keyof typeof P;

export function Icon({ name, size = 18, label }: { name: IconName; size?: number; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"
      role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} focusable="false" className="chip-icon" style={{ width: size, height: size }}>
      <path d={P[name]} />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
        <path d={P.shield} />
        <path d="M8.5 12.2 11 14.6l4.8-5" />
      </svg>
    </span>
  );
}
