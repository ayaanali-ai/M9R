import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/app/dashboard/approvals/[id]/page.tsx", "utf8");

/**
 * Was a raw serialized-JSON dump in a preformatted block -- the odd one out
 * in this product; Run Passport and Mission command center both route
 * structured data through real presentational components. requestSummary
 * is untyped (agent-preflight-service.ts's PreflightDecision written into
 * a Record<string, unknown>), so every field is read defensively here.
 */
test("the approval detail page no longer dumps raw JSON -- real fields, real fallbacks", () => {
  assert.doesNotMatch(source, /JSON\.stringify\(summary/);
  assert.doesNotMatch(source, /<pre\b/);
});

test("approval deep links resolve to the single inline decision surface", () => {
  assert.match(source, /getApprovalRequest\(id, workspaceId\)/);
  assert.match(source, /requestMessageId/);
  assert.match(source, /conversation_messages/);
  assert.match(source, /redirect\(`\/dashboard\/agents\?conversation=/);
  assert.doesNotMatch(source, /StatusLozenge|JSON\.stringify|<pre\b/);
});
