// Anthropic-style wrapper example — records MOCKED Anthropic Messages-style
// responses. NO Anthropic SDK, NO external API call. The callbacks are local
// stubs. SYNTHETIC DEMO DATA — not real customer data. Usage/cost are demo values.
//
// Usage: npm run example:anthropic-wrapper
//   → writes examples/anthropic-wrapper.recorded.example.json
import { writeFileSync } from "node:fs";
import { createRunLeakRecorder } from "@/lib/recorder-wrapper";
import {
  recordAnthropicStyleCall,
  type AnthropicStyleResponse,
} from "@/lib/provider-wrappers/anthropic-wrapper";

async function main(): Promise<void> {
  const recorder = createRunLeakRecorder({
    runName: "Demo (anthropic-wrapper): summarize a file",
    objective: "Prototype the Anthropic-style wrapper with mocked responses.",
    source: "manual",
    startedAt: "2026-06-20T19:00:00Z",
  });

  // 1) Success with explicit usage.
  await recordAnthropicStyleCall({
    recorder,
    id: "call-1",
    model: "claude-demo",
    promptSummary: "Summarize file",
    costUsd: 0.07,
    call: async (): Promise<AnthropicStyleResponse> => ({
      id: "msg_demo_1",
      model: "claude-demo",
      usage: { input_tokens: 4100, output_tokens: 900 },
      content: "…mocked summary…",
      stop_reason: "end_turn",
    }),
  });

  // 2) Success but MISSING usage — exact token fields must stay null (not estimated).
  await recordAnthropicStyleCall({
    recorder,
    id: "call-2",
    model: "claude-demo",
    promptSummary: "Follow-up question",
    call: async (): Promise<AnthropicStyleResponse> => ({
      id: "msg_demo_2",
      model: "claude-demo",
      // no usage field
      content: "…mocked answer…",
      stop_reason: "end_turn",
    }),
  });

  // 3) Failed call — must be recorded with success:false + errorSummary, then rethrow.
  try {
    await recordAnthropicStyleCall({
      recorder,
      id: "call-3",
      model: "claude-demo",
      promptSummary: "Call that fails",
      call: async (): Promise<AnthropicStyleResponse> => {
        throw new Error("mocked provider error: rate limit");
      },
    });
  } catch (err) {
    recorder.addNote(
      `Caught expected error from call-3: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  recorder
    .addFileChanged("src/lib/summarize.ts")
    .addCommandRun("npm run lint")
    .addCommandRun("npm run build")
    .setBuildResult("pass")
    .setLintResult("pass")
    .addNote("Synthetic demo session built with the Anthropic-style wrapper prototype.")
    .addNote("Callbacks are local stubs; no Anthropic SDK or API was used.");

  const session = recorder.finish({ endedAt: "2026-06-20T19:09:00Z" });

  const outPath = "examples/anthropic-wrapper.recorded.example.json";
  writeFileSync(outPath, JSON.stringify(session, null, 2) + "\n");
  console.error(`Wrote ${outPath}`);
  console.log(JSON.stringify(session, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
