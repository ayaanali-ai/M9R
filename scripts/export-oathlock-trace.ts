// OathLock trace exporter.
//
// Emits anonymized execution traces for a coding-agent session in the OathLock
// forensic format, in JSON and JSONL, for both repo root and the canonical
// fixture directory examples/sample-traces/.
//
// Outputs (8 files):
//   ./oathlock-trace.json | .jsonl                 clean run
//   ./oathlock-trace.messy.json | .messy.jsonl     messy run
//   examples/sample-traces/oathlock-clean-coding-agent.json | .jsonl
//   examples/sample-traces/oathlock-messy-coding-agent.json | .jsonl
//
// CLAIM DISCIPLINE (matches src/lib/trace-recorder-schema.ts):
//   - Fields not measured are `null` and listed in `missing_metadata`. We never
//     invent token counts, costs, or model names. The messy run reflects a
//     provider that reported NO usage, so its token/cost stay null throughout.
// ANONYMIZATION:
//   - No secrets, API keys, credentials, customer data, full file contents, or
//     sensitive env vars. Tool I/O is summarized, paths are repo-relative, and
//     the session id is a random opaque token.
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";

type Actor = "human" | "agent" | "tool" | "model";

type TraceStep = {
  step: number;
  timestamp: string | null;
  actor: Actor;
  model_name: string | null;
  tool_name: string | null;
  tool_input_summary: string | null;
  tool_output_summary: string | null;
  files_read: string[];
  files_written: string[];
  shell_commands: string[];
  errors: string[];
  retries: number;
  token_usage: { input: number; output: number; total: number } | null;
  estimated_cost_usd: number | null;
  missing_metadata: string[];
};

type Trace = {
  schema: "oathlock.trace.v0";
  variant: "clean" | "messy";
  provenance: string;
  session_id: string;
  task_summary: string;
  started_at: string;
  ended_at: string;
  actors_observed: Actor[];
  steps: TraceStep[];
  totals: {
    steps: number;
    failed_commands: number;
    retries: number;
    token_usage: { input: number; output: number; total: number } | null;
    estimated_cost_usd: number | null;
  };
  missing_metadata_global: string[];
  anonymization: { applied: boolean; notes: string[] };
};

const sid = () => "ol_sess_" + randomBytes(8).toString("hex");

const TASK =
  "Fix a timezone off-by-one bug in formatDueDate() and add a regression test.";

