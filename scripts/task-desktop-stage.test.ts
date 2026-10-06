import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalStore } from "../src/lib/native/local-store";
import { createTaskDesktopStageService, readTaskStagePolicy, setTaskStagePermission } from "../src/lib/native/task-desktop-stage";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "m9r-task-stage-"));
  const store = createLocalStore(root);
  const identity = store.issueIdentity("codex", "codex", "session-one");
  const { task } = store.addTask({ from: "you", to: "codex", goal: "Use a stage", origin: "human_typed", idempotencyKey: "stage-one", targetSession: "session-one" });
  let creations = 0;
  const service = createTaskDesktopStageService({ store, readPolicy: () => ({ handles: ["codex"] }), stage: {
    platform: "win32", env: {}, invokeNative: async (request) => {
      if (request.op === "createDesktop") {
        creations++;
        return { ok: true, desktop: { desktopId: "11111111-1111-4111-8111-111111111111", isCurrent: false, returnDesktopId: "22222222-2222-4222-8222-222222222222" } };
      }
      if (request.op === "inspectDesktop") return { ok: true, desktop: { desktopId: String(request.desktopId), isCurrent: false } };
      throw new Error("Unexpected native operation; preparation must not move or activate windows.");
    },
  } });
  return { root, store, identity, task, service, creations: () => creations, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("approved task preparation is idempotent and does not expose desktop GUIDs", async () => {
  const f = fixture();
  try {
    const [a, b] = await Promise.all([f.service.prepare(f.identity.token, f.task.id), f.service.prepare(f.identity.token, f.task.id)]);
    assert.deepEqual(a, b);
    assert.equal(f.creations(), 1);
    assert.equal(JSON.stringify(a).includes("11111111-1111"), false);
    assert.equal(a.hasAnchor, false);
  } finally { f.cleanup(); }
});

test("revoked identities and different target sessions cannot provision stages", async () => {
  const f = fixture();
  try {
    const other = f.store.issueIdentity("codex", "codex", "session-two");
    await assert.rejects(f.service.prepare(other.token, f.task.id), /does not belong/);
    f.store.revokeIdentity("session-one");
    await assert.rejects(f.service.prepare(f.identity.token, f.task.id), /revoked/);
    assert.equal(f.creations(), 0);
  } finally { f.cleanup(); }
});

test("pending and finished tasks cannot provision stages", async () => {
  const f = fixture();
  try {
    const { task: pending } = f.store.addTask({ from: "claude", to: "codex", goal: "Pending", origin: "agent_initiated", idempotencyKey: "pending" });
    await assert.rejects(f.service.prepare(f.identity.token, pending.id), /approved, unfinished/);
    f.store.setResult(f.task.id, "Done");
    await assert.rejects(f.service.prepare(f.identity.token, f.task.id), /approved, unfinished/);
    assert.equal(f.creations(), 0);
  } finally { f.cleanup(); }
});

test("stage permission is separate from task approval and denied by default", async () => {
  const f = fixture();
  try {
    assert.deepEqual(readTaskStagePolicy(f.root), { handles: [] });
    const denied = createTaskDesktopStageService({ store: f.store, stage: { env: {}, platform: "win32" } });
    await assert.rejects(denied.prepare(f.identity.token, f.task.id), /has not enabled/);
    assert.throws(() => setTaskStagePermission(f.root, "codex", true, { terminal: true, env: { CODEX_THREAD_ID: "agent" } }), /Only the owner/);
    setTaskStagePermission(f.root, "@codex", true, { terminal: true, env: {} });
    assert.deepEqual(readTaskStagePolicy(f.root), { handles: ["codex"] });
    setTaskStagePermission(f.root, "codex", false, { terminal: true, env: {} });
    assert.deepEqual(readTaskStagePolicy(f.root), { handles: [] });
  } finally { f.cleanup(); }
});

test("an agent process cannot host the stage broker", async () => {
  const f = fixture();
  try {
    const service = createTaskDesktopStageService({ store: f.store, stage: { env: { CODEX_THREAD_ID: "agent" } } });
    await assert.rejects(service.prepare(f.identity.token, f.task.id), /owner-launched/);
    assert.equal(f.creations(), 0);
  } finally { f.cleanup(); }
});
