// Bundled, anonymized sample traces for the self-serve /trace-audit demo.
//
// HONESTY DISCIPLINE: These are synthetic, redacted sample traces shipped with
// the app so a visitor can run the in-browser analyzer without uploading their
// own data. They are illustrative, not real production runs. Each one is shaped
// like a real export so it exercises the normalizer + detectors honestly.

export type DemoSampleTrace = {
  id: string;
  label: string;
  description: string;
  /** The raw object the analyzer receives, as if uploaded. */
  data: unknown;
};

// 1. M9R native sample (oathlock.trace.v0) — messy run with usage metadata.
const oathlockSample = {
  schema: "oathlock.trace.v0",
  variant: "messy",
  provenance: "Synthetic anonymized M9R sample trace.",
  session_id: "ol_sample_demo",
  task_summary: "Fix a timezone off-by-one bug in formatDueDate() and add a test.",
  started_at: "2026-06-23T16:00:00Z",
  ended_at: "2026-06-23T16:09:00Z",
  actors_observed: ["human", "agent", "tool"],
  steps: [
    {
      step: 1, timestamp: "2026-06-23T16:00:00Z", actor: "human", model_name: null,
      tool_name: null, tool_input_summary: "Task: fix timezone off-by-one; add test.",
      tool_output_summary: null, files_read: [], files_written: [], shell_commands: [],
      errors: [], retries: 0, token_usage: null, estimated_cost_usd: null, missing_metadata: [],
    },
    {
      step: 2, timestamp: "2026-06-23T16:02:00Z", actor: "agent", model_name: "claude-sonnet-4-6",
      tool_name: "read_file", tool_input_summary: "Re-read ENTIRE src/lib/dates.ts (full file).",
      tool_output_summary: "~620 lines resent as full context (repeated block, unchanged).",
      files_read: ["src/lib/dates.ts"], files_written: [], shell_commands: [], errors: [],
      retries: 0, token_usage: { input: 8200, output: 240, total: 8440 }, estimated_cost_usd: 0.026, missing_metadata: [],
    },
    {
      step: 3, timestamp: "2026-06-23T16:03:30Z", actor: "agent", model_name: "claude-sonnet-4-6",
      tool_name: "read_file", tool_input_summary: "Re-read ENTIRE src/lib/dates.ts AGAIN (unchanged).",
      tool_output_summary: "~620 lines resent again (repeated block, unchanged).",
      files_read: ["src/lib/dates.ts"], files_written: [], shell_commands: [], errors: [],
      retries: 0, token_usage: { input: 8200, output: 180, total: 8380 }, estimated_cost_usd: 0.026, missing_metadata: [],
    },
    {
      step: 4, timestamp: "2026-06-23T16:05:00Z", actor: "agent", model_name: "claude-sonnet-4-6",
      tool_name: "shell", tool_input_summary: "npm run build", tool_output_summary: "Full build log dumped into context (entire log, ~1,400 lines).",
      files_read: [], files_written: ["src/lib/dates.ts"], shell_commands: ["npm run build"],
      errors: ["TS2345: Argument of type 'string' is not assignable"], retries: 1,
      token_usage: { input: 9100, output: 320, total: 9420 }, estimated_cost_usd: 0.03, missing_metadata: [],
    },
    {
      step: 5, timestamp: "2026-06-23T16:07:00Z", actor: "agent", model_name: "claude-sonnet-4-6",
      tool_name: "shell", tool_input_summary: "npm run build", tool_output_summary: "Same failure again.",
      files_read: [], files_written: [], shell_commands: ["npm run build"],
      errors: ["TS2345: Argument of type 'string' is not assignable"], retries: 1,
      token_usage: { input: 9100, output: 300, total: 9400 }, estimated_cost_usd: 0.03, missing_metadata: [],
    },
  ],
  // Totals are the exact sum of per-step usage:
  //   input  = 8200 + 8200 + 9100 + 9100 = 34600
  //   output =  240 +  180 +  320 +  300 =  1040
  //   total  = 8440 + 8380 + 9420 + 9400 = 35640  (== 34600 + 1040)
  //   cost   = 0.026 + 0.026 + 0.03 + 0.03 = 0.112
  totals: {
    steps: 5, failed_commands: 2, retries: 2,
    token_usage: { input: 34600, output: 1040, total: 35640 }, estimated_cost_usd: 0.112,
  },
  missing_metadata_global: [],
  anonymization: { applied: true, notes: ["paths kept generic"] },
};

