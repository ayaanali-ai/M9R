// Recorder Lite example — builds a SYNTHETIC DEMO RecordedCodingSession with the
// builder and writes it as runleak.recorded.v0 JSON.
//
// SYNTHETIC DEMO DATA — not real customer data, not a real recording. Token
// counts and costs are illustrative demo values. This script records only
// explicitly provided metadata; it calls no models and estimates nothing.
//
// Usage: npm run example:recorder-lite
//   → writes examples/recorded-session.from-recorder.example.json
import { writeFileSync } from "node:fs";
import { createRecordedSession } from "@/lib/recorder-lite";

const session = createRecordedSession({
  runName: "Demo (recorder-lite): add search filter to list",
  objective: "Add a text search filter to the list view and its API route.",
  source: "manual",
  startedAt: "2026-06-20T16:00:00Z",
})
  .addModelCall({
    id: "call-1",
    provider: "anthropic",
    model: "claude-demo",
    inputTokens: 3600,
    outputTokens: 800,
    costUsd: 0.05,
    latencyMs: 2100,
    promptSummary: "Plan the search filter",
    outputSummary: "Proposed query-param approach",
  })
  .addModelCall({
    id: "call-2",
    provider: "anthropic",
    model: "claude-demo",
    inputTokens: 4400,
    outputTokens: 1200,
    costUsd: 0.07,
    latencyMs: 2800,
    promptSummary: "Implement filter + route",
    outputSummary: "Wrote filter and updated route",
  })
  .addModelCall({
    id: "call-3",
    provider: "anthropic",
    model: "claude-demo",
    // No cost provided here on purpose — cost stays partial-but-explicit only.
    inputTokens: 2600,
    outputTokens: 500,
    latencyMs: 1500,
    promptSummary: "Fix a lint warning",
    outputSummary: "Adjusted import order",
  })
  .addToolCall({ id: "tool-1", toolName: "read_file", latencyMs: 35, success: true, inputSummary: "src/app/list/page.tsx" })
  .addToolCall({ id: "tool-2", toolName: "edit_file", latencyMs: 55, success: true, inputSummary: "src/lib/search-filter.ts" })
  .addToolCall({ id: "tool-3", toolName: "run_command", latencyMs: 4800, success: true, inputSummary: "npm run build" })
  .addFileChanged("src/app/list/page.tsx")
  .addFileChanged("src/app/api/list/route.ts")
  .addFileChanged("src/lib/search-filter.ts")
  .addCommandRun("npm run lint")
  .addCommandRun("npm run build")
  .setBuildResult("pass")
  .setLintResult("pass")
  .addNote("Synthetic demo session built with Recorder Lite.")
  .addNote("Token counts and costs are illustrative demo values, not measured production usage.")
  .finish({ endedAt: "2026-06-20T16:14:00Z" });

const outPath = "examples/recorded-session.from-recorder.example.json";
writeFileSync(outPath, JSON.stringify(session, null, 2) + "\n");
console.error(`Wrote ${outPath}`);
console.log(JSON.stringify(session, null, 2));
