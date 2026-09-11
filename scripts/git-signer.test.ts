import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Exercises the real `ssh-keygen`/`git` binaries — no mocking — the same way scripts/mission-relay*.test.ts and other integration-style tests in this repo hit real dependencies rather than fake them. */
test("a repository signed with ensureSigningIdentity produces a real, git-verifiable Ed25519 signature", async () => {
  const { ensureSigningIdentity, configureRepositoryForSigning, signAndCommit } = await import("../src/lib/bridge/git-signer.ts");

  const scratch = mkdtempSync(join(tmpdir(), "oathlock-git-signer-"));
  const keyPath = join(scratch, "signing_key");
  const repoPath = join(scratch, "repo");
  const allowedSignersPath = join(scratch, "allowed_signers");

  try {
    const identity = ensureSigningIdentity(keyPath, "codex-participant@oathlock.test");
    assert.ok(identity.publicKey.startsWith("ssh-ed25519 "));
    assert.ok(identity.fingerprint.includes("ED25519"));

    // Reusing the same keyPath must not rotate the key.
    const again = ensureSigningIdentity(keyPath, "codex-participant@oathlock.test");
    assert.equal(again.publicKey, identity.publicKey);

    execFileSync("git", ["init", "-q", repoPath]);
    writeFileSync(join(repoPath, "file.txt"), "hello from a test\n");
    execFileSync("git", ["-C", repoPath, "add", "file.txt"]);

    writeFileSync(allowedSignersPath, `codex-participant@oathlock.test ${identity.publicKey}\n`);
    configureRepositoryForSigning(repoPath, identity, allowedSignersPath);

    const result = signAndCommit(repoPath, { authorName: "Codex", authorEmail: "codex-participant@oathlock.test", message: "test signed commit" });
    assert.equal(result.commitSha.length, 40);
    assert.equal(result.signatureVerified, true, "git verify-commit must confirm the signature against the allowed-signers file");

    // An allowed-signers file that no longer trusts THIS key must make
    // verification fail — proves signatureVerified is not a rubber stamp.
    // (The principal string alongside the key is informational to git, not
    // part of the trust decision — only the key itself is, so the negative
    // case has to remove/replace the key, not just relabel it.)
    const otherKeyPath = join(scratch, "other_key");
    const otherIdentity = ensureSigningIdentity(otherKeyPath, "someone-else@oathlock.test");
    writeFileSync(allowedSignersPath, `someone-else@oathlock.test ${otherIdentity.publicKey}\n`);
    assert.throws(() => execFileSync("git", ["-C", repoPath, "verify-commit", result.commitSha], { stdio: "pipe" }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("signAndCommit throws when nothing is staged", async () => {
  const { ensureSigningIdentity, configureRepositoryForSigning, signAndCommit } = await import("../src/lib/bridge/git-signer.ts");
  const scratch = mkdtempSync(join(tmpdir(), "oathlock-git-signer-empty-"));
  const keyPath = join(scratch, "signing_key");
  const repoPath = join(scratch, "repo");
  try {
    const identity = ensureSigningIdentity(keyPath, "codex@oathlock.test");
    execFileSync("git", ["init", "-q", repoPath]);
    configureRepositoryForSigning(repoPath, identity);
    assert.throws(() => signAndCommit(repoPath, { authorName: "Codex", authorEmail: "codex@oathlock.test", message: "nothing to commit" }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