function clean(): Trace {
  const t0 = "2026-06-23T15:00:00Z";
  const steps: TraceStep[] = [
    {
      step: 1, timestamp: t0, actor: "human", model_name: null, tool_name: null,
      tool_input_summary: "Task: fix timezone off-by-one in formatDueDate(); add test.",
      tool_output_summary: null, files_read: [], files_written: [], shell_commands: [],
      errors: [], retries: 0, token_usage: null, estimated_cost_usd: null,
      missing_metadata: ["human_identity", "credential"],
    },
    {
      step: 2, timestamp: "2026-06-23T15:00:11Z", actor: "agent",
      model_name: "claude-sonnet-4-6", tool_name: "read_file",
      tool_input_summary: "Read src/lib/dates.ts (formatDueDate region only).",
      tool_output_summary: "~60 lines; formatDueDate uses local Date, drops UTC offset.",
      files_read: ["src/lib/dates.ts"], files_written: [], shell_commands: [],
      errors: [], retries: 0,
      token_usage: { input: 1840, output: 220, total: 2060 }, estimated_cost_usd: 0.0094,
      missing_metadata: [],
    },
    {
      step: 3, timestamp: "2026-06-23T15:00:25Z", actor: "agent",
      model_name: "claude-sonnet-4-6", tool_name: "edit_file",
      tool_input_summary: "Parse ISO date as UTC; format with explicit timeZone:'UTC'.",
      tool_output_summary: "Patched 1 hunk in formatDueDate().",
      files_read: [], files_written: ["src/lib/dates.ts"], shell_commands: [],
      errors: [], retries: 0,
      token_usage: { input: 2100, output: 380, total: 2480 }, estimated_cost_usd: 0.0121,
      missing_metadata: [],
    },
    {
      step: 4, timestamp: "2026-06-23T15:00:38Z", actor: "agent",
      model_name: "claude-sonnet-4-6", tool_name: "write_file",
      tool_input_summary: "Add dates.test.ts with a UTC boundary case (23:30+02:00).",
      tool_output_summary: "Created test file (1 case).",
      files_read: [], files_written: ["src/lib/dates.test.ts"], shell_commands: [],
      errors: [], retries: 0,
      token_usage: { input: 1500, output: 410, total: 1910 }, estimated_cost_usd: 0.0093,
      missing_metadata: [],
    },
    {
      step: 5, timestamp: "2026-06-23T15:00:52Z", actor: "tool", model_name: null,
      tool_name: "shell",
      tool_input_summary: "node --test src/lib/dates.test.ts",
      tool_output_summary: "FAIL 1/1: expected '2026-06-24' received '2026-06-23' (assertion).",
      files_read: [], files_written: [], shell_commands: ["node --test src/lib/dates.test.ts"],
      errors: ["AssertionError: expected '2026-06-24' to equal '2026-06-23'"],
      retries: 0, token_usage: null, estimated_cost_usd: null,
      missing_metadata: ["model_name (shell step has no model)"],
    },
    {
      step: 6, timestamp: "2026-06-23T15:01:09Z", actor: "agent",
      model_name: "claude-sonnet-4-6", tool_name: "edit_file",
      tool_input_summary: "Correction: test fixture used wrong expected day; fix expectation.",
      tool_output_summary: "Updated 1 assertion in dates.test.ts.",
      files_read: [], files_written: ["src/lib/dates.test.ts"], shell_commands: [],
      errors: [], retries: 0,
      token_usage: { input: 2240, output: 300, total: 2540 }, estimated_cost_usd: 0.0124,
      missing_metadata: [],
    },
    {
      step: 7, timestamp: "2026-06-23T15:01:20Z", actor: "tool", model_name: null,
      tool_name: "shell",
      tool_input_summary: "node --test src/lib/dates.test.ts",
      tool_output_summary: "PASS 1/1.",
      files_read: [], files_written: [], shell_commands: ["node --test src/lib/dates.test.ts"],
      errors: [], retries: 0, token_usage: null, estimated_cost_usd: null,
      missing_metadata: [],
    },
  ];
  return finalize("clean", sid(), t0, "2026-06-23T15:01:25Z", steps, [
    "human_identity not captured (no verified owner)",
    "credential chain not captured",
    "model receipts unsigned (model_name self-reported, not attested)",
  ]);
}

