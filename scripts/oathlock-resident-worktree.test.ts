import assert from "node:assert/strict";
import test from "node:test";

import { reconcilePendingWorktrees, readPendingWorktrees, writePendingWorktrees, runResidentCycle, type PendingWorktree } from "@/lib/oathlock-resident-core";

const profile = {
  apiUrl: "https://oathlock.example",
  token: "oak_local_secret_1234567890",
  provider: "codex",
  instanceKey: "codex-resident-01",
  repositoryBindingId: "binding-12345678",
  repositoryRoot: "C:/repos/app",
  capabilities: ["review"],
  executionMode: "workspace_write" as const,
  heartbeatSequence: 0,
};

function fakeFs() {
  let stored: PendingWorktree[] | null = null;
  return {
    readFileFn: async () => { if (stored === null) throw new Error("ENOENT"); return JSON.stringify(stored); },
    writeFileFn: async (_path: string, data: string) => { stored = JSON.parse(data) as PendingWorktree[]; },
    mkdirFn: async () => undefined,
    get(): PendingWorktree[] | null { return stored; },
  };
}

test("readPendingWorktrees returns an empty list when no state file exists yet", async () => {
  const entries = await readPendingWorktrees("C:/repos/app", async () => { throw new Error("ENOENT"); });
  assert.deepEqual(entries, []);
});

test("writePendingWorktrees then readPendingWorktrees round-trips entries", async () => {
  const fs = fakeFs();
  const entry: PendingWorktree = { grantId: "grant-1", instanceKey: "codex-resident-01", worktreeRoot: "C:/repos/.oathlock-worktrees/grant-1", branch: "oathlock/grant-1", baseCommit: "a".repeat(40), headCommit: "b".repeat(40) };
  await writePendingWorktrees("C:/repos/app", [entry], fs.writeFileFn, fs.mkdirFn);
  const read = await readPendingWorktrees("C:/repos/app", fs.readFileFn);
  assert.deepEqual(read, [entry]);
});

test("reconcilePendingWorktrees merges and cleans up when the human approved the exact reported diff", async () => {
  const fs = fakeFs();
  const entry: PendingWorktree = { grantId: "grant-1", instanceKey: "codex-resident-01", worktreeRoot: "C:/repos/.oathlock-worktrees/grant-1", branch: "oathlock/grant-1", baseCommit: "a".repeat(40), headCommit: "b".repeat(40) };
  await writePendingWorktrees(profile.repositoryRoot, [entry], fs.writeFileFn, fs.mkdirFn);
  const merges: Array<{ branch: string }> = [];
  const removed: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    assert.ok(String(input).includes("/diff-review?instance_key="));
    return new Response(JSON.stringify({ ok: true, writeEnabled: true, review: { decision: "approved" } }), { status: 200 });
  };
  const result = await reconcilePendingWorktrees(profile, {
    fetch,
    mergeWorktree: async (_root, branch) => { merges.push({ branch }); },
    removeWorktree: async (_root, worktreeRoot) => { removed.push(worktreeRoot); },
    readFileFn: fs.readFileFn,
    writeFileFn: fs.writeFileFn,
    mkdirFn: fs.mkdirFn,
  });
  assert.deepEqual(result, { merged: 1, discarded: 0, stillPending: 0 });
  assert.deepEqual(merges, [{ branch: "oathlock/grant-1" }]);
  assert.deepEqual(removed, ["C:/repos/.oathlock-worktrees/grant-1"]);
  assert.deepEqual(fs.get(), []);
});

test("reconcilePendingWorktrees discards without merging when the human rejected the review", async () => {
  const fs = fakeFs();
  const entry: PendingWorktree = { grantId: "grant-1", instanceKey: "codex-resident-01", worktreeRoot: "C:/repos/.oathlock-worktrees/grant-1", branch: "oathlock/grant-1", baseCommit: "a".repeat(40), headCommit: "b".repeat(40) };
  await writePendingWorktrees(profile.repositoryRoot, [entry], fs.writeFileFn, fs.mkdirFn);
  let mergeCalled = false;
  const removed: string[] = [];
  const fetch: typeof globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, writeEnabled: false, review: { decision: "rejected" } }), { status: 200 });
  const result = await reconcilePendingWorktrees(profile, {
    fetch,
    mergeWorktree: async () => { mergeCalled = true; },
    removeWorktree: async (_root, worktreeRoot) => { removed.push(worktreeRoot); },
    readFileFn: fs.readFileFn,
    writeFileFn: fs.writeFileFn,
    mkdirFn: fs.mkdirFn,
  });
  assert.deepEqual(result, { merged: 0, discarded: 1, stillPending: 0 });
  assert.equal(mergeCalled, false);
  assert.deepEqual(removed, ["C:/repos/.oathlock-worktrees/grant-1"]);
  assert.deepEqual(fs.get(), []);
});

