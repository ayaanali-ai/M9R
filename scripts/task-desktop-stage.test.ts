import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalStore } from "../src/lib/native/local-store";
import { createTaskDesktopStageService, readTaskStagePolicy, resolveLaunchTarget, setTaskStagePermission, stageAccessMode } from "../src/lib/native/task-desktop-stage";
import { resolveUnlistedStageApp } from "../src/lib/native/task-stage-apps";
import type { createCuaStageDriver } from "../src/lib/native/cua-stage-driver";
import type { StageApprovalRequest } from "../src/lib/native/web-broker-core";

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

test("owner-preview preparation does not create or switch to a background desktop", async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare(f.identity.token, f.task.id, "owner-preview");
    assert.equal(prepared.mode, "owner-preview");
    assert.match(prepared.name, /^preview-agent-[a-f0-9]{24}$/);
    assert.equal(prepared.hasAnchor, false);
    assert.equal("roomDesktopId" in prepared, false);
    assert.equal(f.creations(), 0, "preview preparation must not call createDesktop");
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

function moneyFixture(label: string | undefined, verdict: boolean, manualRelease = false) {
  const root = mkdtempSync(join(tmpdir(), "m9r-stage-money-"));
  const store = createLocalStore(root);
  const identity = store.issueIdentity("codex", "codex", "session-money");
  const { task } = store.addTask({ from: "you", to: "codex", goal: "Use a stage", origin: "human_typed", idempotencyKey: `money-${label ?? "none"}-${verdict}-${Math.random()}` });
  let control = true;
  const seen: StageApprovalRequest[] = [];
  const clicks: Array<{ x: number; y: number }> = [];
  let releaseApproval: (() => void) | null = null;
  const fakeDriver = {
    describeTarget: async () => (label === undefined ? undefined : { label }),
    click: async (_name: string, x: number, y: number) => {
      clicks.push({ x, y });
      return { capture: { dataUrl: "data:image/png;base64,x", width: 8, height: 8, capturedAt: new Date(0).toISOString() }, outcome: { status: "confirmed" as const } };
    },
  } as unknown as ReturnType<typeof createCuaStageDriver>;
  const service = createTaskDesktopStageService({
    store,
    readPolicy: () => (control ? { handles: ["codex"], controlHandles: ["codex"] } : { handles: ["codex"] }),
    stage: {
      platform: "win32", env: {}, invokeNative: async (request) => {
        if (request.op === "createDesktop") return { ok: true, desktop: { desktopId: "11111111-1111-4111-8111-111111111111", isCurrent: false, returnDesktopId: "22222222-2222-4222-8222-222222222222" } };
        if (request.op === "inspectDesktop") return { ok: true, desktop: { desktopId: String(request.desktopId), isCurrent: false } };
        throw new Error(`Unexpected native operation in money-gate fixture: ${request.op}`);
      },
    },
    driver: fakeDriver,
    approvals: () => ({
      requestApproval: async (request: StageApprovalRequest) => {
        seen.push(request);
        if (manualRelease) await new Promise<void>((resolve) => { releaseApproval = resolve; });
        return verdict;
      },
    }),
  });
  return { root, store, identity, task, service, seen, clicks, setControl: (value: boolean) => { control = value; }, release: () => releaseApproval?.(), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a money-like stage click waits for the owner and never executes on deny", async () => {
  const f = moneyFixture("Pay $49 now", false);
  try {
    await f.service.prepare(f.identity.token, f.task.id, "background");
    await assert.rejects(f.service.act(f.identity.token, f.task.id, { kind: "click", x: 10, y: 10 }, "background"), /did not approve/);
    assert.equal(f.seen.length, 1);
    assert.equal(f.seen[0].agent, "codex");
    assert.equal(f.seen[0].targetLabel, "Pay $49 now");
    assert.match(f.seen[0].step, /Pay \$49 now/);
    assert.equal(f.clicks.length, 0, "a denied purchase click must not reach the driver");
  } finally { f.cleanup(); }
});

test("an approved money-like stage click executes once with the approval on record", async () => {
  const f = moneyFixture("Subscribe", true);
  try {
    await f.service.prepare(f.identity.token, f.task.id, "background");
    const result = await f.service.act(f.identity.token, f.task.id, { kind: "click", x: 10, y: 10 }, "background") as { outcome: { status: string } };
    assert.equal(result.outcome.status, "confirmed");
    assert.equal(f.seen.length, 1);
    assert.deepEqual(f.clicks, [{ x: 10, y: 10 }]);
  } finally { f.cleanup(); }
});

test("a benign stage click never bothers the owner", async () => {
  const f = moneyFixture("Next", true);
  try {
    await f.service.prepare(f.identity.token, f.task.id, "background");
    await f.service.act(f.identity.token, f.task.id, { kind: "click", x: 10, y: 10 }, "background");
    assert.equal(f.seen.length, 0, "standing approval covers non-money clicks without a hold");
    assert.deepEqual(f.clicks, [{ x: 10, y: 10 }]);
  } finally { f.cleanup(); }
});

test("an undescribed click target holds for the owner instead of guessing", async () => {
  const f = moneyFixture(undefined, false);
  try {
    await f.service.prepare(f.identity.token, f.task.id, "background");
    await assert.rejects(f.service.act(f.identity.token, f.task.id, { kind: "click", x: 10, y: 10 }, "background"), /did not approve/);
    assert.equal(f.seen.length, 1);
    assert.equal(f.seen[0].targetLabel, undefined);
    assert.equal(f.clicks.length, 0);
  } finally { f.cleanup(); }
});

test("revoking control while the owner decides stops the click even after approve", async () => {
  const f = moneyFixture("Pay now", true, true);
  try {
    await f.service.prepare(f.identity.token, f.task.id, "background");
    const pending = f.service.act(f.identity.token, f.task.id, { kind: "click", x: 10, y: 10 }, "background");
    for (let i = 0; i < 200 && f.seen.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(f.seen.length, 1, "the money click must be waiting on the owner before revocation lands");
    f.setControl(false);
    f.release();
    await assert.rejects(pending, /revoked/);
    assert.equal(f.clicks.length, 0, "a revoked agent must not click even with an approval in flight");
  } finally { f.cleanup(); }
});

test("access modes round-trip through the owner-only policy; legacy entries stay scoped", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-stage-modes-"));
  try {
    setTaskStagePermission(root, "codex", true, { terminal: true, env: {} }, true, "full");
    assert.deepEqual(readTaskStagePolicy(root), { handles: ["codex"], controlHandles: ["codex"], modes: { codex: "full" } });
    assert.equal(stageAccessMode(readTaskStagePolicy(root), "codex"), "full");
    // Re-granting without a mode returns the handle to scoped, deterministically.
    setTaskStagePermission(root, "codex", true, { terminal: true, env: {} }, true);
    assert.deepEqual(readTaskStagePolicy(root), { handles: ["codex"], controlHandles: ["codex"] });
    assert.equal(stageAccessMode(readTaskStagePolicy(root), "codex"), "scoped");
    setTaskStagePermission(root, "codex", true, { terminal: true, env: {} }, true, "request");
    assert.equal(stageAccessMode(readTaskStagePolicy(root), "codex"), "request");
    setTaskStagePermission(root, "codex", false, { terminal: true, env: {} });
    assert.deepEqual(readTaskStagePolicy(root), { handles: [] });
    assert.equal(stageAccessMode(readTaskStagePolicy(root), "codex"), "scoped");
    assert.throws(() => setTaskStagePermission(root, "codex", true, { terminal: true, env: {} }, true, "everything" as never), /Invalid stage access mode/);
    assert.throws(() => setTaskStagePermission(root, "codex", true, { terminal: true, env: { OPENCODE: "1" } }, true, "full"), /Only the owner/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unlisted app resolution is broker-fixed: well-known ids probe install roots, absolute paths need full mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-stage-resolve-"));
  try {
    const exe = join(root, "app.exe");
    writeFileSync(exe, "fake exe bytes");
    const env = { ProgramFiles: root, "ProgramFiles(x86)": root, LocalAppData: root };
    assert.throws(() => resolveUnlistedStageApp("chrome", { allowAbsolutePath: true, env, exists: () => false }), /not installed at any of its standard locations/);
    assert.throws(() => resolveUnlistedStageApp("notepad", { allowAbsolutePath: true, env }), /not been approved/);
    assert.throws(() => resolveUnlistedStageApp(exe, { allowAbsolutePath: false, env }), /not been approved/, "request mode never takes agent-named paths");
    const resolved = resolveUnlistedStageApp(exe, { allowAbsolutePath: true, env });
    assert.equal(resolved.wellKnown, false);
    assert.deepEqual(resolved.args, []);
    assert.match(resolved.sha256, /^[a-f0-9]{64}$/);
    assert.throws(() => resolveUnlistedStageApp(join(root, "app.txt"), { allowAbsolutePath: true, env }), /not been approved/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("launch decisions: catalog flows, full resolves unlisted, request holds, scoped refuses", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-stage-launch-"));
  try {
    const exe = join(root, "toollauncher.exe");
    writeFileSync(exe, "fake exe bytes");
    const chromeExe = join(root, "Google", "Chrome", "Application", "chrome.exe");
    const full = { handles: ["codex"], controlHandles: ["codex"], modes: { codex: "full" as const } };
    const scoped = { handles: ["codex"], controlHandles: ["codex"] };
    const request = { handles: ["codex"], controlHandles: ["codex"], modes: { codex: "request" as const } };
    const decided = resolveLaunchTarget(root, full, "codex", exe);
    assert.equal(decided.app.executable, exe);
    assert.equal(decided.needsApproval, undefined);
    assert.throws(() => resolveLaunchTarget(root, scoped, "codex", exe), /not been approved/);
    // Request mode never takes agent-named paths, even for existing files.
    assert.throws(() => resolveLaunchTarget(root, request, "codex", exe), /not been approved/);
    // But it holds broker-resolved browsers for the owner: fake an installed Chrome.
    mkdirSync(join(root, "Google", "Chrome", "Application"), { recursive: true });
    writeFileSync(chromeExe, "fake chrome bytes");
    const installed = (p: string) => p === chromeExe;
    const held = resolveLaunchTarget(root, request, "codex", "chrome", { env: { ProgramFiles: root }, exists: installed });
    assert.equal(held.app.executable, chromeExe);
    assert.match(held.needsApproval!.step, /Launching/);
    assert.equal(held.needsApproval!.targetLabel, chromeExe);
    const direct = resolveLaunchTarget(root, full, "codex", "chrome", { env: { ProgramFiles: root }, exists: installed });
    assert.equal(direct.app.executable, chromeExe);
    assert.equal(direct.needsApproval, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
