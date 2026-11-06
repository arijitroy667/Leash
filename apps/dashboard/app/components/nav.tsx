"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon, Logo } from "./icons";

const LINKS: [string, string][] = [["/demo", "Live demo"], ["/explorer", "Explorer"], ["/docs", "Docs"], ["/integrate", "Integrate"]];

function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);
  useEffect(() => {
    const set = document.documentElement.dataset.theme;
    setDark(set ? set === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
  }, []);
  const flip = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.dataset.theme = next ? "dark" : "light";
    try {
      localStorage.setItem("leash-theme", next ? "dark" : "light");
    } catch {
      /* private mode: the choice lasts for this page only */
    }
  };
  return (
    <button type="button" onClick={flip} aria-pressed={dark ?? false} aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} title="Theme">
      <Icon name={dark ? "sun" : "moon"} />
    </button>
  );
}

export function Nav({ publicMode }: { publicMode: boolean }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const links = publicMode ? LINKS : [...LINKS, ["/console", "Console"] as [string, string]];
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [open]);
  return (
    <header className="nav">
      <div className="nav-inner">
        <Link href="/" className="brand" aria-label="Leash home">
          <Logo /> Leash
        </Link>
        <button ref={button} type="button" className="menu-btn" aria-expanded={open} aria-controls="nav-links" onClick={() => setOpen(!open)}>
          <Icon name="menu" /> Menu
        </button>
        <nav id="nav-links" aria-label="Main" className={`nav-links${open ? " open" : ""}`}>
          {links.map(([href, label]) => (
            <Link key={href} href={href} aria-current={path === href || path.startsWith(`${href}/`) ? "page" : undefined}>{label}</Link>
          ))}
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
