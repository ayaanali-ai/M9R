// Provider Wrapper Comparison example — proves that the Anthropic-style and
// OpenAI-style wrapper outputs both feed the SAME RunLeak normalized-trace and
// comparison pipeline. MOCKED ONLY: no SDKs, no external API calls, local stub
// callbacks. SYNTHETIC DEMO DATA — not real customer data. Usage/cost are demo
// values; failed calls never invent usage.
//
// Usage: npm run example:wrapper-comparison
//   → writes recorded + normalized JSON for both providers and a comparison report.
import { writeFileSync } from "node:fs";
import { createRunLeakRecorder } from "@/lib/recorder-wrapper";
import {
  recordAnthropicStyleCall,
  type AnthropicStyleResponse,
} from "@/lib/provider-wrappers/anthropic-wrapper";
import {
  recordOpenAIStyleCall,
  type OpenAIStyleResponse,
} from "@/lib/provider-wrappers/openai-wrapper";
import { recordedSessionToNormalizedTrace } from "@/lib/recorded-session-adapter";
import { compareNormalizedRuns } from "@/lib/trace-comparison";
import type { RecordedCodingSession } from "@/lib/trace-recorder-schema";

function write(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
  console.error(`Wrote ${path}`);
}

async function buildAnthropicSession(): Promise<RecordedCodingSession> {
  const recorder = createRunLeakRecorder({
    runName: "Comparison — Anthropic-style run",
    objective: "Anthropic-style mocked run for the wrapper comparison proof.",
    source: "manual",
    startedAt: "2026-06-20T21:00:00Z",
  });

  await recordAnthropicStyleCall({
    recorder,
    id: "a-call-1",
    model: "claude-demo",
    promptSummary: "Plan",
    costUsd: 0.06,
    call: async (): Promise<AnthropicStyleResponse> => ({
      id: "msg_1",
      model: "claude-demo",
      usage: { input_tokens: 3500, output_tokens: 800 },
      content: "…plan…",
    }),
  });
  await recordAnthropicStyleCall({
    recorder,
    id: "a-call-2",
    model: "claude-demo",
    promptSummary: "Implement",
    costUsd: 0.09,
    call: async (): Promise<AnthropicStyleResponse> => ({
      id: "msg_2",
      model: "claude-demo",
      usage: { input_tokens: 4800, output_tokens: 1300 },
      content: "…impl…",
    }),
  });
  // Missing-usage call.
  await recordAnthropicStyleCall({
    recorder,
    id: "a-call-3",
    model: "claude-demo",
    promptSummary: "Follow-up (no usage)",
    call: async (): Promise<AnthropicStyleResponse> => ({
      id: "msg_3",
      model: "claude-demo",
      content: "…answer…",
    }),
  });
  // Failed call.
  try {
    await recordAnthropicStyleCall({
      recorder,
      id: "a-call-4",
      model: "claude-demo",
      promptSummary: "Fails",
      call: async (): Promise<AnthropicStyleResponse> => {
        throw new Error("mocked anthropic error: overloaded");
      },
    });
  } catch {
    /* expected; failed call already recorded */
  }

  recorder
    .addFileChanged("src/lib/feature-a.ts")
    .addFileChanged("src/app/a/page.tsx")
    .addCommandRun("npm run lint")
    .addCommandRun("npm run build")
    .setBuildResult("pass")
    .setLintResult("pass")
    .addNote("Synthetic demo: Anthropic-style side of the wrapper comparison.");

  return recorder.finish({ endedAt: "2026-06-20T21:09:00Z" });
}

