"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * Calls /api/workspace/invites/accept once on mount and shows the result.
 * The API is the actual authority on validity (email match, expiry,
 * already-accepted) -- this only renders whatever it decides.
 */
export default function InviteAcceptClient({ token }: { token: string }) {
  const [state, setState] = useState<"pending" | "accepted" | "error">("pending");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/workspace/invites/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        if (!active) return;
        if (res.ok) {
          setState("accepted");
        } else {
          setState("error");
          setMessage(json.error || "Could not accept this invite.");
        }
      })
      .catch(() => {
        if (active) {
          setState("error");
          setMessage("Could not reach the server. Try again.");
        }
      });
    return () => { active = false; };
  }, [token]);

  return (
    <div className="auth-min-card">
      <h1 className="auth-min-title">
        {state === "pending" ? "Joining workspace…" : state === "accepted" ? "You're in" : "Could not join"}
      </h1>
      <p className="text-center text-[13px] leading-relaxed" style={{ color: "var(--premium-paper-muted, #999)" }}>
        {state === "pending" && "Checking your invite…"}
        {state === "accepted" && "You now have access to this workspace."}
        {state === "error" && message}
      </p>
      {state === "accepted" && (
        <Link href="/dashboard/agents" className="ol-btn ol-btn--primary" style={{ textAlign: "center" }}>
          Go to workspace
        </Link>
      )}
      {state === "error" && (
        <Link href="/dashboard/agents" className="ol-btn ol-btn--secondary" style={{ textAlign: "center" }}>
          Back to dashboard
        </Link>
      )}
    </div>
  );
}
