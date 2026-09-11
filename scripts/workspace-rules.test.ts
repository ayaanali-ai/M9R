/**
 * OathLock v5.1 — persistent workspace rules. Tests the pure promotion/dedupe
 * policy, workspace export behavior, and honesty guards. (DB/RLS behavior is
 * exercised via the pure planPromotion the service executes verbatim.)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { GeneratedRule } from "../src/lib/generated-rules.ts";
import type { WorkspaceRule } from "../src/lib/workspace-rule-matching.ts";
import { planPromotion, classifyForPromotion, rulesMatch } from "../src/lib/workspace-rule-matching.ts";
import { generateRulesFile } from "../src/lib/rules-file-generator.ts";

// --- Fixtures ---------------------------------------------------------------

function gen(partial: Partial<GeneratedRule> & Pick<GeneratedRule, "ruleType" | "body">): GeneratedRule {
  return {
    id: partial.id ?? `g_${Math.random().toString(36).slice(2)}`,
    title: partial.title ?? "Rule",
    body: partial.body,
    ruleType: partial.ruleType,
    confidence: partial.confidence ?? "high",
    evidenceSummary: partial.evidenceSummary ?? "observed in session",
    sourceFindingId: partial.sourceFindingId ?? null,
    expectedPrevention: partial.expectedPrevention ?? "may reduce X",
    createdAt: partial.createdAt ?? "2026-06-27",
    status: partial.status ?? "active",
  };
}

function ws(partial: Partial<WorkspaceRule> & Pick<WorkspaceRule, "ruleType" | "body" | "status">): WorkspaceRule {
  return {
    id: partial.id ?? `w_${Math.random().toString(36).slice(2)}`,
    workspaceId: "ws1",
    sourceReportId: null,
    sourceSessionName: null,
    title: partial.title ?? "Rule",
    body: partial.body,
    ruleType: partial.ruleType,
    confidence: partial.confidence ?? "medium",
    status: partial.status,
    evidenceSummary: partial.evidenceSummary ?? "prior evidence",
    sourceFindingId: null,
    expectedPrevention: "may reduce X",
    scopeCondition: partial.scopeCondition ?? null,
    createdAt: "2026-06-01",
    updatedAt: "2026-06-01",
    lastSeenAt: "2026-06-01",
    promotedAt: "2026-06-01",
    retiredAt: partial.retiredAt ?? null,
    timesSeen: partial.timesSeen ?? 1,
    timesExported: 0,
    timesHelped: 0,
    notes: partial.notes ?? null,
    createdBy: null,
  };
}

const RETRY_BODY =
  "After a command fails twice, do not rerun the same command unless inputs changed. Read the error first.";

// --- Matching ---------------------------------------------------------------

test("rulesMatch is behavior-based, not exact string", () => {
  const a = { ruleType: "retry_prevention" as const, body: RETRY_BODY };
  const b = { ruleType: "retry_prevention" as const, body: "Do not rerun the same failing command twice unless the inputs changed first." };
  assert.equal(rulesMatch(a, b), true, "reworded same-behavior rules should match");

  const c = { ruleType: "context_control" as const, body: "Read each file once per task." };
  assert.equal(rulesMatch(a, c), false, "different behaviors should not match");
});

// --- Promotion planning -----------------------------------------------------

test("new rule plans a create", () => {
  const actions = planPromotion([gen({ ruleType: "retry_prevention", body: RETRY_BODY })], []);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, "create");
});

test("similar active rule is updated, not duplicated", () => {
  const existing = [ws({ ruleType: "retry_prevention", body: RETRY_BODY, status: "active", timesSeen: 2 })];
  const actions = planPromotion([gen({ ruleType: "retry_prevention", body: RETRY_BODY, confidence: "high" })], existing);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, "update");
  if (actions[0].kind === "update") {
    assert.equal(actions[0].id, existing[0].id);
    assert.equal(actions[0].patch.timesSeen, 3, "times_seen increments");
  }
});

test("stronger evidence improves the stored summary on update", () => {
  const existing = [ws({ ruleType: "retry_prevention", body: RETRY_BODY, status: "active", confidence: "low" })];
  const actions = planPromotion(
    [gen({ ruleType: "retry_prevention", body: RETRY_BODY, confidence: "high", evidenceSummary: "stronger new evidence" })],
    existing,
  );
  assert.equal(actions[0].kind, "update");
  if (actions[0].kind === "update") assert.equal(actions[0].patch.evidenceSummary, "stronger new evidence");
});

test("retired rule reappearing is flagged needs_review, never auto-reactivated", () => {
  const existing = [ws({ ruleType: "retry_prevention", body: RETRY_BODY, status: "retired" })];
  const match = classifyForPromotion(gen({ ruleType: "retry_prevention", body: RETRY_BODY }), existing);
  assert.equal(match.status, "retired_reappeared");

  const actions = planPromotion([gen({ ruleType: "retry_prevention", body: RETRY_BODY })], existing);
  assert.equal(actions[0].kind, "flag_retired");
  if (actions[0].kind === "flag_retired") {
    assert.equal(actions[0].patch.status, "needs_review");
    assert.notEqual(actions[0].patch.status as string, "active");
    assert.match(actions[0].patch.notes, /reappeared/i);
  }
});

// --- Comparison action wiring ----------------------------------------------

test("workspace rule API routes comparison actions through named service helpers", () => {
  const route = readFileSync(resolve(process.cwd(), "src/app/api/workspace-rules/[id]/route.ts"), "utf8");
  assert.match(route, /markRuleHelped/);
  assert.match(route, /markRuleNeedsReview/);
  assert.match(route, /retireWorkspaceRule/);
  assert.match(route, /updateWorkspaceRuleText/);
});

// --- Rule lifecycle actions -------------------------------------------------

test("draft or archived rule can be soft-deleted through the workspace rule DELETE route", () => {
  const route = readFileSync(resolve(process.cwd(), "src/app/api/workspace-rules/[id]/route.ts"), "utf8");
  const svc = readFileSync(resolve(process.cwd(), "src/lib/workspace-rules-service.ts"), "utf8");
  assert.match(route, /export async function DELETE/);
  assert.match(route, /softDeleteWorkspaceRule\(id\)/);
  assert.match(svc, /export async function softDeleteWorkspaceRule/);
  assert.match(svc, /\["needs_review", "retired"\]\.includes\(sourceRule\.status\)/);
  assert.match(svc, /Only needs-review drafts and archived rules can be deleted\./);
  assert.match(svc, /deleted_at: now/);
  assert.ok(!/\.delete\(\)/.test(svc), "rule delete must be a soft delete");
});

test("active rule cannot be deleted by the soft-delete helper", () => {
  const svc = readFileSync(resolve(process.cwd(), "src/lib/workspace-rules-service.ts"), "utf8");
  const deleteFn = svc.slice(svc.indexOf("export async function softDeleteWorkspaceRule"), svc.indexOf("export async function archiveWorkspaceRule"));
  assert.match(deleteFn, /\["needs_review", "retired"\]\.includes\(sourceRule\.status\)/);
  assert.match(deleteFn, /DELETE_NOT_ALLOWED/);
  assert.ok(!/status:\s*"active"[\s\S]*deleted_at/.test(deleteFn), "active rules must not have a delete branch");
});

test("rule soft delete cannot remove run, session, or evidence history", () => {
  const svc = readFileSync(resolve(process.cwd(), "src/lib/workspace-rules-service.ts"), "utf8");
  const deleteFn = svc.slice(svc.indexOf("export async function softDeleteWorkspaceRule"), svc.indexOf("export async function archiveWorkspaceRule"));
  assert.ok(!/agent_runs|agent_sessions|agent_run_events|evidence/.test(deleteFn));
  assert.ok(!/\.delete\(/.test(deleteFn));
});

test("active rule can be archived through a dedicated route", () => {
  const route = readFileSync(resolve(process.cwd(), "src/app/api/workspace-rules/[id]/archive/route.ts"), "utf8");
  const svc = readFileSync(resolve(process.cwd(), "src/lib/workspace-rules-service.ts"), "utf8");
  assert.match(route, /archiveWorkspaceRule\(id\)/);
  assert.match(svc, /export async function archiveWorkspaceRule/);
  assert.match(svc, /sourceRule\.status !== "active"/);
  assert.match(svc, /status: "retired"/);
  assert.match(svc, /retired_at: now/);
});

test("archived rule is not returned by active rules fetch", () => {
  const svc = readFileSync(resolve(process.cwd(), "src/lib/agent-join-service.ts"), "utf8");
  const activeFetch = svc.slice(
    svc.indexOf("async function listActiveRulesForWorkspace"),
    svc.indexOf("/** List ACTIVE evidence-backed rules"),
  );
  assert.match(activeFetch, /\.from\("workspace_rules"\)[\s\S]*\.eq\("status", "active"\)/);
  assert.match(activeFetch, /\.is\("deleted_at", null\)/);
  assert.ok(!/retired/.test(activeFetch), "agent rules fetch must not include retired rules");
});

test("archived rule can be restored only to needs_review", () => {
  const route = readFileSync(resolve(process.cwd(), "src/app/api/workspace-rules/[id]/restore/route.ts"), "utf8");
  const svc = readFileSync(resolve(process.cwd(), "src/lib/workspace-rules-service.ts"), "utf8");
  const restoreFn = svc.slice(svc.indexOf("export async function restoreArchivedWorkspaceRule"), svc.indexOf("export async function promoteWorkspaceRule"));
  assert.match(route, /restoreArchivedWorkspaceRule\(id\)/);
  assert.match(restoreFn, /export async function restoreArchivedWorkspaceRule/);
  assert.match(restoreFn, /sourceRule\.status !== "retired"/);
  assert.match(restoreFn, /status: "needs_review"/);
  assert.ok(!/status:\s*"active"/.test(restoreFn), "restore must not activate a rule");
});

test("restored rule is not active until the existing promote path runs", () => {
  const promoteRoute = readFileSync(resolve(process.cwd(), "src/app/api/agent/rules/promote/route.ts"), "utf8");
  const svc = readFileSync(resolve(process.cwd(), "src/lib/workspace-rules-service.ts"), "utf8");
  assert.match(promoteRoute, /promoteWorkspaceRule\(ruleId\)/);
  assert.match(svc, /export async function promoteWorkspaceRule/);
  assert.match(svc, /sourceRule\.status !== "needs_review"/);
  assert.ok(!/updateWorkspaceRuleStatus\(ruleId, "active"\)/.test(promoteRoute), "promote route must not bypass review-state validation");
});

test("rule promotion writes a tamper-evident audit log entry -- the product's central human-decision moment must not go unrecorded", () => {
  const svc = readFileSync(resolve(process.cwd(), "src/lib/workspace-rules-service.ts"), "utf8");
  assert.match(svc, /import\s*\{\s*appendAuditLogEntry\s*\}\s*from\s*"@\/lib\/audit-log"/, "must import the shared audit-log helper");
  assert.match(svc, /action:\s*"rule_promoted"/, "must record a rule_promoted action");
  assert.match(svc, /actorKind:\s*"human"/, "promotion is a human decision, not an agent/system action");

  const promoteFn = svc.slice(
    svc.indexOf("export async function promoteWorkspaceRule("),
    svc.indexOf("export async function promoteWorkspaceRuleForAgentConnection"),
  );
  assert.match(promoteFn, /auditRulePromotion\(/, "promoteWorkspaceRule must call the audit helper before returning");

  const promoteForConnectionFn = svc.slice(svc.indexOf("export async function promoteWorkspaceRuleForAgentConnection"));
  const auditCallCount = (promoteForConnectionFn.match(/auditRulePromotion\(/g) ?? []).length;
  assert.ok(auditCallCount >= 3, "all three return paths in promoteWorkspaceRuleForAgentConnection (same-workspace update, cross-workspace update, cross-workspace insert) must audit");
});

test("draft and archived rules are excluded from npx oathlock rules", () => {
  const agentRules = readFileSync(resolve(process.cwd(), "src/lib/agent-join-service.ts"), "utf8");
  const cli = readFileSync(resolve(process.cwd(), "src/lib/oathlock-cli-core.ts"), "utf8");
  const activeFetch = agentRules.slice(
    agentRules.indexOf("async function listActiveRulesForWorkspace"),
    agentRules.indexOf("/** List ACTIVE evidence-backed rules"),
  );
  assert.match(agentRules, /\.eq\("status", "active"\)/);
  assert.match(cli, /\/api\/agent\/rules/);
  assert.ok(!/includeNeedsReview|needs_review|retired/.test(activeFetch));
});

test("rule lifecycle mutations stay owner-scoped through the cookie client and workspace_rules", () => {
  const svc = readFileSync(resolve(process.cwd(), "src/lib/workspace-rules-service.ts"), "utf8");
  for (const fn of [
    "softDeleteWorkspaceRule",
    "archiveWorkspaceRule",
    "restoreArchivedWorkspaceRule",
    "promoteWorkspaceRule",
    "updateWorkspaceRuleText",
  ]) {
    const start = svc.indexOf(`export async function ${fn}`);
    assert.ok(start > -1, `${fn} must exist`);
    const next = svc.indexOf("\nexport ", start + 1);
    const body = svc.slice(start, next === -1 ? undefined : next);
    assert.match(body, /requireUser\(\)/, `${fn} must use the signed-in user client`);
    assert.match(body, /\.from\("workspace_rules"\)/, `${fn} must use workspace_rules`);
    assert.ok(!/service_role|admin client|bypass/i.test(body), `${fn} must not bypass RLS`);
  }
});

test("PATCH edits title and body but cannot promote directly to active", () => {
  const route = readFileSync(resolve(process.cwd(), "src/app/api/workspace-rules/[id]/route.ts"), "utf8");
  const svc = readFileSync(resolve(process.cwd(), "src/lib/workspace-rules-service.ts"), "utf8");
  assert.match(route, /title\?: string/);
  assert.match(route, /updateWorkspaceRuleText\(id/);
  assert.match(route, /body\.status === "active"/);
  assert.match(route, /Use the promote route to activate a rule\./);
  assert.match(svc, /export async function updateWorkspaceRuleText/);
  assert.match(svc, /patch\.title = title\.trim\(\)/);
  assert.match(svc, /patch\.body = body\.trim\(\)/);
});

// --- Manual / import creation ----------------------------------------------

test("manual rule creation always stores a needs_review draft", () => {
  const svc = readFileSync(resolve(process.cwd(), "src/lib/workspace-rules-service.ts"), "utf8");
  const manualFn = svc.slice(svc.indexOf("export async function createManualWorkspaceRule"), svc.indexOf("export async function importWorkspaceRuleDrafts"));
  assert.match(manualFn, /\.from\("workspace_rules"\)/);
  assert.match(manualFn, /source_session_name: "manual"/);
  assert.match(manualFn, /status: "needs_review"/);
  assert.match(manualFn, /promoted_at: null/);
  assert.match(manualFn, /approvedBy: null/);
  assert.match(manualFn, /approvedAt: null/);
  assert.ok(!/status: active/.test(manualFn), "manual create must not branch into active");
  assert.ok(!/promoted_at: active/.test(manualFn), "manual create must not stamp promoted_at during creation");
});

test("imported AGENTS-style text creates reviewable workspace rule drafts", () => {
  const svc = readFileSync(resolve(process.cwd(), "src/lib/workspace-rules-service.ts"), "utf8");
  const parserFn = svc.slice(svc.indexOf("export function parseImportedRuleDrafts"), svc.indexOf("// ---------------------------------------------------------------------------\n// Manual / imported drafts"));
  const importFn = svc.slice(svc.indexOf("export async function importWorkspaceRuleDrafts"), svc.indexOf("// ---------------------------------------------------------------------------\n// Read"));
  assert.ok(parserFn.includes("parseImportedRuleDrafts"));
  assert.ok(parserFn.includes("replace(/^\\s*(?:[-*+]|\\d+[.)])\\s+/"));
  assert.match(importFn, /\.from\("workspace_rules"\)\.insert\(inserts\)\.select\(COLUMNS\)/);
  assert.match(importFn, /source_session_name: `import: \$\{sourceLabel\}`/);
  assert.match(importFn, /status: "needs_review"/);
  assert.match(importFn, /promoted_at: null/);
  assert.match(importFn, /approvedBy: null/);
  assert.match(importFn, /approvedAt: null/);
});

test("manual and imported rule drafts are redacted before storage", () => {
  const svc = readFileSync(resolve(process.cwd(), "src/lib/workspace-rules-service.ts"), "utf8");
  assert.match(svc, /import \{ redactSession/);
  assert.match(svc, /function redactForRuleStorage/);
  assert.match(svc, /const titleRedaction = redactForRuleStorage\(title\)/);
  assert.match(svc, /const bodyRedaction = redactForRuleStorage\(body\)/);
  assert.match(svc, /const redacted = redactForRuleStorage\(input\.text\)/);
  assert.match(svc, /redaction_summary/);
});

test("manual/import source metadata is stored with scope, risk, and approval fields", () => {
  const svc = readFileSync(resolve(process.cwd(), "src/lib/workspace-rules-service.ts"), "utf8");
  assert.match(svc, /source: ManualSource/);
  assert.match(svc, /approved_by: string \| null/);
  assert.match(svc, /approved_at: string \| null/);
  assert.match(svc, /risk_level: string \| null/);
  assert.match(svc, /path_patterns: string\[\]/);
  assert.match(svc, /notes: buildManualRuleNotes\(metadata\)/);
});

test("manual/import route handlers call the shared workspace rules service without active creation", () => {
  const manualRoute = readFileSync(resolve(process.cwd(), "src/app/api/agent/rules/manual/route.ts"), "utf8");
  const importRoute = readFileSync(resolve(process.cwd(), "src/app/api/agent/rules/import/route.ts"), "utf8");
  assert.match(manualRoute, /createManualWorkspaceRule/);
  assert.match(importRoute, /importWorkspaceRuleDrafts/);
  assert.match(importRoute, /source_label/);
  assert.ok(!/activate/.test(manualRoute), "manual route must ignore activate:true input");
  assert.ok(!/status:\s*"active"|promoted_at:\s*now/.test(`${manualRoute}\n${importRoute}`), "create/import routes must not support active creation");
  assert.ok(!/service_role|admin client|bypass/i.test(`${manualRoute}\n${importRoute}`));
});

test("manual/imported drafts are not returned by agent rules until promoted active", () => {
  const agentRules = readFileSync(resolve(process.cwd(), "src/lib/agent-join-service.ts"), "utf8");
  const promoteSvc = readFileSync(resolve(process.cwd(), "src/lib/workspace-rules-service.ts"), "utf8");
  assert.match(agentRules, /\.from\("workspace_rules"\)[\s\S]*\.eq\("status", "active"\)/);
  assert.match(promoteSvc, /if \(sourceRule\.workspace_id === targetWorkspaceId\)/);
  assert.match(promoteSvc, /\.update\(\{ status: "active", promoted_at: now, retired_at: null, updated_at: now \}\)/);
  assert.match(promoteSvc, /source_session_name: sourceRule\.source_session_name/);
  assert.match(promoteSvc, /notes: sourceRule\.workspace_id === targetWorkspaceId \? sourceRule\.notes : `Adopted from reviewed rule \$\{sourceRule\.id\}\.`/);
});

// --- Workspace export -------------------------------------------------------

const MIXED: GeneratedRule[] = [
  gen({ ruleType: "retry_prevention", body: RETRY_BODY, status: "active", title: "Retry" }),
  gen({ ruleType: "context_control", body: "Read each file once per task.", status: "needs_review", title: "Reads" }),
  gen({ ruleType: "edit_thrash_prevention", body: "Inspect the root cause before re-editing a file.", status: "retired", title: "Edits" }),
];

test("workspace export excludes retired and needs-review rules by default", () => {
  const file = generateRulesFile("agents", MIXED, { scope: "workspace", workspaceName: "Acme" });
  assert.match(file.content, /M9R Workspace Rules/);
  assert.match(file.content, /workspace: Acme/);
  assert.ok(file.content.includes(RETRY_BODY), "active rule present");
  assert.ok(!file.content.includes("Inspect the root cause"), "retired rule excluded");
  assert.ok(!file.content.includes("Read each file once"), "needs-review excluded by default");
  assert.match(file.content, /1 active rule/);
});

test("workspace export includes needs-review only when asked", () => {
  const file = generateRulesFile("agents", MIXED, { scope: "workspace", includeNeedsReview: true });
  assert.ok(file.content.includes("Read each file once"), "needs-review included when requested");
  assert.ok(!file.content.includes("Inspect the root cause"), "retired still excluded");
});

test("report-local (session) export still works and is titled per session", () => {
  const file = generateRulesFile("agents", MIXED, { scope: "session", sessionName: "run-1" });
  assert.match(file.content, /M9R Rules From This Session/);
  assert.match(file.content, /Source session: run-1/);
});

test("workspace exports carry no banned legacy language", () => {
  const banned = [/chain of custody/i, /cryptograph/i, /\bMTM\b/, /real-time supervision/i, /guaranteed/i];
  for (const fmt of ["agents", "claude", "cursor", "plain"] as const) {
    const file = generateRulesFile(fmt, MIXED, { scope: "workspace", includeNeedsReview: true });
    for (const re of banned) assert.ok(!re.test(file.content), `${fmt} export must not contain ${re}`);
  }
});

test("memory UI carries no banned legacy language", () => {
  const ui = readFileSync(resolve(process.cwd(), "src/components/product/MemoryView.tsx"), "utf8");
  const banned = [/chain of custody/i, /cryptograph/i, /\bMTM\b/, /model-to-model/i, /real-time supervision/i, /guaranteed/i];
  for (const re of banned) assert.ok(!re.test(ui), `memory UI must not contain ${re}`);
  // And it must carry the positioning: confirmed memory is what travels.
  assert.match(ui, /every agent carries it into the next run/i);
});

test("memory UI shows a discard path for drafts and archived items, never remembered ones", () => {
  const ui = readFileSync(resolve(process.cwd(), "src/components/product/MemoryView.tsx"), "utf8");
  const draftBlock = ui.slice(ui.indexOf('rule.status === "needs_review"'), ui.indexOf('rule.status === "active"'));
  const activeBlock = ui.slice(ui.indexOf('rule.status === "active"'), ui.indexOf('rule.status === "retired"'));
  const archivedBlock = ui.slice(ui.indexOf('rule.status === "retired"'), ui.indexOf('rule.status === "low_confidence"'));
  assert.match(draftBlock, /Discard/);
  assert.ok(!/Delete|Discard/.test(activeBlock), "remembered items must not show a delete action");
  assert.match(archivedBlock, /Delete/);
});

test("memory UI shows the stop-remembering action only for remembered items", () => {
  const ui = readFileSync(resolve(process.cwd(), "src/components/product/MemoryView.tsx"), "utf8");
  const draftBlock = ui.slice(ui.indexOf('rule.status === "needs_review"'), ui.indexOf('rule.status === "active"'));
  const activeBlock = ui.slice(ui.indexOf('rule.status === "active"'), ui.indexOf('rule.status === "retired"'));
  const archivedBlock = ui.slice(ui.indexOf('rule.status === "retired"'), ui.indexOf('rule.status === "low_confidence"'));
  assert.match(activeBlock, /Stop remembering/);
  assert.ok(!/Stop remembering/.test(draftBlock), "draft UI must not show the stop-remembering action");
  assert.ok(!/onArchive\(rule\.id/.test(archivedBlock), "archived items must not show the stop-remembering action");
});

test("memory UI shows Restore only for archived items", () => {
  const ui = readFileSync(resolve(process.cwd(), "src/components/product/MemoryView.tsx"), "utf8");
  const draftBlock = ui.slice(ui.indexOf('rule.status === "needs_review"'), ui.indexOf('rule.status === "active"'));
  const activeBlock = ui.slice(ui.indexOf('rule.status === "active"'), ui.indexOf('rule.status === "retired"'));
  const archivedBlock = ui.slice(ui.indexOf('rule.status === "retired"'), ui.indexOf('rule.status === "low_confidence"'));
  assert.match(archivedBlock, /Restore/);
  assert.ok(!/Restore/.test(activeBlock), "remembered items must not show Restore");
  assert.ok(!/Restore/.test(draftBlock), "draft UI must not show Restore");
  assert.ok(!/Activate/.test(ui), "archived items must not get a direct activate action");
});

test("memory destructive actions use the product confirmation dialog and preserve copy", () => {
  const ui = readFileSync(resolve(process.cwd(), "src/components/product/MemoryView.tsx"), "utf8");
  const dialog = readFileSync(resolve(process.cwd(), "src/components/product/ProductConfirmDialog.tsx"), "utf8");
  assert.match(ui, /ProductConfirmDialog/);
  assert.ok(!/window\.confirm\(|\bconfirm\(/.test(ui));
  assert.match(dialog, /role="dialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(ui, /It will not become part of what the team remembers\./);
  assert.match(ui, /Agents will no longer load it before a run\./);
  assert.match(ui, /It returns to review and must be confirmed again before agents load it\./);
  assert.match(ui, /It will be removed from product views\. Its audit history remains stored\./);
});

test("workspace lifecycle copy avoids banned overclaiming words", () => {
  const ui = readFileSync(resolve(process.cwd(), "src/components/product/MemoryView.tsx"), "utf8");
  const lifecycleCopy = [
    "DELETE_DRAFT_CONFIRM",
    "ARCHIVE_RULE_CONFIRM",
    "RESTORE_RULE_CONFIRM",
    "Discard",
    "Stop remembering",
    "Restore",
    "Remember this",
  ]
    .filter((needle) => ui.includes(needle))
    .join("\n");
  assert.ok(!/\b(proved|guaranteed|caused|fixed|prevented|worked)\b/i.test(lifecycleCopy));
});

test("export setup copy explains each supported rules artifact", () => {
  const workspaceUi = readFileSync(resolve(process.cwd(), "src/components/product/MemoryView.tsx"), "utf8");
  assert.match(workspaceUi, /AGENTS\.md.*agent-compatible project instructions/i);
  assert.match(workspaceUi, /CLAUDE\.md.*Claude project memory/i);
  assert.match(workspaceUi, /Cursor rule.*Cursor project rules/i);
  assert.match(workspaceUi, /Copy (instruction )?block.*past(e|ing) directly/i);
  assert.match(workspaceUi, /every agent carries it into the next run/i);
});

test("migration guidance doc exists and references supabase-workspace-rules.sql", () => {
  const doc = readFileSync(resolve(process.cwd(), "docs/migrations/workspace-rules-v5.1.md"), "utf8");
  assert.match(doc, /supabase-workspace-rules\.sql/);
  assert.match(doc, /Supabase SQL editor/i);
  assert.match(doc, /workspace_rules/);
  assert.match(doc, /Do not modify or relax/i);
  assert.match(doc, /migration-required|migration required/i);
  assert.match(doc, /information_schema\.tables/);

  const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf8");
  assert.match(readme, /docs\/migrations\/workspace-rules-v5\.1\.md/);
});

test("production smoke test doc covers the full v5.1 loop", () => {
  const doc = readFileSync(resolve(process.cwd(), "docs/proof/v5.1-production-smoke-test.md"), "utf8");
  for (const phrase of [
    "open homepage",
    "Analyze agent session",
    "Generate Blackbox Report",
    "3+ specific rules",
    "promote selected rules to workspace",
    "promoted rules persist after refresh",
    "retired rule is excluded",
    "Export CLAUDE.md",
    "Export Cursor rule",
    "mark related rule as helped / needs review / retired",
    "unauthenticated users are gated",
  ]) {
    assert.match(doc, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});

test("before-after proof template keeps claims conservative", () => {
  const doc = readFileSync(resolve(process.cwd(), "docs/proof/v5.1-before-after-proof-template.md"), "utf8");
  for (const phrase of [
    "Original session name/date",
    "Agent used",
    "Task attempted",
    "Observed repeat patterns",
    "Rules generated",
    "Rules exported to which format",
    "Follow-up session name/date",
    "Metrics before/after",
    "What improved",
    "What worsened",
    "What was inconclusive",
    "Which rules were kept/rewritten/retired",
    "Evidence limitations",
  ]) {
    assert.match(doc, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  assert.match(doc, /Do not claim causation unless the evidence directly proves it/i);
});
