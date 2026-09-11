"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";

/**
 * PromoteRuleButton — human action that promotes a recommended (needs_review)
 * rule to active. Calls POST /api/agent/rules/promote. M9R never
 * auto-promotes; this button is the only path. On success the active rule will
 * appear in `npx m9r-cli rules` on the next run.
 */
export default function PromoteRuleButton({
  ruleId,
  targetConnectionId,
  agentLabel,
}: {
  ruleId: string;
  targetConnectionId?: string | null;
  agentLabel?: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function promote() {
    setState("loading");
    setError(null);
    try {
      const res = await fetch("/api/agent/rules/promote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rule_id: ruleId, target_connection_id: targetConnectionId ?? undefined }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error || "Could not promote this rule.");
        setState("error");
        return;
      }
      setState("done");
      router.refresh();
    } catch {
      setError("Could not promote this rule. Check your connection and retry.");
      setState("error");
    }
  }

  const idleLabel = agentLabel ? `Promote for ${agentLabel}` : "Promote to active";

  if (state === "done") {
    return (
      <span className="flex items-center gap-2 text-[11px] text-[color:var(--ol-ok)]">
        <Check className="h-[14px] w-[14px] shrink-0" strokeWidth={2.5} />
        Promoted{agentLabel ? ` for ${agentLabel}` : ""}. Active on the next run.
      </span>
    );
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        onClick={promote}
        disabled={state === "loading"}
        className="rounded-md bg-white/[0.055] px-2.5 py-1 text-[11px] font-medium text-[color:var(--ol-text-primary)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] transition-colors hover:bg-white/[0.1] hover:text-white disabled:opacity-50"
      >
        {state === "loading" ? "Promoting..." : state === "error" ? "Retry promote" : idleLabel}
      </button>
      {state === "error" && error && (
        <span role="alert" className="max-w-44 text-right text-[10px] leading-snug text-[color:var(--ol-danger)]">
          {error}
        </span>
      )}
    </div>
  );
}
