"use client";

import { useState } from "react";
import { buildSignInHref } from "@/lib/safe-redirect";

export default function ClaimBatchActions({
  batchId,
  signedIn,
  returnTo,
  pendingCount,
}: {
  batchId: string;
  signedIn: boolean;
  returnTo: string;
  pendingCount: number;
}) {
  const signInHref = buildSignInHref(returnTo);
  const [state, setState] = useState<"idle" | "working" | "approved" | "partial" | "rejected" | "error">("idle");
  const [message, setMessage] = useState("");

  async function act(decision: "approve" | "reject") {
    setState("working");
    setMessage("");
    try {
      const res = await fetch("/api/agent/claim/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batch_id: batchId, decision }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState("error");
        setMessage(data?.error ?? "Something went wrong.");
        return;
      }
      if (decision === "reject") {
        setState("rejected");
        return;
      }
      setState(data?.status === "partial" ? "partial" : data?.status === "failed" ? "error" : "approved");
      if (data?.status === "partial") setMessage("Some provider connections were approved. Review the individual results below.");
      if (data?.status === "failed") setMessage("No provider connections were approved. The claims may have expired or already been resolved.");
    } catch {
      setState("error");
      setMessage("Network error. Try again.");
    }
  }

  if (state === "approved") {
    return <Result tone="ok" title="Connections approved." body="Each provider can now retrieve its own scoped token. Return to your terminal; the CLI is waiting." />;
  }
  if (state === "partial") {
    return <Result tone="warn" title="Some connections were approved." body={message} />;
  }
  if (state === "rejected") {
    return <Result tone="warn" title="Connections rejected." body="No new provider connections were created." />;
  }
  if (!signedIn) {
    return (
      <div className="rounded-xl border border-[#222] bg-[#0d0d0d] p-5 text-sm">
        <p className="leading-relaxed text-muted">Sign in to approve these provider connections. Approval binds them to a workspace you own.</p>
        <a href={signInHref} className="mt-4 inline-flex rounded-xl bg-lime px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#64131f]">
          Sign in to approve these claims
        </a>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={state === "working" || pendingCount === 0} onClick={() => act("approve")} className="inline-flex items-center justify-center rounded-xl bg-lime px-6 py-3 text-sm font-bold text-white transition-all hover:bg-[#64131f] active:scale-[0.98] disabled:opacity-50">
          {state === "working" ? "Working…" : `Approve ${pendingCount} connection${pendingCount === 1 ? "" : "s"}`}
        </button>
        <button type="button" disabled={state === "working" || pendingCount === 0} onClick={() => act("reject")} className="inline-flex items-center justify-center rounded-xl border border-[#333] px-6 py-3 text-sm font-semibold text-white transition-all hover:border-[#444] hover:bg-[#111] active:scale-[0.98] disabled:opacity-50">
          Reject all
        </button>
      </div>
      {state === "error" && message && <p className="mt-3 text-sm text-red">{message}</p>}
    </div>
  );
}

function Result({ tone, title, body }: { tone: "ok" | "warn"; title: string; body: string }) {
  const cls = tone === "ok" ? "border-lime/30 bg-lime/5" : "border-[#3a2f12] bg-[#15110a]";
  return <div className={`rounded-xl border p-5 text-sm text-[#e8e2d8] ${cls}`}><p className="font-semibold text-lime">{title}</p><p className="mt-1.5 leading-relaxed text-muted">{body}</p></div>;
}
