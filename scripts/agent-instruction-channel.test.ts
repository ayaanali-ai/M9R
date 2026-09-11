/**
 * Agent Instruction Channel v0 tests.
 * ----------------------------------------------------------------------------
 * Covers the pull-based product contract without DB/network calls.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  MAX_AGENT_INSTRUCTION_LENGTH,
  agentCanReadInstructions,
  sanitizeInstructionText,
} from "../src/lib/agent-instruction-channel-core.ts";

const WORKSPACE_PATH = "src/components/product/AgentWorkspaceClient.tsx";
// AgentWorkspaceClient.tsx was split into src/components/product/agent-workspace/*
// with the orchestrator left in the original file. `read(WORKSPACE_PATH)`
// transparently returns the concatenation of the orchestrator plus every
// split file, so assertions below keep checking the same source text
// regardless of which file it now lives in -- same multi-file-read pattern
// as scripts/workspace-rules.test.ts.
const WORKSPACE_SPLIT_FILES = [
  WORKSPACE_PATH,
  "src/components/product/agent-workspace/shared.tsx",
  "src/components/product/agent-workspace/strip-board.tsx",
  "src/components/product/agent-workspace/run-panels.tsx",
  "src/components/product/agent-workspace/preflight.tsx",
  "src/components/product/agent-workspace/approval-center.tsx",
  "src/components/product/agent-workspace/handoff.tsx",
];

function read(path: string): string {
  if (path === WORKSPACE_PATH) {
    return WORKSPACE_SPLIT_FILES.map((f) => readFileSync(resolve(process.cwd(), f), "utf8")).join("\n");
  }
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

test("instruction text is short, plain, and secret-redacted", () => {
  const raw = `Read the lint output first.
Bearer oak_supersecretvalue1234
api_key=sk-live-secret
<script>alert(1)</script>`;

  const clean = sanitizeInstructionText(raw);

  assert.ok(clean.length <= MAX_AGENT_INSTRUCTION_LENGTH);
  assert.ok(!clean.includes("oak_supersecretvalue1234"));
  assert.ok(!clean.includes("sk-live-secret"));
  assert.ok(!/<script/i.test(clean));
  assert.match(clean, /Bearer \[redacted\]/);
  assert.match(clean, /api_key=\[redacted\]/);
});

test("inbox read scope accepts new and existing connected-agent tokens", () => {
  assert.equal(agentCanReadInstructions(["instructions:read"]), true);
  assert.equal(agentCanReadInstructions(["rules:read"]), true);
  assert.equal(agentCanReadInstructions(["session:submit"]), false);
  assert.equal(agentCanReadInstructions([]), false);
});

test("API route is dashboard-send and agent-pull, preserving audit history", () => {
  const route = read("src/app/api/agent/inbox/route.ts");
  const service = read("src/lib/agent-instruction-channel-service.ts");
  const sql = read("supabase-agent-instructions.sql");

  assert.match(route, /export async function GET/);
  assert.match(route, /export async function POST/);
  assert.match(route, /pullInstructionsForAgent/);
  assert.match(route, /createInstructionForDashboard/);
  assert.match(route, /Agent inbox/);
  assert.match(route, /Instruction channel/);

  assert.match(service, /status: "pulled"/);
  assert.match(service, /pulled_at/);
  assert.ok(!/\.delete\(|DELETE FROM/i.test(service), "pulling instructions must not delete rows");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS agent_instructions/);
  assert.match(sql, /CHECK \(status IN \('queued', 'pulled'\)\)/);
  assert.match(sql, /audit history remains intact/);
  assert.ok(!/FOR DELETE/i.test(sql), "schema must not add a delete policy for instruction history");
});

test("dashboard and CLI copy use the v0 wording", () => {
  const dashboard = read("src/components/product/AgentWorkspaceClient.tsx");
  const handoff = read("src/lib/run-handoff-service.ts");
  const cli = read("src/lib/oathlock-cli-core.ts");
  const docs = read("cli/README.md");

  for (const file of [dashboard, handoff, cli, docs]) {
    assert.ok(!/remote control/i.test(file));
    assert.ok(!/force the agent/i.test(file));
    assert.ok(!/guarantee compliance/i.test(file));
    assert.ok(!/proof of correctness/i.test(file));
    assert.ok(!/AI code review/i.test(file));
  }

  assert.match(dashboard, /Send instruction to agent/);
  assert.match(dashboard, /Agent inbox/);
  assert.match(dashboard, /Instruction channel/);
  assert.match(dashboard, /Pull instructions with the CLI/);
  assert.match(dashboard, /\/api\/agent\/inbox/);

  assert.match(handoff, /npx --yes m9r-cli@latest inbox/);
  assert.match(cli, /case "inbox"/);
  assert.match(cli, /\/api\/agent\/inbox/);
  assert.match(docs, /Pull instructions with the CLI/);
});