function messy(): Trace {
  const t0 = "2026-06-23T16:00:00Z";
  // Provider reported NO usage on this run, so token/cost stay null everywhere.
  const bigRead = (n: number): TraceStep => ({
    step: n, timestamp: `2026-06-23T16:0${n}:00Z`, actor: "agent",
    model_name: "claude-sonnet-4-6", tool_name: "read_file",
    tool_input_summary: "Re-read ENTIRE src/lib/dates.ts (full file, not a slice).",
    tool_output_summary: "~620 lines resent as full context (repeated block, unchanged).",
    files_read: ["src/lib/dates.ts"], files_written: [], shell_commands: [],
    errors: [], retries: 0,
    token_usage: null, estimated_cost_usd: null,
    missing_metadata: ["token_usage (provider reported no usage)", "estimated_cost_usd"],
  });
  const steps: TraceStep[] = [
    {
      step: 1, timestamp: t0, actor: "human", model_name: null, tool_name: null,
      tool_input_summary: "Task: fix timezone off-by-one in formatDueDate(); add test.",
      tool_output_summary: null, files_read: [], files_written: [], shell_commands: [],
      errors: [], retries: 0, token_usage: null, estimated_cost_usd: null,
      missing_metadata: ["human_identity", "credential"],
    },
    bigRead(2), bigRead(3), bigRead(4), // repeated context: same file re-read 3x
    {
      step: 5, timestamp: "2026-06-23T16:05:00Z", actor: "tool", model_name: null,
      tool_name: "shell",
      tool_input_summary: "cat build.log (dumped the full build log into context).",
      tool_output_summary:
        "BLOATED tool output: 48,200-char full build log dumped into context; <1% relevant. Truncated here.",
      files_read: ["build.log"], files_written: [], shell_commands: ["cat build.log"],
      errors: [], retries: 0, token_usage: null,
      estimated_cost_usd: null, missing_metadata: ["model_name (shell step)"],
    },
    {
      step: 6, timestamp: "2026-06-23T16:06:00Z", actor: "tool", model_name: null,
      tool_name: "shell",
      tool_input_summary: "npm run test:unit (wrong script name; package has none).",
      tool_output_summary: "FAIL: Missing script 'test:unit'. (attempt 1)",
      files_read: [], files_written: [], shell_commands: ["npm run test:unit"],
      errors: ["npm ERR! Missing script: test:unit"], retries: 0,
      token_usage: null, estimated_cost_usd: null, missing_metadata: ["model_name (shell step)"],
    },
    {
      step: 7, timestamp: "2026-06-23T16:06:40Z", actor: "tool", model_name: null,
      tool_name: "shell",
      tool_input_summary: "Retried the same command again with no new information.",
      tool_output_summary: "FAIL: Missing script 'test:unit'. (attempt 2 — same error)",
      files_read: [], files_written: [], shell_commands: ["npm run test:unit"],
      errors: ["npm ERR! Missing script: test:unit"], retries: 1,
      token_usage: null, estimated_cost_usd: null, missing_metadata: ["model_name (shell step)"],
    },
    {
      step: 8, timestamp: "2026-06-23T16:07:10Z", actor: "tool", model_name: null,
      tool_name: "shell",
      tool_input_summary: "Retried the same command a third time (retry spiral, same error).",
      tool_output_summary: "FAIL: Missing script 'test:unit'. (attempt 3 — kept retrying)",
      files_read: [], files_written: [], shell_commands: ["npm run test:unit"],
      errors: ["npm ERR! Missing script: test:unit"], retries: 2,
      token_usage: null, estimated_cost_usd: null, missing_metadata: ["model_name (shell step)"],
    },
    {
      step: 9, timestamp: "2026-06-23T16:08:00Z", actor: "agent",
      model_name: null, // model metadata dropped on this call
      tool_name: "edit_file",
      tool_input_summary: "Finally edit formatDueDate to parse as UTC.",
      tool_output_summary: "Patched 1 hunk.",
      files_read: [], files_written: ["src/lib/dates.ts"], shell_commands: [],
      errors: [], retries: 0,
      token_usage: null, estimated_cost_usd: null,
      missing_metadata: ["model_name", "token_usage", "estimated_cost_usd"],
    },
    {
      step: 10, timestamp: "2026-06-23T16:08:40Z", actor: "tool", model_name: null,
      tool_name: "shell",
      tool_input_summary: "node --test src/lib/dates.test.ts (correct command).",
      tool_output_summary: "PASS 1/1.",
      files_read: [], files_written: [], shell_commands: ["node --test src/lib/dates.test.ts"],
      errors: [], retries: 0, token_usage: null, estimated_cost_usd: null,
      missing_metadata: ["model_name (shell step)"],
    },
  ];
  return finalize("messy", sid(), t0, "2026-06-23T16:09:00Z", steps, [
    "human_identity not captured (no verified owner)",
    "credential chain not captured",
    "model receipts unsigned; model_name absent on step 9",
    "no token metadata: provider reported no usage; tokens and cost stay null",
    "policy enforcement record not present",
  ]);
}

