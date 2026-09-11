// Recorder Wrapper example — records SYNTHETIC DEMO callbacks with explicit
// usage/cost metadata. The callbacks are local stubs; NO provider/model is
// called. SYNTHETIC DEMO DATA — not real customer data, not a real recording.
//
// Usage: npm run example:recorder-wrapper
//   → writes examples/recorder-wrapper.recorded.example.json
import { writeFileSync } from "node:fs";
import { createRunLeakRecorder } from "@/lib/recorder-wrapper";

async function main(): Promise<void> {
  const recorder = createRunLeakRecorder({
    runName: "Demo (recorder-wrapper): add CSV export",
    objective: "Wrap two model-call and two tool-call callbacks while recording explicit usage.",
    source: "manual",
    startedAt: "2026-06-20T18:00:00Z",
  });

  // Two wrapped model-call callbacks. The callbacks return demo strings — no
  // provider is contacted. Usage/cost are explicit demo values.
  await recorder.recordModelCall({
    id: "call-1",
    provider: "openai",
    model: "gpt-demo",
    promptSummary: "Plan CSV export",
    usage: { input_tokens: 3000, output_tokens: 600, total_tokens: 3600 },
    costUsd: 0.04,
    call: async () => "planned",
  });

  await recorder.recordModelCall({
    id: "call-2",
    provider: "anthropic",
    model: "claude-demo",
    promptSummary: "Implement CSV export",
    // Anthropic-style: input/output only; total derived (both explicit).
    usage: { input_tokens: 4200, output_tokens: 1100 },
    costUsd: 0.09,
    call: async () => "implemented",
  });

  // Two wrapped tool-call callbacks.
  await recorder.recordToolCall({
    id: "tool-1",
    toolName: "edit_file",
    inputSummary: "src/lib/csv-export.ts",
    call: async () => "edited",
  });

  await recorder.recordToolCall({
    id: "tool-2",
    toolName: "run_command",
    inputSummary: "npm run build",
    call: async () => "ok",
  });

  recorder
    .addFileChanged("src/lib/csv-export.ts")
    .addFileChanged("src/app/export/page.tsx")
    .addCommandRun("npm run lint")
    .addCommandRun("npm run build")
    .setBuildResult("pass")
    .setLintResult("pass")
    .addNote("Synthetic demo session built with the Recorder Wrapper.")
    .addNote("Callbacks are local stubs; no provider was called. Usage/cost are demo values.");

  const session = recorder.finish({ endedAt: "2026-06-20T18:11:00Z" });

  const outPath = "examples/recorder-wrapper.recorded.example.json";
  writeFileSync(outPath, JSON.stringify(session, null, 2) + "\n");
  console.error(`Wrote ${outPath}`);
  console.log(JSON.stringify(session, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