test("reconcilePendingWorktrees leaves a still-pending review untouched, neither merged nor discarded", async () => {
  const fs = fakeFs();
  const entry: PendingWorktree = { grantId: "grant-1", instanceKey: "codex-resident-01", worktreeRoot: "C:/repos/.oathlock-worktrees/grant-1", branch: "oathlock/grant-1", baseCommit: "a".repeat(40), headCommit: "b".repeat(40) };
  await writePendingWorktrees(profile.repositoryRoot, [entry], fs.writeFileFn, fs.mkdirFn);
  let mergeCalled = false, removeCalled = false;
  const fetch: typeof globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, writeEnabled: false, review: { decision: "pending" } }), { status: 200 });
  const result = await reconcilePendingWorktrees(profile, {
    fetch,
    mergeWorktree: async () => { mergeCalled = true; },
    removeWorktree: async () => { removeCalled = true; },
    readFileFn: fs.readFileFn,
    writeFileFn: fs.writeFileFn,
    mkdirFn: fs.mkdirFn,
  });
  assert.deepEqual(result, { merged: 0, discarded: 0, stillPending: 1 });
  assert.equal(mergeCalled, false);
  assert.equal(removeCalled, false);
  assert.deepEqual(fs.get(), [entry]);
});

test("reconcilePendingWorktrees keeps a failing entry pending rather than losing track of it, and still reconciles the rest", async () => {
  const fs = fakeFs();
  const broken: PendingWorktree = { grantId: "grant-broken", instanceKey: "codex-resident-01", worktreeRoot: "C:/repos/.oathlock-worktrees/grant-broken", branch: "oathlock/grant-broken", baseCommit: "a".repeat(40), headCommit: "b".repeat(40) };
  const healthy: PendingWorktree = { grantId: "grant-healthy", instanceKey: "codex-resident-01", worktreeRoot: "C:/repos/.oathlock-worktrees/grant-healthy", branch: "oathlock/grant-healthy", baseCommit: "a".repeat(40), headCommit: "b".repeat(40) };
  await writePendingWorktrees(profile.repositoryRoot, [broken, healthy], fs.writeFileFn, fs.mkdirFn);
  const merges: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    if (String(input).includes("grant-broken")) throw new Error("network down");
    return new Response(JSON.stringify({ ok: true, writeEnabled: true, review: { decision: "approved" } }), { status: 200 });
  };
  const result = await reconcilePendingWorktrees(profile, {
    fetch,
    mergeWorktree: async (_root, branch) => { merges.push(branch); },
    removeWorktree: async () => {},
    readFileFn: fs.readFileFn,
    writeFileFn: fs.writeFileFn,
    mkdirFn: fs.mkdirFn,
  });
  assert.deepEqual(result, { merged: 1, discarded: 0, stillPending: 1 });
  assert.deepEqual(merges, ["oathlock/grant-healthy"]);
  assert.deepEqual(fs.get(), [broken]);
});

test("a successful workspace_write cycle reports the diff and leaves it tracked pending, without merging on its own", async () => {
  const fs = fakeFs();
  const posted: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    if (url.includes("/diff-review")) posted.push({ url, body });
    const json = url.endsWith("/register") ? { residentInstanceId: "resident-1", heartbeatSequence: 1 }
      : url.endsWith("/heartbeat") ? { sequence: body?.sequence ?? 0 }
        : url.includes("/claim") ? { accepted: true, sequence: 3 }
          : url.includes("/events") ? { ok: true }
            : url.includes("/diff-review") ? { ok: true }
              : { grants: [{ id: "grant-write-1", provider: "codex", repository_binding_id: "binding-12345678", task: "Add a helper", allowed_paths: ["src"], prohibited_paths: [], max_duration_ms: 30_000 }] };
    return new Response(JSON.stringify(json), { status: 200 });
  };
  const result = await runResidentCycle(profile, {
    fetch,
    readFileFn: fs.readFileFn,
    writeFileFn: fs.writeFileFn,
    mkdirFn: fs.mkdirFn,
    worktreeHeadFn: async () => "b".repeat(40),
    worktreeDiffFn: async () => [{ status: "M", path: "src/helper.ts" }],
    executeLaunch: async (_input, deps) => {
      await deps.recordEvent({ event: "launch", sequence: 4 });
      await deps.recordEvent({ event: "return_result", sequence: 5, resultText: "added the helper" });
      return {
        status: "returned", result: null,
        worktree: { repositoryRoot: profile.repositoryRoot, worktreeRoot: "C:/repos/.oathlock-worktrees/grant-write-1", branch: "oathlock/grant-write-1", baseCommit: "a".repeat(40) },
      };
    },
  });
  assert.equal(result.returned, 1);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body?.baseCommit, "a".repeat(40));
  assert.equal(posted[0].body?.headCommit, "b".repeat(40));
  assert.equal(posted[0].body?.instanceKey, profile.instanceKey);
  assert.deepEqual(posted[0].body?.changes, [{ status: "M", path: "src/helper.ts" }]);
  // allowedPaths/prohibitedPaths are deliberately never sent -- the server
  // reads those from the grant's own row, never from this request.
  assert.equal(posted[0].body?.allowedPaths, undefined);
  // The worktree stays tracked pending -- runResidentCycle never merges on its own.
  assert.deepEqual(fs.get(), [{ grantId: "grant-write-1", instanceKey: profile.instanceKey, worktreeRoot: "C:/repos/.oathlock-worktrees/grant-write-1", branch: "oathlock/grant-write-1", baseCommit: "a".repeat(40), headCommit: "b".repeat(40) }]);
});
