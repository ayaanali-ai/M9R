import type { WasteFinding } from "@/lib/resource-ledger";

// Advisory prevention recommendations. M9R does not automatically modify
// production agents; these are configurable strategies, not guaranteed savings.

type PreventionItem = {
  id: string;
  title: string;
  trigger: string;
  fix: string;
  expectedImpact: string;
  confidence: "low" | "medium" | "high";
  difficulty: "low" | "medium" | "high";
};

const PREVENTION_ITEMS: PreventionItem[] = [
  {
    id: "cache-stable-context",
    title: "Cache Stable Context",
    trigger: "A repeated context block appears 3+ times.",
    fix: "Store stable context once and pass a short reference ID in later calls.",
    expectedImpact: "Removes redundant input tokens on every repeat after the first.",
    confidence: "high",
    difficulty: "low",
  },
  {
    id: "compress-tool-outputs",
    title: "Compress Tool Outputs",
    trigger: "Tool output exceeds a size threshold or appears repeatedly.",
    fix: "Summarize or extract relevant sections before feeding output back to the model.",
    expectedImpact: "Reduces carried-forward input tokens from oversized returns.",
    confidence: "medium",
    difficulty: "low",
  },
  {
    id: "retry-limits",
    title: "Add Retry Limits",
    trigger: "A failing tool call, command, or planning step repeats.",
    fix: "Stop after N attempts unless new information appears.",
    expectedImpact: "Caps wasted calls spent on non-converging retries.",
    confidence: "medium",
    difficulty: "medium",
  },
  {
    id: "route-models",
    title: "Route Models by Task",
    trigger: "A large/expensive model is used for low-risk planning, formatting, or classification.",
    fix: "Use a small model first; escalate only when needed.",
    expectedImpact: "Lowers per-call cost on work that does not need the largest model.",
    confidence: "medium",
    difficulty: "medium",
  },
  {
    id: "pass-deltas",
    title: "Pass Deltas Instead of Full History",
    trigger: "Long conversation or project history is repeatedly sent across calls.",
    fix: "Send only recent changes plus stable-context references.",
    expectedImpact: "Shrinks input token growth as the run gets longer.",
    confidence: "medium",
    difficulty: "medium",
  },
  {
    id: "budget-gates",
    title: "Add Budget Gates",
    trigger: "A run exceeds a call, token, cost, or latency threshold.",
    fix: "Pause, ask for human approval, or switch to a cheaper strategy.",
    expectedImpact: "Bounds worst-case spend and latency on a single run.",
    confidence: "high",
    difficulty: "medium",
  },
];

// Map finding types to the prevention items they most directly motivate, so the
// plan can highlight what this specific trace triggered.
const FINDING_TO_ITEMS: Record<string, string[]> = {
  repeated_context: ["cache-stable-context", "pass-deltas"],
  tool_output_bloat: ["compress-tool-outputs"],
  retry_loop: ["retry-limits", "budget-gates"],
  planning_loop: ["retry-limits", "budget-gates"],
  model_overkill: ["route-models"],
  cache_miss: ["cache-stable-context"],
  duplicate_tool_call: ["retry-limits"],
};

export default function PreventionPlan({
  findings = [],
}: {
  findings?: WasteFinding[];
}) {
  const triggered = new Set<string>();
  for (const f of findings) {
    for (const id of FINDING_TO_ITEMS[f.type] ?? []) triggered.add(id);
  }

  return (
    <section className="bg-[#0d0d0d] border border-[#1a1a1a] rounded-xl p-6">
      <div className="flex items-center gap-2 text-sm font-semibold mb-5">
        <span className="w-2 h-2 rounded-full bg-lime" />
        Prevention Plan
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        {PREVENTION_ITEMS.map((item) => {
          const isTriggered = triggered.has(item.id);
          return (
            <div
              key={item.id}
              className={`bg-[#111] border rounded-lg p-4 text-sm ${
                isTriggered ? "border-lime/40" : "border-[#222]"
              }`}
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="font-semibold">{item.title}</span>
                {isTriggered && (
                  <span className="text-[10px] font-mono text-lime border border-lime/40 rounded px-1.5 py-0.5">
                    triggered
                  </span>
                )}
              </div>
              <Field label="Trigger">{item.trigger}</Field>
              <Field label="Recommended fix">{item.fix}</Field>
              <Field label="Expected impact">{item.expectedImpact}</Field>
              <div className="text-[11px] font-mono text-muted mt-2">
                confidence: {item.confidence} · difficulty: {item.difficulty}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-4 bg-[#111] border border-[#222] rounded-lg p-3 text-xs text-muted">
        This prevention plan is advisory. M9R does not automatically modify
        production agents, and impact depends on your agent, traffic, and whether
        the fixes are applied.
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2 last:mb-0">
      <div className="text-[11px] font-mono text-muted uppercase tracking-wider">
        {label}
      </div>
      <p className="text-muted leading-relaxed">{children}</p>
    </div>
  );
}
