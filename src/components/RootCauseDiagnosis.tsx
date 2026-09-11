import type { WasteFinding, WasteFindingType } from "@/lib/resource-ledger";

// Converts trace-derived waste findings into plain-English diagnosis. This does
// not assume OathLock knows the system internals — every line is framed as what
// the trace evidence suggests.

const DIFFICULTY: Record<WasteFindingType, "low" | "medium" | "high"> = {
  repeated_context: "low",
  tool_output_bloat: "low",
  cache_miss: "low",
  duplicate_tool_call: "low",
  retry_loop: "medium",
  planning_loop: "medium",
  model_overkill: "medium",
};

const LIKELY_CAUSE: Record<WasteFindingType, string> = {
  repeated_context:
    "The agent is treating stable project context as live conversational context, resending the full block on each call instead of caching it once.",
  tool_output_bloat:
    "A tool is returning far more data than the model needs, and that bloat is carried forward as input tokens in later calls.",
  retry_loop:
    "A failing step is being retried without new information, so the same call repeats with no path to success.",
  planning_loop:
    "The agent re-plans repeatedly without converging, re-deriving the same plan across multiple calls.",
  model_overkill:
    "A large, expensive model is being used for low-risk work that a smaller model could handle.",
  cache_miss:
    "Cacheable content is being recomputed or refetched instead of being reused from a prior step.",
  duplicate_tool_call:
    "The same tool call with the same arguments is being issued more than once.",
};

export default function RootCauseDiagnosis({
  findings,
}: {
  findings: WasteFinding[];
}) {
  if (findings.length === 0) {
    return (
      <section className="bg-[#0d0d0d] border border-[#1a1a1a] rounded-xl p-6">
        <div className="flex items-center gap-2 text-sm font-semibold mb-3">
          <span className="w-2 h-2 rounded-full bg-lime" />
          Root-Cause Diagnosis
        </div>
        <p className="text-sm text-muted">No waste findings to diagnose in this trace.</p>
      </section>
    );
  }

  return (
    <section className="bg-[#0d0d0d] border border-[#1a1a1a] rounded-xl p-6">
      <div className="flex items-center gap-2 text-sm font-semibold mb-5">
        <span className="w-2 h-2 rounded-full bg-lime" />
        Root-Cause Diagnosis
      </div>
      <div className="space-y-4">
        {findings.map((f) => (
          <div
            key={f.id}
            className="bg-[#111] border border-[#222] rounded-lg p-4 text-sm"
          >
            <div className="flex items-center justify-between gap-3 mb-3">
              <span className="font-semibold">{f.title}</span>
              <span className="flex items-center gap-2 text-[11px] font-mono text-muted shrink-0">
                <span>confidence: {f.confidence}</span>
                <span>·</span>
                <span>difficulty: {DIFFICULTY[f.type]}</span>
              </span>
            </div>
            <Row label="Likely cause">{LIKELY_CAUSE[f.type]}</Row>
            <Row label="Evidence from trace">
              <ul className="list-disc list-inside space-y-0.5">
                {f.evidence.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </Row>
            <Row label="Affected steps">
              <span className="font-mono text-xs">
                {f.affectedSteps.length > 0
                  ? f.affectedSteps.map((s) => `step-${s}`).join(", ")
                  : "—"}
              </span>
            </Row>
            <Row label="Recommended fix">{f.recommendation}</Row>
          </div>
        ))}
      </div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="text-[11px] font-mono text-muted uppercase tracking-wider mb-1">
        {label}
      </div>
      <div className="text-muted leading-relaxed">{children}</div>
    </div>
  );
}
