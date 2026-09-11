"use client";

import { useEffect } from "react";

const RELOAD_GUARD_KEY = "ol_dashboard_error_reload_at";
const RELOAD_GUARD_WINDOW_MS = 10_000;

/**
 * The single most common real-world cause of this boundary firing is not a
 * genuine data-loading failure: it's a browser tab left open across a Vercel
 * deploy, still holding the previous build's JS chunk hashes. Those chunks
 * get garbage-collected once the new deploy ships, so the next client-side
 * fetch for one 404s with the wrong MIME type, and the resulting partial
 * bundle throws a generic TypeError deep in React -- which looks identical
 * to a real crash. A timestamp guard (not a one-shot flag) lets this retry
 * again on a later, genuinely different crash instead of only ever firing
 * once per tab lifetime, while a repeat crash within the guard window still
 * shows the real error screen instead of reload-looping forever.
 */
function shouldAttemptAutoReload(): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_GUARD_KEY) ?? "0");
    if (Date.now() - last < RELOAD_GUARD_WINDOW_MS) return false;
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
    return true;
  } catch {
    // sessionStorage can throw in locked-down contexts (private browsing,
    // strict cookie policies) -- fail open to the normal error screen
    // rather than risk an unguarded reload loop.
    return false;
  }
}

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!shouldAttemptAutoReload()) return;
    window.location.reload();
    // No cleanup: the reload navigates away regardless.
  }, []);

  return (
    <div className="workspace-error-state">
      <div className="workspace-error-glyph" aria-hidden>!</div>
      <h1 className="mt-5 text-lg font-semibold tracking-[-0.02em] text-[color:var(--ol-text-primary)]">
        Workspace data could not be loaded
      </h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-[color:var(--ol-text-faint)]">
        The request failed before the dashboard could finish loading.
      </p>
      {error.digest && (
        <p className="mt-1 text-xs text-[color:var(--ol-text-faint)]">Reference: {error.digest}</p>
      )}
      <button type="button" onClick={reset} className="product-secondary mt-5">
        Try again
      </button>
    </div>
  );
}
