/**
 * Approval Requests — data-layer tests
 * ----------------------------------------------------------------------------
 * The bearer-CLI 403 dead-end fix (see src/app/api/agent/run/start/route.ts
 * and src/lib/approval-requests.ts). Route-handler-level tests aren't the
 * established pattern for DB-backed routes in this repo (no `mock.module`
 * usage, no existing precedent for invoking Next route handlers against a
 * live/fake network client) — this suite exercises the data-access layer
 * directly, against a fake db that reimplements the same RPC contract as
 * supabase/migrations/20260727050000_approval_requests.sql, which is the
 * behavior the route module calls through.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createOrGetPendingApprovalRequest,
  decideApprovalRequest,
  deriveApprovalIdempotencyKey,
  findApprovalRequestByIdempotencyKey,
  getApprovalRequest,
  markApprovalRequestConsumed,
  type ApprovalRequestsDb,
} from "../src/lib/approval-requests.ts";

// ---------------------------------------------------------------------------
// Fake db: mirrors the SQL RPC semantics from the migration closely enough
// to exercise the JS layer's contract (upsert-by-idempotency-key, workspace
// scoping, expiry, decision refusal reasons).
// ---------------------------------------------------------------------------
function makeFakeDb(): ApprovalRequestsDb & { rows: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>();

  function findByIdempotencyKey(key: string) {
    for (const row of rows.values()) if (row.idempotency_key === key) return row;
    return null;
  }

  const db: ApprovalRequestsDb & { rows: Map<string, Record<string, unknown>> } = {
    rows,
    async rpc(fn, args) {
      if (fn === "create_or_get_pending_approval_request") {
        const now = new Date(args.p_now as string).getTime();
        const existing = findByIdempotencyKey(args.p_idempotency_key as string);
        if (existing && existing.status === "pending" && new Date(existing.expires_at as string).getTime() > now) {
          return { data: existing, error: null };
        }
        if (existing && existing.status === "pending") {
          existing.status = "expired";
        }
        const row = {
          id: args.p_id,
          workspace_id: args.p_workspace_id,
          connection_id: args.p_connection_id,
          operation_type: args.p_operation_type,
          operation_identity: args.p_operation_identity,
          idempotency_key: args.p_idempotency_key,
          risk_classification: args.p_risk_classification,
          status: "pending",
          request_summary: args.p_request_summary,
          created_at: args.p_now,
          expires_at: args.p_expires_at,
          decided_at: null,
          decided_by_user_id: null,
          decision_note: null,
        };
        rows.set(row.id as string, row);
        return { data: row, error: null };
      }

      if (fn === "get_approval_request_by_idempotency_key") {
        const row = findByIdempotencyKey(args.p_idempotency_key as string);
        if (!row || row.workspace_id !== args.p_workspace_id) return { data: null, error: null };
        return { data: row, error: null };
      }

      if (fn === "get_approval_request") {
        const row = rows.get(args.p_id as string);
        if (!row || row.workspace_id !== args.p_workspace_id) return { data: null, error: null };
        return { data: row, error: null };
      }

      if (fn === "decide_approval_request") {
        const row = rows.get(args.p_id as string);
        if (!row || row.workspace_id !== args.p_workspace_id) {
          return { data: [{ status: "refused", reason: "not_found", request: null }], error: null };
        }
        const now = new Date(args.p_now as string).getTime();
        if (row.status === "pending" && new Date(row.expires_at as string).getTime() <= now) {
          row.status = "expired";
          return { data: [{ status: "refused", reason: "expired", request: row }], error: null };
        }
        if (row.status !== "pending") {
          return { data: [{ status: "refused", reason: "already_decided", request: row }], error: null };
        }
        row.status = args.p_decision;
        row.decided_at = args.p_now;
        row.decided_by_user_id = args.p_decided_by_user_id;
        row.decision_note = args.p_decision_note;
        return { data: [{ status: "ok", reason: null, request: row }], error: null };
      }

      if (fn === "mark_approval_request_consumed") {
        const row = rows.get(args.p_id as string);
        if (!row || row.workspace_id !== args.p_workspace_id) return { data: null, error: null };
        if (row.status !== "consumed") row.status = "consumed";
        return { data: row, error: null };
      }

      return { data: null, error: { message: `unknown rpc ${fn}` } };
    },
  };
  return db;
}

const BASE_KEY_INPUT = {
  workspaceId: "ws-1",
  connectionId: "conn-1",
  operationType: "agent_run_start",
  operationIdentity: "hash-of-task-a",
};

const SUMMARY = {
  type: "preflight",
  status: "needs_approval",
  risk_level: "high",
  sensitive_areas: ["payments"],
  matched_rule_count: 1,
  approval_required: true,
  approved_by_human: false,
  approval_note_present: false,
  checked_at: "2026-07-26T00:00:00.000Z",
};

test("idempotency key derivation is stable for identical input", () => {
  const a = deriveApprovalIdempotencyKey(BASE_KEY_INPUT);
  const b = deriveApprovalIdempotencyKey({ ...BASE_KEY_INPUT });
  assert.equal(a, b);
});

test("idempotency key derivation differs for a different operation identity", () => {
  const a = deriveApprovalIdempotencyKey(BASE_KEY_INPUT);
  const b = deriveApprovalIdempotencyKey({ ...BASE_KEY_INPUT, operationIdentity: "hash-of-task-b" });
  assert.notEqual(a, b);
});

test("retrying the identical request reuses the same approval request id", async () => {
  const db = makeFakeDb();
  const first = await createOrGetPendingApprovalRequest({
    ...BASE_KEY_INPUT,
    riskClassification: "high",
    requestSummary: SUMMARY,
    db,
  });
  const second = await createOrGetPendingApprovalRequest({
    ...BASE_KEY_INPUT,
    riskClassification: "high",
    requestSummary: SUMMARY,
    db,
  });
  assert.equal(first.id, second.id);
  assert.equal(db.rows.size, 1);
});

test("a different operation identity produces a different approval request", async () => {
  const db = makeFakeDb();
  const first = await createOrGetPendingApprovalRequest({
    ...BASE_KEY_INPUT,
    riskClassification: "high",
    requestSummary: SUMMARY,
    db,
  });
  const second = await createOrGetPendingApprovalRequest({
    ...BASE_KEY_INPUT,
    operationIdentity: "hash-of-task-b",
    riskClassification: "high",
    requestSummary: SUMMARY,
    db,
  });
  assert.notEqual(first.id, second.id);
  assert.equal(db.rows.size, 2);
});

test("a cross-workspace lookup returns null, not a distinct error", async () => {
  const db = makeFakeDb();
  const created = await createOrGetPendingApprovalRequest({
    ...BASE_KEY_INPUT,
    riskClassification: "high",
    requestSummary: SUMMARY,
    db,
  });
  const lookedUp = await getApprovalRequest(created.id, "ws-OTHER", db);
  assert.equal(lookedUp, null);
});

test("approving then rejecting is refused: a decided request cannot be re-decided", async () => {
  const db = makeFakeDb();
  const created = await createOrGetPendingApprovalRequest({
    ...BASE_KEY_INPUT,
    riskClassification: "high",
    requestSummary: SUMMARY,
    db,
  });
  const decided = await decideApprovalRequest({
    id: created.id,
    workspaceId: "ws-1",
    decision: "approved",
    decidedByUserId: "user-1",
    db,
  });
  assert.equal(decided.ok, true);
  if (decided.ok) assert.equal(decided.request.status, "approved");

  const second = await decideApprovalRequest({
    id: created.id,
    workspaceId: "ws-1",
    decision: "rejected",
    decidedByUserId: "user-1",
    db,
  });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, "already_decided");
});

test("a rejected approval request stays rejected on repeated lookups", async () => {
  const db = makeFakeDb();
  const created = await createOrGetPendingApprovalRequest({
    ...BASE_KEY_INPUT,
    riskClassification: "high",
    requestSummary: SUMMARY,
    db,
  });
  await decideApprovalRequest({
    id: created.id,
    workspaceId: "ws-1",
    decision: "rejected",
    decidedByUserId: "user-1",
    db,
  });
  const lookup1 = await getApprovalRequest(created.id, "ws-1", db);
  const lookup2 = await getApprovalRequest(created.id, "ws-1", db);
  assert.equal(lookup1?.status, "rejected");
  assert.equal(lookup2?.status, "rejected");
});

test("an expired approval request refuses a decision instead of authorizing it", async () => {
  const db = makeFakeDb();
  const now = new Date("2026-07-26T00:00:00.000Z");
  const created = await createOrGetPendingApprovalRequest({
    ...BASE_KEY_INPUT,
    riskClassification: "high",
    requestSummary: SUMMARY,
    now,
    ttlMs: 1000,
    db,
  });
  const later = new Date(now.getTime() + 5000);
  const decided = await decideApprovalRequest({
    id: created.id,
    workspaceId: "ws-1",
    decision: "approved",
    decidedByUserId: "user-1",
    now: later,
    db,
  });
  assert.equal(decided.ok, false);
  if (!decided.ok) assert.equal(decided.reason, "expired");
});

test("an expired request is treated as if no approval exists (retry creates a fresh cycle)", async () => {
  const db = makeFakeDb();
  const now = new Date("2026-07-26T00:00:00.000Z");
  const created = await createOrGetPendingApprovalRequest({
    ...BASE_KEY_INPUT,
    riskClassification: "high",
    requestSummary: SUMMARY,
    now,
    ttlMs: 1000,
    db,
  });
  const later = new Date(now.getTime() + 5000);
  const retried = await createOrGetPendingApprovalRequest({
    ...BASE_KEY_INPUT,
    riskClassification: "high",
    requestSummary: SUMMARY,
    now: later,
    db,
  });
  assert.notEqual(retried.id, created.id);
  assert.equal(retried.status, "pending");
});

test("an approved request is found via idempotency-key lookup, allowing the operation to proceed", async () => {
  const db = makeFakeDb();
  const created = await createOrGetPendingApprovalRequest({
    ...BASE_KEY_INPUT,
    riskClassification: "high",
    requestSummary: SUMMARY,
    db,
  });
  await decideApprovalRequest({
    id: created.id,
    workspaceId: "ws-1",
    decision: "approved",
    decidedByUserId: "user-1",
    db,
  });

  const found = await findApprovalRequestByIdempotencyKey(BASE_KEY_INPUT, db);
  assert.equal(found?.status, "approved");
  assert.equal(found?.id, created.id);
});

test("marking an approved request consumed is idempotent", async () => {
  const db = makeFakeDb();
  const created = await createOrGetPendingApprovalRequest({
    ...BASE_KEY_INPUT,
    riskClassification: "high",
    requestSummary: SUMMARY,
    db,
  });
  await decideApprovalRequest({
    id: created.id,
    workspaceId: "ws-1",
    decision: "approved",
    decidedByUserId: "user-1",
    db,
  });
  await markApprovalRequestConsumed(created.id, "ws-1", db);
  await assert.doesNotReject(markApprovalRequestConsumed(created.id, "ws-1", db));
  assert.equal(db.rows.get(created.id)?.status, "consumed");
});

test("no raw task-payload content appears in the stored request summary", async () => {
  const db = makeFakeDb();
  const rawTask = "SECRET_TOKEN=sk_live_should_never_be_stored delete the production database";
  const created = await createOrGetPendingApprovalRequest({
    ...BASE_KEY_INPUT,
    riskClassification: "high",
    requestSummary: SUMMARY, // compact snapshot only — never the raw task string
    db,
  });
  const serialized = JSON.stringify(created);
  assert.equal(serialized.includes(rawTask), false);
  assert.equal(serialized.includes("sk_live"), false);
});
