// OpenAI-style wrapper example — records MOCKED OpenAI-style responses. NO OpenAI
// SDK, NO external API call. Callbacks are local stubs. SYNTHETIC DEMO DATA —
// not real customer data. Usage/cost are demo values.
//
// Usage: npm run example:openai-wrapper
//   → writes examples/openai-wrapper.recorded.example.json
import { writeFileSync } from "node:fs";
import { createRunLeakRecorder } from "@/lib/recorder-wrapper";
import {
  recordOpenAIStyleCall,
  type OpenAIStyleResponse,
} from "@/lib/provider-wrappers/openai-wrapper";

async function main(): Promise<void> {
  const recorder = createRunLeakRecorder({
    runName: "Demo (openai-wrapper): refactor a module",
    objective: "Prototype the OpenAI-style wrapper with mocked responses.",
    source: "manual",
    startedAt: "2026-06-20T20:00:00Z",
  });

  // 1) Success with explicit usage incl. total_tokens (preserved).
  await recordOpenAIStyleCall({
    recorder,
    id: "call-1",
    model: "gpt-demo",
    promptSummary: "Plan the refactor",
    costUsd: 0.05,
    call: async (): Promise<OpenAIStyleResponse> => ({
      id: "resp_demo_1",
      model: "gpt-demo",
      usage: { input_tokens: 3000, output_tokens: 700, total_tokens: 3700 },
      output: "…mocked plan…",
    }),
  });

  // 2) Success with input/output but MISSING total_tokens — total is derived.
  await recordOpenAIStyleCall({
    recorder,
    id: "call-2",
    model: "gpt-demo",
    promptSummary: "Apply the refactor",
    costUsd: 0.06,
    call: async (): Promise<OpenAIStyleResponse> => ({
      id: "resp_demo_2",
      model: "gpt-demo",
      usage: { input_tokens: 4200, output_tokens: 1100 }, // no total_tokens
      choices: ["…mocked diff…"],
    }),
  });

  // 3) Success but MISSING usage entirely — token fields stay null (not estimated).
  await recordOpenAIStyleCall({
    recorder,
    id: "call-3",
    model: "gpt-demo",
    promptSummary: "Quick follow-up",
    call: async (): Promise<OpenAIStyleResponse> => ({
      id: "resp_demo_3",
      model: "gpt-demo",
      output: "…mocked answer…",
    }),
  });

  // 4) Failed call — recorded with success:false + errorSummary, then rethrown.
  try {
    await recordOpenAIStyleCall({
      recorder,
      id: "call-4",
      model: "gpt-demo",
      promptSummary: "Call that fails",
      call: async (): Promise<OpenAIStyleResponse> => {
        throw new Error("mocked provider error: timeout");
      },
    });
  } catch (err) {
    recorder.addNote(
      `Caught expected error from call-4: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  recorder
    .addFileChanged("src/lib/refactor-target.ts")
    .addCommandRun("npm run lint")
    .addCommandRun("npm run build")
    .setBuildResult("pass")
    .setLintResult("pass")
    .addNote("Synthetic demo session built with the OpenAI-style wrapper prototype.")
    .addNote("Callbacks are local stubs; no OpenAI SDK or API was used.");

  const session = recorder.finish({ endedAt: "2026-06-20T20:10:00Z" });

  const outPath = "examples/openai-wrapper.recorded.example.json";
  writeFileSync(outPath, JSON.stringify(session, null, 2) + "\n");
  console.error(`Wrote ${outPath}`);
  console.log(JSON.stringify(session, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
