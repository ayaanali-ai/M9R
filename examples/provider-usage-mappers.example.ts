// Provider Usage Mappers example — builds a SYNTHETIC DEMO session with Recorder
// Lite, adding model calls via the OpenAI / Anthropic / generic mappers.
//
// SYNTHETIC DEMO DATA — not real customer data, not a real recording. Token
// counts and costs are illustrative demo values. No models are called; nothing
// is inferred or estimated.
//
// Usage: npm run example:provider-mappers
//   → writes examples/provider-usage-mappers.recorded.example.json
import { writeFileSync } from "node:fs";
import { createRecordedSession } from "@/lib/recorder-lite";
import {
  mapOpenAIUsageToModelCall,
  mapAnthropicUsageToModelCall,
  mapGenericUsageToModelCall,
} from "@/lib/provider-usage-mappers";

const session = createRecordedSession({
  runName: "Demo (provider mappers): mixed-provider session",
  objective: "Demonstrate mapping explicit OpenAI/Anthropic/generic usage into recorded calls.",
  source: "manual",
  startedAt: "2026-06-20T17:00:00Z",
})
  .addModelCall(
    mapOpenAIUsageToModelCall({
      id: "call-openai-1",
      model: "gpt-demo",
      usage: { input_tokens: 3200, output_tokens: 700, total_tokens: 3900 },
      costUsd: 0.04,
      latencyMs: 1800,
      promptSummary: "Plan with OpenAI-style usage",
      outputSummary: "Plan produced",
    }),
  )
  .addModelCall(
    mapAnthropicUsageToModelCall({
      id: "call-anthropic-1",
      model: "claude-demo",
      // Anthropic-style: input/output only; total derived (both explicit).
      usage: { input_tokens: 4100, output_tokens: 900 },
      costUsd: 0.08,
      latencyMs: 2600,
      promptSummary: "Implement with Anthropic-style usage",
      outputSummary: "Implementation produced",
    }),
  )
  .addModelCall(
    mapGenericUsageToModelCall({
      id: "call-generic-1",
      provider: "local",
      model: "local-demo",
      // Cost intentionally omitted — must stay null, never estimated.
      inputTokens: 2200,
      outputTokens: 400,
      latencyMs: 900,
      promptSummary: "Local runtime fix",
      outputSummary: "Adjusted output",
    }),
  )
  .addToolCall({ id: "tool-1", toolName: "read_file", latencyMs: 30, success: true, inputSummary: "src/lib/x.ts" })
  .addToolCall({ id: "tool-2", toolName: "run_command", latencyMs: 4200, success: true, inputSummary: "npm run build" })
  .addFileChanged("src/lib/x.ts")
  .addFileChanged("src/app/x/page.tsx")
  .addCommandRun("npm run lint")
  .addCommandRun("npm run build")
  .setBuildResult("pass")
  .setLintResult("pass")
  .addNote("Synthetic demo session built with Recorder Lite + provider usage mappers.")
  .addNote("Token counts and costs are illustrative demo values, not measured production usage.")
  .finish({ endedAt: "2026-06-20T17:12:00Z" });

const outPath = "examples/provider-usage-mappers.recorded.example.json";
writeFileSync(outPath, JSON.stringify(session, null, 2) + "\n");
console.error(`Wrote ${outPath}`);
console.log(JSON.stringify(session, null, 2));
