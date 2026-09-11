import assert from "node:assert/strict";
import test from "node:test";

import { buildBoundedDiffManifest, canEnableWriteMode, createGrantWorktree, mergeGrantWorktree, quarantineGrantWorktree, removeGrantWorktree, validateWriteIsolation, worktreeDiffChanges, worktreeHeadCommit, worktreeSpecForGrant } from "@/lib/resident-write-isolation";

test("write launch requires a distinct isolated worktree and pending diff review", () => {
  const result = validateWriteIsolation({
    repositoryRoot: "C:/repos/app",
    worktreeRoot: "C:/repos/.oathlock-worktrees/grant-12345678",
    grantId: "grant-12345678",
    diffReviewState: "pending",
  });
  assert.equal(result.ok, true);
});

test("a grant gets a deterministic isolated worktree and branch", () => {
  const spec = worktreeSpecForGrant("C:/repos/app", "grant-12345678");
  assert.equal(spec.worktreeRoot.replaceAll("\\", "/"), "C:/repos/.oathlock-worktrees/grant-12345678");
  assert.equal(spec.branch, "oathlock/grant-12345678");
});

test("worktree creation invokes git without a shell and binds the grant branch", async () => {
  const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
  const result = await createGrantWorktree({ repositoryRoot: "C:/repos/app", grantId: "grant-12345678", baseRef: "abc123" }, async (file, args, cwd) => {
    calls.push({ file, args, cwd });
    return { stdout: "", stderr: "" };
  });
  assert.equal(result.branch, "oathlock/grant-12345678");
  assert.deepEqual(calls[0]?.args, ["worktree", "add", "-b", "oathlock/grant-12345678", result.worktreeRoot, "abc123"]);
  assert.equal(calls[0]?.file, "git");
});

test("bounded diff manifests reject prohibited and out-of-scope files", () => {
  const manifest = buildBoundedDiffManifest({
    grantId: "grant-12345678",
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    allowedPaths: ["src/", "scripts/example.ts"],
    prohibitedPaths: ["src/secrets/"],
    changes: [
      { status: "M", path: "src/app.ts" },
      { status: "A", path: "src/secrets/key.ts" },
      { status: "M", path: "README.md" },
    ],
  });
  assert.equal(manifest.changedFiles.length, 3);
  assert.deepEqual(manifest.violations.map((v) => v.reason), ["prohibited_path", "outside_allowed_paths"]);
  assert.equal(manifest.reviewable, false);
});

test("write mode requires an approved matching manifest with no scope violations", () => {
  const clean = buildBoundedDiffManifest({
    grantId: "grant-12345678", baseCommit: "a".repeat(40), headCommit: "b".repeat(40),
    allowedPaths: ["src/"], prohibitedPaths: [], changes: [{ status: "M", path: "src/app.ts" }],
  });
  assert.equal(canEnableWriteMode({ manifest: clean, approval: { decision: "approved", manifestDigest: clean.digest } }), true);
  assert.equal(canEnableWriteMode({ manifest: clean, approval: { decision: "rejected", manifestDigest: clean.digest } }), false);
  assert.equal(canEnableWriteMode({ manifest: clean, approval: { decision: "approved", manifestDigest: "stale" } }), false);
});

test("write launch rejects shared roots, unscoped worktrees, and non-reviewable states", () => {
  assert.equal(validateWriteIsolation({ repositoryRoot: "C:/repos/app", worktreeRoot: "C:/repos/app", grantId: "grant-12345678", diffReviewState: "pending" }).ok, false);
  assert.equal(validateWriteIsolation({ repositoryRoot: "C:/repos/app", worktreeRoot: "C:/tmp/worktree", grantId: "grant-12345678", diffReviewState: "pending" }).ok, false);
  assert.equal(validateWriteIsolation({ repositoryRoot: "C:/repos/app", worktreeRoot: "C:/repos/.oathlock-worktrees/grant-12345678", grantId: "grant-12345678", diffReviewState: "approved" }).ok, false);
});

test("worktreeHeadCommit reads HEAD from inside the worktree, not the real repository", async () => {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const head = await worktreeHeadCommit("/isolated/grant-12345678", async (file, args, cwd) => {
    calls.push({ args, cwd });
    return { stdout: `${"a".repeat(40)}\n`, stderr: "" };
  });
  assert.equal(head, "a".repeat(40));
  assert.deepEqual(calls[0]?.args, ["rev-parse", "HEAD"]);
  assert.equal(calls[0]?.cwd, "/isolated/grant-12345678");
});

test("worktreeDiffChanges parses git's name-status output into the bounded manifest shape", async () => {
  const changes = await worktreeDiffChanges("/isolated/grant-12345678", "a".repeat(40), "b".repeat(40), async () => ({
    stdout: "M\tsrc/app.ts\nA\tsrc/new-file.ts\nD\told.ts\n",
    stderr: "",
  }));
  assert.deepEqual(changes, [
    { status: "M", path: "src/app.ts" },
    { status: "A", path: "src/new-file.ts" },
    { status: "D", path: "old.ts" },
  ]);
});

test("worktreeDiffChanges is empty when base and head are identical, without shelling out", async () => {
  let called = false;
  const changes = await worktreeDiffChanges("/isolated/grant-12345678", "a".repeat(40), "a".repeat(40), async () => { called = true; return { stdout: "", stderr: "" }; });
  assert.deepEqual(changes, []);
  assert.equal(called, false);
});

test("removeGrantWorktree, quarantineGrantWorktree, and mergeGrantWorktree invoke the right bounded git primitives", async () => {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const executor = async (file: string, args: string[], cwd: string) => { calls.push({ args, cwd }); return { stdout: "", stderr: "" }; };

  await removeGrantWorktree("C:/repos/app", "C:/repos/.oathlock-worktrees/grant-12345678", executor);
  assert.deepEqual(calls[0]?.args, ["worktree", "remove", "--force", "C:/repos/.oathlock-worktrees/grant-12345678"]);

  const quarantinedPath = await quarantineGrantWorktree("C:/repos/app", "C:/repos/.oathlock-worktrees/grant-12345678", executor);
  assert.deepEqual(calls[1]?.args, ["worktree", "move", "C:/repos/.oathlock-worktrees/grant-12345678", quarantinedPath]);
  assert.ok(quarantinedPath.startsWith("C:/repos/.oathlock-worktrees/grant-12345678.quarantined-"));

  await mergeGrantWorktree("C:/repos/app", "oathlock/grant-12345678", executor);
  assert.deepEqual(calls[2]?.args, ["merge", "--ff-only", "oathlock/grant-12345678"]);
});
