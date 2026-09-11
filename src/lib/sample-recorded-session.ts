// CANONICAL synthetic recorded-session fixture. examples/recorded-session.example.json
// mirrors these values for the CLI/docs; keep the two in sync if either changes.
// Used by the /import "Load recorded-session example" button. SYNTHETIC DEMO DATA —
// not real customer usage. Token counts and costs here are illustrative demo values.
import type { RecordedCodingSession } from "@/lib/trace-recorder-schema";

export const SAMPLE_RECORDED_SESSION: RecordedCodingSession = {
  schemaVersion: "runleak.recorded.v0",
  runName: "Demo: add pagination to results list",
  objective: "Add cursor-based pagination to the results list and update the API route.",
  source: "claude_code",
  startedAt: "2026-06-20T15:00:00Z",
  endedAt: "2026-06-20T15:18:00Z",
  filesChanged: [
    "src/app/results/page.tsx",
    "src/app/api/results/route.ts",
    "src/lib/pagination.ts",
  ],
  commandsRun: ["npm run lint", "npm run build"],
  modelCalls: [
    {
      id: "call-1",
      provider: "anthropic",
      model: "claude-demo",
      inputTokens: 4200,
      outputTokens: 900,
      totalTokens: 5100,
      costUsd: 0.06,
      latencyMs: 2300,
      promptSummary: "Plan pagination approach",
      outputSummary: "Proposed cursor-based plan",
    },
    {
      id: "call-2",
      provider: "anthropic",
      model: "claude-demo",
      inputTokens: 5100,
      outputTokens: 1400,
      totalTokens: 6500,
      costUsd: 0.08,
      latencyMs: 3100,
      promptSummary: "Implement pagination.ts",
      outputSummary: "Wrote pagination helper",
    },
    {
      id: "call-3",
      provider: "anthropic",
      model: "claude-demo",
      inputTokens: 3800,
      outputTokens: 700,
      totalTokens: 4500,
      costUsd: 0.05,
      latencyMs: 1900,
      promptSummary: "Wire route + page",
      outputSummary: "Updated route and page",
    },
  ],
  toolCalls: [
    { id: "tool-1", toolName: "read_file", latencyMs: 40, success: true, inputSummary: "src/app/api/results/route.ts" },
    { id: "tool-2", toolName: "edit_file", latencyMs: 60, success: true, inputSummary: "src/lib/pagination.ts" },
    { id: "tool-3", toolName: "run_command", latencyMs: 5200, success: true, inputSummary: "npm run build" },
  ],
  buildResult: "pass",
  lintResult: "pass",
  knownErrors: [],
  notes: [
    "Synthetic demo session for the runleak.recorded.v0 schema.",
    "Token counts and costs here are illustrative demo values, not measured production usage.",
  ],
};
