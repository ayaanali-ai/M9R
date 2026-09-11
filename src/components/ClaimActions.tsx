"use client";

import { useState } from "react";
import { buildSignInHref } from "@/lib/safe-redirect";

/**
 * ClaimActions — approve/reject buttons for the human claim page. Calls
 * POST /api/agent/claim/[claimId] and shows the result. Approval requires a
 * signed-in user (enforced server-side); when unauthenticated the server
 * returns 401 and we surface a sign-in prompt.
 */
export default function ClaimActions({
  claimId,
  signedIn,
  returnTo,
}: {
  claimId: string;
  signedIn: boolean;
  /** Safe relative path to return to after sign-in (this claim page). */
  returnTo: string;
}) {
  const signInHref = buildSignInHref(returnTo);
  const [state, setState] = useState<"idle" | "working" | "approved" | "rejected" | "error">("idle");
  const [message, setMessage] = useState<string>("");

  async function act(decision: "approve" | "reject") {
    setState("working");
    setMessage("");
    try {
      const res = await fetch(`/api/agent/claim/${claimId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState("error");
        setMessage(data?.error ?? "Something went wrong.");
        return;
      }
      setState(decision === "approve" ? "approved" : "rejected");
    } catch {
      setState("error");
      setMessage("Network error. Try again.");
    }
  }

  if (state === "approved") {
    return (
      <div className="rounded-xl border border-lime/30 bg-lime/5 p-5 text-sm text-[#e8e2d8]">
        <p className="font-semibold text-lime">Connection approved.</p>
        <p className="mt-1.5 leading-relaxed text-muted">
          Your agent can now retrieve its scoped token and continue. You can close this page and
          return to your agent.
        </p>
      </div>
    );
  }

  if (state === "rejected") {
    return (
      <div className="rounded-xl border border-[#3a2222] bg-[#160d0d] p-5 text-sm text-[#e8e2d8]">
        <p className="font-semibold text-red">Connection rejected.</p>
        <p className="mt-1.5 leading-relaxed text-muted">
          No connection was created. If this was a mistake, ask the agent to request a new claim.
        </p>
      </div>
    );
  }

  if (!signedIn) {
    return (
      <div className="rounded-xl border border-[#222] bg-[#0d0d0d] p-5 text-sm">
        <p className="leading-relaxed text-muted">
          Sign in to approve this connection. Approval binds the agent to a workspace you own.
        </p>
        <a
          href={signInHref}
          className="mt-4 inline-flex rounded-xl bg-lime px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#64131f]"
        >
          Sign in to approve this claim
        </a>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={state === "working"}
          onClick={() => act("approve")}
          className="inline-flex items-center justify-center rounded-xl bg-lime px-6 py-3 text-sm font-bold text-white transition-all hover:bg-[#64131f] active:scale-[0.98] disabled:opacity-50"
        >
          {state === "working" ? "Working…" : "Approve connection"}
        </button>
        <button
          type="button"
          disabled={state === "working"}
          onClick={() => act("reject")}
          className="inline-flex items-center justify-center rounded-xl border border-[#333] px-6 py-3 text-sm font-semibold text-white transition-all hover:border-[#444] hover:bg-[#111] active:scale-[0.98] disabled:opacity-50"
        >
          Reject
        </button>
      </div>
      {state === "error" && message && (
        <p className="mt-3 text-sm text-red">{message}</p>
      )}
    </div>
  );
}
