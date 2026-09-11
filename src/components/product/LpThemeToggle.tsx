"use client";

import { useEffect, useState } from "react";

type LpTheme = "dark" | "light";
const STORAGE_KEY = "m9r_lp_theme";

/**
 * Light/dark toggle for the marketing surface (.lp), independent of the
 * dashboard's own day/night mechanism (dashboard-mode.ts, scoped to
 * .wf-root). Dark is the default by explicit product decision (see the
 * "Field Report" comment block in globals.css) -- light is the opt-in,
 * applied via .lp[data-lp-theme="light"]. Not a system-preference mirror,
 * so a visitor's choice is predictable and persists across the marketing
 * pages via localStorage.
 *
 * Real bug fixed here: this previously only ever set data-lp-theme to
 * "dark" or removed it, never "light" -- so the CSS's actual light-mode
 * selector (.lp[data-lp-theme="light"]) could never match, no matter what
 * the toggle showed. Every click just alternated between two states that
 * both rendered as dark (the base .lp rule *is* the dark palette), which is
 * exactly the "toggle is stuck" bug this fixes.
 */
function applyTheme(theme: LpTheme) {
  const root = document.querySelector<HTMLElement>(".lp");
  if (!root) return;
  if (theme === "light") root.setAttribute("data-lp-theme", "light");
  else root.removeAttribute("data-lp-theme");
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Toggle still works for this visit even if storage is unavailable.
  }
}

export default function LpThemeToggle({ className = "" }: { className?: string }) {
  const [theme, setTheme] = useState<LpTheme>("dark");

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      // Default to dark below.
    }
    const initial: LpTheme = stored === "light" ? "light" : "dark";
    // This effect hydrates browser-only preference state and DOM styling after SSR.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(initial);
    applyTheme(initial);
  }, []);

  function toggle() {
    const next: LpTheme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
  }

  return (
    <button
      type="button"
      className={`lp-theme-toggle ${className}`.trim()}
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      {theme === "dark" ? (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden>
          <circle cx="8" cy="8" r="3.1" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.5 3.5l1.15 1.15M11.35 11.35 12.5 12.5M12.5 3.5l-1.15 1.15M4.65 11.35 3.5 12.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M13.5 9.1A5.5 5.5 0 0 1 6.9 2.5 5.5 5.5 0 1 0 13.5 9.1Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}
