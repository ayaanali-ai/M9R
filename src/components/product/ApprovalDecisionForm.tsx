"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/product/WorkspaceUI";

/**
 * Approve/Reject buttons for /dashboard/approvals/[id]. Submits to the
 * cookie-authenticated decide route (never calls the RPC directly from the
 * client).
 *
 * This page is force-dynamic (fresh on every navigation) but has no other
 * live-refresh path -- confirmed live: a human decided this exact request
 * from elsewhere (another tab, the CLI-printed link opened a second time)
 * and this already-open page kept showing "pending" indefinitely, since a
 * mounted server component only refetches on navigation or an explicit
 * router.refresh(), never on its own. Poll while a decision is still
 * outstanding; once decided the parent server refetch drops this form from
 * the tree entirely (isPending flips false), which stops the polling too.
 */
const STALE_DECISION_POLL_MS = 5_000;

/**
 * The one deliberately weighty interaction in the whole product (design pass
 * 2026-08-21). Routine actions here stay instant; this one earns real
 * friction because it's rare and it's the moment a human actually lets a
 * real AI agent do something risky. 900ms of sustained pressure -- release
 * early and nothing happened, no undo needed because nothing committed.
 * Reject stays a normal click deliberately: only the action that PERMITS
 * something gets the friction, same asymmetry as "slow where deciding, fast
 * where declining."
 */
const HOLD_DURATION_MS = 900;

export default function ApprovalDecisionForm({ approvalRequestId }: { approvalRequestId: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, STALE_DECISION_POLL_MS);
    return () => clearInterval(timer);
  }, [router]);

  const decide = useCallback(async (decision: "approved" | "rejected") => {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/agent/approvals/${encodeURIComponent(approvalRequestId)}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, note }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof body?.error === "string" ? body.error : "Could not record the decision.");
        return;
      }
      router.refresh();
    } finally {
      setPending(false);
    }
  }, [approvalRequestId, note, router]);

  return (
    <div>
      <label htmlFor="approval-note" className="mb-1.5 block text-sm text-[color:var(--ol-text-secondary)]">
        Decision note (optional)
      </label>
      <textarea
        id="approval-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
        className="mb-3 w-full rounded-[2px] border border-[color:var(--ol-border-default)] bg-[color:var(--ol-surface-2)] p-2.5 text-sm text-[color:var(--ol-text-primary)] outline-none focus:border-[color:var(--ol-border-strong)]"
      />
      <div className="flex gap-2.5">
        <HoldToApproveButton disabled={pending} onApprove={() => void decide("approved")} />
        <Button variant="secondary" disabled={pending} onClick={() => void decide("rejected")}>
          Reject
        </Button>
      </div>
      {error ? <p className="mt-2 text-sm text-[color:var(--ol-danger)]">{error}</p> : null}
    </div>
  );
}

function HoldToApproveButton({ disabled, onApprove }: { disabled: boolean; onApprove: () => void }) {
  const [holding, setHolding] = useState(false);
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyHeldRef = useRef(false);

  const start = useCallback(() => {
    if (disabled || timerRef.current) return;
    setHolding(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setArmed(true);
      onApprove();
    }, HOLD_DURATION_MS);
  }, [disabled, onApprove]);

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setHolding(false);
  }, []);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label="Hold to approve"
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && !keyHeldRef.current) {
          keyHeldRef.current = true;
          start();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " " || e.key === "Enter") {
          keyHeldRef.current = false;
          cancel();
        }
      }}
      className="relative isolate overflow-hidden rounded-md px-4 py-2 text-sm font-medium select-none disabled:opacity-50"
      style={{
        background: "var(--ol-surface-3)",
        color: "var(--ol-text-primary)",
        border: "1px solid var(--ol-border-default)",
      }}
    >
      <span
        aria-hidden
        className="absolute inset-0 -z-10 origin-left"
        style={{
          background: "var(--ol-ok)",
          opacity: 0.9,
          transform: `scaleX(${holding ? 1 : 0})`,
          transition: holding
            ? `transform ${HOLD_DURATION_MS}ms linear`
            : `transform 200ms cubic-bezier(0.23,1,0.32,1)`,
        }}
      />
      <span className="relative" style={{ color: holding || armed ? "var(--ol-surface-0)" : "var(--ol-text-primary)" }}>
        {armed ? "Approved" : "Hold to approve"}
      </span>
    </button>
  );
}
