import AgentTrackRecord from "@/components/product/AgentTrackRecord";
import type { TrackRecordPassport } from "@/lib/agent-track-record";

/**
 * /design/track-record — static, no-auth reference for the Track Record band
 * (same convention as /design/watchfloor): every standing rendered from fixture
 * data so the states can be reviewed without a seeded workspace.
 */

function passport(runId: string, decision: "reviewed" | "needs_follow_up" | "not_accepted", verification: Array<"passed" | "failed"> = [], changedFiles?: string[]): TrackRecordPassport {
  return {
    run_id: runId,
    submitted_at: new Date(Date.now() - 4 * 3600_000).toISOString(),
    human_review: { decision, reviewed_at: new Date(Date.now() - 3 * 3600_000).toISOString() },
    evidence: { verification_provenance: verification.map((result) => ({ result })), changed_files: changedFiles },
  };
}

const CASES: Array<{ title: string; agentLabel: string; runs: Array<{ id: string }>; passports: TrackRecordPassport[] }> = [
  {
    title: "No record yet",
    agentLabel: "Grok Build",
    runs: [{ id: "n1" }, { id: "n2" }],
    passports: [],
  },
  {
    title: "Building (below decision threshold)",
    agentLabel: "Claude Code",
    runs: [{ id: "b1" }, { id: "b2" }, { id: "b3" }],
    passports: [passport("b1", "reviewed", ["passed"]), passport("b2", "reviewed", ["passed", "passed"])],
  },
  {
    title: "Consistent record",
    agentLabel: "Codex",
    runs: [{ id: "c1" }, { id: "c2" }, { id: "c3" }, { id: "c4" }, { id: "c5" }],
    passports: [
      passport("c1", "reviewed", ["passed", "passed"]),
      passport("c2", "reviewed", ["passed"]),
      passport("c3", "reviewed", ["passed"]),
      passport("c4", "needs_follow_up", ["passed", "failed"]),
    ],
  },
  {
    title: "Rework signal (a later run touched reviewed files)",
    agentLabel: "Claude Code",
    runs: [{ id: "w1" }, { id: "w2" }, { id: "w3" }],
    passports: [
      passport("w1", "reviewed", ["passed"], ["src/lib/auth.ts"]),
      passport("w2", "reviewed", ["passed"]),
      passport("w3", "reviewed", ["passed"]),
      {
        run_id: "w-later",
        submitted_at: new Date(Date.now() - 30 * 60_000).toISOString(),
        human_review: { decision: null, reviewed_at: null },
        evidence: { verification_provenance: [], changed_files: ["src/lib/auth.ts"] },
      },
    ],
  },
  {
    title: "Needs attention (a rejection on record)",
    agentLabel: "Codex",
    runs: [{ id: "a1" }, { id: "a2" }, { id: "a3" }],
    passports: [passport("a1", "reviewed", ["passed"]), passport("a2", "reviewed"), passport("a3", "not_accepted", ["failed"])],
  },
];

export default function TrackRecordReference() {
  return (
    <div className="min-h-screen bg-[#0b0b0d] px-8 py-10 text-neutral-200">
      <h1 className="text-sm font-semibold tracking-wide text-neutral-400">/design/track-record — Track Record band states (fixture data)</h1>
      <div className="mt-6 max-w-3xl space-y-8">
        {CASES.map((c) => (
          <div key={c.title}>
            <div className="text-[11px] uppercase tracking-widest text-neutral-500">{c.title}</div>
            <AgentTrackRecord agentLabel={c.agentLabel} runs={c.runs} passports={c.passports} />
          </div>
        ))}
      </div>
    </div>
  );
}