async function buildOpenAISession(): Promise<RecordedCodingSession> {
  const recorder = createRunLeakRecorder({
    runName: "Comparison — OpenAI-style run",
    objective: "OpenAI-style mocked run for the wrapper comparison proof.",
    source: "manual",
    startedAt: "2026-06-20T21:00:00Z",
  });

  // Explicit usage incl. total_tokens (preserved).
  await recordOpenAIStyleCall({
    recorder,
    id: "o-call-1",
    model: "gpt-demo",
    promptSummary: "Plan",
    costUsd: 0.05,
    call: async (): Promise<OpenAIStyleResponse> => ({
      id: "resp_1",
      model: "gpt-demo",
      usage: { input_tokens: 3200, output_tokens: 700, total_tokens: 3900 },
      output: "…plan…",
    }),
  });
  // Explicit input/output, total derived.
  await recordOpenAIStyleCall({
    recorder,
    id: "o-call-2",
    model: "gpt-demo",
    promptSummary: "Implement",
    costUsd: 0.08,
    call: async (): Promise<OpenAIStyleResponse> => ({
      id: "resp_2",
      model: "gpt-demo",
      usage: { input_tokens: 4600, output_tokens: 1200 },
      choices: ["…impl…"],
    }),
  });
  // Missing-usage call.
  await recordOpenAIStyleCall({
    recorder,
    id: "o-call-3",
    model: "gpt-demo",
    promptSummary: "Follow-up (no usage)",
    call: async (): Promise<OpenAIStyleResponse> => ({
      id: "resp_3",
      model: "gpt-demo",
      output: "…answer…",
    }),
  });
  // Failed call.
  try {
    await recordOpenAIStyleCall({
      recorder,
      id: "o-call-4",
      model: "gpt-demo",
      promptSummary: "Fails",
      call: async (): Promise<OpenAIStyleResponse> => {
        throw new Error("mocked openai error: timeout");
      },
    });
  } catch {
    /* expected; failed call already recorded */
  }

  recorder
    .addFileChanged("src/lib/feature-a.ts")
    .addFileChanged("src/app/a/page.tsx")
    .addCommandRun("npm run lint")
    .addCommandRun("npm run build")
    .setBuildResult("pass")
    .setLintResult("pass")
    .addNote("Synthetic demo: OpenAI-style side of the wrapper comparison.");

  return recorder.finish({ endedAt: "2026-06-20T21:09:00Z" });
}

async function main(): Promise<void> {
  const anthropicSession = await buildAnthropicSession();
  const openaiSession = await buildOpenAISession();

  write("examples/provider-wrapper-comparison.anthropic.recorded.example.json", anthropicSession);
  write("examples/provider-wrapper-comparison.openai.recorded.example.json", openaiSession);

  // Normalize both via the same adapter the CLI uses.
  const anthropicTrace = recordedSessionToNormalizedTrace(anthropicSession);
  const openaiTrace = recordedSessionToNormalizedTrace(openaiSession);

  write("examples/provider-wrapper-comparison.anthropic.normalized.example.json", anthropicTrace);
  write("examples/provider-wrapper-comparison.openai.normalized.example.json", openaiTrace);

  // Both provider shapes feed the SAME comparison engine.
  const report = compareNormalizedRuns({
    baseline: anthropicTrace,
    controlled: openaiTrace,
  });
  write("examples/provider-wrapper-comparison.report.json", report);

  console.log(
    JSON.stringify(
      {
        anthropic: {
          exact_model_calls: anthropicTrace.exact_model_calls,
          exact_token_count: anthropicTrace.exact_token_count,
          exact_cost_usd: anthropicTrace.exact_cost_usd,
          exact_energy_wh: anthropicTrace.exact_energy_wh,
          build: anthropicTrace.build_result,
          lint: anthropicTrace.lint_result,
        },
        openai: {
          exact_model_calls: openaiTrace.exact_model_calls,
          exact_token_count: openaiTrace.exact_token_count,
          exact_cost_usd: openaiTrace.exact_cost_usd,
          exact_energy_wh: openaiTrace.exact_energy_wh,
          build: openaiTrace.build_result,
          lint: openaiTrace.lint_result,
        },
        report_summary: report.summary,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
