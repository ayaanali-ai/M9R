"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/browser";

/**
 * AuthDebugBadge — DEV-ONLY. Renders a small fixed badge comparing:
 *   - browser session (client @supabase/ssr cookie client), and
 *   - server session (via /api/auth/debug),
 * so a client/server auth disagreement ("localStorage signed in, cookies signed
 * out") is immediately visible while debugging the claim approval flow.
 *
 * Returns null in production. Never displays tokens or secrets.
 */
export default function AuthDebugBadge() {
  const [browserSession, setBrowserSession] = useState<boolean | null>(null);
  const [serverState, setServerState] = useState<{
    authenticated: boolean;
    authCookiePresent: boolean;
    email: string | null;
  } | null>(null);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;

    const supabase = createClient();
    supabase?.auth.getSession().then(({ data }) => {
      setBrowserSession(Boolean(data.session));
    });

    fetch("/api/auth/debug")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) =>
        d
          ? setServerState({
              authenticated: Boolean(d.authenticated),
              authCookiePresent: Boolean(d.authCookiePresent),
              email: d.email ?? null,
            })
          : null,
      )
      .catch(() => {});
  }, []);

  if (process.env.NODE_ENV === "production") return null;

  const agree =
    browserSession !== null && serverState !== null && browserSession === serverState.authenticated;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 12,
        right: 12,
        zIndex: 9999,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 1.5,
        padding: "8px 10px",
        borderRadius: 8,
        border: `1px solid ${agree ? "#2f5d2f" : "#5d2f2f"}`,
        background: "#0d0d0d",
        color: "#cfc8bd",
      }}
    >
      <div style={{ color: agree ? "#7bd66f" : "#e06a6a", fontWeight: 700 }}>
        auth-debug {agree ? "OK" : "MISMATCH"}
      </div>
      <div>browser session: {String(browserSession)}</div>
      <div>server session: {serverState ? String(serverState.authenticated) : "…"}</div>
      <div>server cookie: {serverState ? String(serverState.authCookiePresent) : "…"}</div>
      {serverState?.email && <div>user: {serverState.email}</div>}
    </div>
  );
}