function finalize(
  variant: Trace["variant"], session_id: string, started_at: string,
  ended_at: string, steps: TraceStep[], missing_global: string[],
): Trace {
  const withUsage = steps.filter((s) => s.token_usage);
  const totalsTokens = withUsage.length
    ? withUsage.reduce(
        (a, s) => ({
          input: a.input + s.token_usage!.input,
          output: a.output + s.token_usage!.output,
          total: a.total + s.token_usage!.total,
        }),
        { input: 0, output: 0, total: 0 },
      )
    : null;
  const costs = steps.map((s) => s.estimated_cost_usd).filter((c): c is number => c != null);
  const actors = [...new Set(steps.map((s) => s.actor))] as Actor[];
  return {
    schema: "oathlock.trace.v0",
    variant,
    provenance:
      "Representative anonymized coding-agent session. Token/cost values present only where a provider reported usage; all other fields are null and listed in missing_metadata.",
    session_id,
    task_summary: TASK,
    started_at,
    ended_at,
    actors_observed: actors,
    steps,
    totals: {
      steps: steps.length,
      failed_commands: steps.filter((s) => s.errors.length > 0).length,
      retries: steps.reduce((a, s) => a + s.retries, 0),
      token_usage: totalsTokens,
      estimated_cost_usd: costs.length ? Number(costs.reduce((a, b) => a + b, 0).toFixed(4)) : null,
    },
    missing_metadata_global: missing_global,
    anonymization: {
      applied: true,
      notes: [
        "No secrets, API keys, credentials, or env vars included.",
        "No full file contents — tool I/O is summarized.",
        "Paths are repo-relative; session_id is a random opaque token.",
      ],
    },
  };
}

function toJson(t: Trace): string {
  return JSON.stringify(t, null, 2) + "\n";
}

// JSONL: one event per line. Line 1 is a `meta` record; each subsequent line is
// a `step` record. Lossless round-trip with the JSON form.
function toJsonl(t: Trace): string {
  const meta = {
    record: "meta",
    schema: t.schema,
    variant: t.variant,
    provenance: t.provenance,
    session_id: t.session_id,
    task_summary: t.task_summary,
    started_at: t.started_at,
    ended_at: t.ended_at,
    actors_observed: t.actors_observed,
    totals: t.totals,
    missing_metadata_global: t.missing_metadata_global,
    anonymization: t.anonymization,
  };
  return (
    [JSON.stringify(meta), ...t.steps.map((s) => JSON.stringify({ record: "step", ...s }))].join(
      "\n",
    ) + "\n"
  );
}

function write(path: string, contents: string) {
  const p = resolve(process.cwd(), path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, contents, "utf8");
  return p;
}

function main() {
  const c = clean();
  const m = messy();
  const targets: Array<[string, Trace]> = [
    // repo root
    ["oathlock-trace.json", c],
    ["oathlock-trace.jsonl", c],
    ["oathlock-trace.messy.json", m],
    ["oathlock-trace.messy.jsonl", m],
    // canonical fixtures
    ["examples/sample-traces/oathlock-clean-coding-agent.json", c],
    ["examples/sample-traces/oathlock-clean-coding-agent.jsonl", c],
    ["examples/sample-traces/oathlock-messy-coding-agent.json", m],
    ["examples/sample-traces/oathlock-messy-coding-agent.jsonl", m],
  ];
  for (const [path, trace] of targets) {
    const contents = path.endsWith(".jsonl") ? toJsonl(trace) : toJson(trace);
    const p = write(path, contents);
    console.log(`wrote ${p}`);
  }
  for (const t of [c, m]) {
    console.log(
      `[${t.variant}] steps=${t.totals.steps} failed=${t.totals.failed_commands} ` +
        `retries=${t.totals.retries} tokens=${t.totals.token_usage?.total ?? "null"} ` +
        `cost=${t.totals.estimated_cost_usd ?? "null"}`,
    );
  }
}

main();
