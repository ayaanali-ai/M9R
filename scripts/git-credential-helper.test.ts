import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a failed push never leaks the installation token in its error message", async () => {
  const { pushWithInstallationToken } = await import("../src/lib/bridge/git-credential-helper.ts");
  const scratch = mkdtempSync(join(tmpdir(), "oathlock-git-push-"));
  const repoPath = join(scratch, "repo");
  const secretToken = "ghs_totallysecrettoken12345";
  try {
    execFileSync("git", ["init", "-q", repoPath]);
    writeFileSync(join(repoPath, "file.txt"), "hello\n");
    execFileSync("git", ["-C", repoPath, "add", "file.txt"]);
    execFileSync("git", ["-C", repoPath, "-c", "user.name=Codex", "-c", "user.email=codex@oathlock.test", "commit", "-q", "-m", "test"]);

    // A push to a nonexistent GitHub org/repo will genuinely fail (auth or
    // resolution error) without needing network mocking — the point here is
    // the token redaction, not a successful push.
    assert.throws(
      () => pushWithInstallationToken({ repoPath, branch: "main", owner: "oathlock-nonexistent-org-xyz", repo: "nonexistent-repo-xyz", token: secretToken }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.ok(!message.includes(secretToken), `error message must not contain the raw token: ${message}`);
        assert.ok(message.includes("x-access-token:***@"), "error message should show the redacted form");
        return true;
      },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