// 2. Generic coding-agent trace — no usage metadata, retry spiral.
const genericCodingAgent = {
  task: "Add a retry wrapper around the payments client",
  session_id: "generic-001",
  steps: [
    { actor: "user", content: "Add a retry wrapper around the payments client." },
    { tool: "read_file", path: "src/payments/client.ts" },
    { tool: "edit_file", path: "src/payments/client.ts" },
    { tool: "shell", command: "npm run build", status: "fail", error: "Cannot find name 'backoff'." },
    { tool: "read_file", path: "src/payments/client.ts" },
    { tool: "shell", command: "npm run build", status: "fail", error: "Cannot find name 'backoff'." },
    { tool: "shell", command: "npm run build", status: "fail", error: "Cannot find name 'backoff'." },
    { tool: "read_file", path: "src/payments/client.ts" },
  ],
};

// 3. Claude Code-style trace — tool_use entries, no usage, bloated grep output.
const claudeCodeStyle = {
  type: "claude-code",
  title: "Investigate flaky checkout test",
  messages: [
    { role: "user", content: "The checkout test is flaky, find out why." },
    { role: "assistant", tool: "Grep", input: "pattern=checkout", output: "84KB of matches pasted back into context (entire repo grep dump)." },
    { role: "assistant", tool: "Read", file_path: "src/checkout/cart.ts" },
    { role: "assistant", tool: "Read", file_path: "src/checkout/cart.ts" },
    { role: "assistant", tool: "Bash", command: "npm test -- checkout", error: "1 failing: timeout exceeded" },
    { role: "assistant", tool: "Bash", command: "npm test -- checkout", error: "1 failing: timeout exceeded" },
  ],
};

// 4. Codex / OTel GenAI-style spans — has usage metadata; clean-ish run.
const otelStyle = {
  task: "Rename a config flag across the service",
  spans: [
    {
      span_name: "chat.completion", attributes: { "gen_ai.request.model": "gpt-5-codex" },
      usage: { input_tokens: 4200, output_tokens: 800 },
    },
    {
      span_name: "tool.read_file", file_path: "src/config/flags.ts",
      attributes: { "gen_ai.request.model": "gpt-5-codex" }, usage: { input_tokens: 1200, output_tokens: 60 },
    },
    {
      span_name: "tool.read_file", file_path: "src/config/flags.ts",
      attributes: { "gen_ai.request.model": "gpt-5-codex" }, usage: { input_tokens: 1200, output_tokens: 60 },
    },
    {
      span_name: "tool.shell", command: "npm run lint", status: "ok",
      usage: { input_tokens: 900, output_tokens: 40 },
    },
  ],
};

export const DEMO_SAMPLE_TRACES: DemoSampleTrace[] = [
  {
    id: "oathlock",
    label: "M9R sample trace",
    description: "Native oathlock.trace.v0 with usage metadata — repeated reads + retry spiral.",
    data: oathlockSample,
  },
  {
    id: "generic",
    label: "Generic coding-agent trace",
    description: "Plain steps array, no usage metadata — build-fix retry spiral.",
    data: genericCodingAgent,
  },
  {
    id: "claude-code",
    label: "Claude Code-style trace",
    description: "Tool-use messages with a bloated grep dump and repeated reads.",
    data: claudeCodeStyle,
  },
  {
    id: "otel",
    label: "Codex / OTel-style trace",
    description: "GenAI spans with token usage — mostly clean, one repeated read.",
    data: otelStyle,
  },
];
