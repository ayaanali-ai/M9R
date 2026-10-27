import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentCredentialPath,
  agentCredentialRoot,
  legacyAgentCredentialPath,
  migrateLegacyAgentCredential,
  migrateLegacyAgentCredentials,
  protectAgentCredentialFile,
  readAgentCredential,
  retireAgentCredentialFile,
  workspaceCredentialKey,
} from "@/lib/native/agent-credential-store";

const TOKEN_A = "oak_test_credential_value_a_123456";
const TOKEN_B = "oak_test_credential_value_b_123456";
const NO_WINDOWS_ACL = { platform: "linux" as NodeJS.Platform };

async function fixture(): Promise<{ base: string; repo: string; home: string; env: Record<string, string> }> {
  const base = await mkdtemp(join(tmpdir(), "m9r-credential-store-test-"));
  const repo = join(base, "repo");
  const home = join(base, "home");
  await mkdir(repo, { recursive: true });
  await mkdir(home, { recursive: true });
  return { base, repo, home, env: { M9R_HOME: home } };
}

test("credential root is per-user, per-workspace, and rejects a project-local M9R_HOME", async () => {
  const { base, repo, home, env } = await fixture();
  try {
    const root = agentCredentialRoot(repo, env, home);
    assert.ok(root.startsWith(home));
    assert.ok(root.includes(join("workspaces", workspaceCredentialKey(repo))));
    assert.notEqual(root, repo);
    assert.throws(() => agentCredentialRoot(repo, { M9R_HOME: repo }, home), /outside the project workspace/i);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("Windows protection removes inherited access and grants only the owner", () => {
  const calls: string[][] = [];
  protectAgentCredentialFile("C:\\Users\\owner\\.m9r\\credential.json", {
    platform: "win32",
    username: "MSI\\owner",
    run: (args) => calls.push(args),
  });
  assert.deepEqual(calls, [
    ["C:\\Users\\owner\\.m9r\\credential.json", "/inheritance:r"],
    ["C:\\Users\\owner\\.m9r\\credential.json", "/grant:r", "MSI\\owner:(F)"],
  ]);
});

test("legacy project credentials migrate without leaving a bearer copy in the repository", async () => {
  const { base, repo, env } = await fixture();
  try {
    const legacyPath = legacyAgentCredentialPath(repo, "codex");
    await mkdir(join(repo, ".m9r", "agents", "codex"), { recursive: true });
    await writeFile(legacyPath, JSON.stringify({ token: TOKEN_A, saved_at: "2026-10-22T00:00:00.000Z" }) + "\n", "utf8");

    const result = await migrateLegacyAgentCredential(repo, "codex", env, NO_WINDOWS_ACL);
    assert.equal(result.action, "moved");
    const canonicalPath = agentCredentialPath(agentCredentialRoot(repo, env), "codex");
    assert.equal((await readAgentCredential(repo, "codex", env, NO_WINDOWS_ACL))?.token, TOKEN_A);
    assert.equal((await readFile(canonicalPath, "utf8")).includes(TOKEN_A), true);
    const legacyAfter = await readFile(legacyPath, "utf8").catch(() => "");
    assert.doesNotMatch(legacyAfter, new RegExp(TOKEN_A));
    if (legacyAfter) assert.match(legacyAfter, /m9r-user-scoped-credential-v1/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("migration refuses a destination conflict and preserves the legacy source", async () => {
  const { base, repo, env } = await fixture();
  try {
    const legacyPath = legacyAgentCredentialPath(repo, "claude-code");
    const canonicalPath = agentCredentialPath(agentCredentialRoot(repo, env), "claude-code");
    await mkdir(join(repo, ".m9r", "agents", "claude-code"), { recursive: true });
    await mkdir(join(canonicalPath, ".."), { recursive: true });
    await writeFile(legacyPath, JSON.stringify({ token: TOKEN_A }) + "\n", "utf8");
    await writeFile(canonicalPath, JSON.stringify({ token: TOKEN_B }) + "\n", "utf8");

    const result = await migrateLegacyAgentCredential(repo, "claude-code", env, NO_WINDOWS_ACL);
    assert.equal(result.action, "conflict");
    assert.equal((await readFile(legacyPath, "utf8")).includes(TOKEN_A), true);
    assert.equal((await readFile(canonicalPath, "utf8")).includes(TOKEN_B), true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a revoked legacy credential is neutralized without being copied into the active store", async () => {
  const { base, repo, env } = await fixture();
  try {
    const revokedPath = join(repo, ".m9r", "agents", "opencode", "local.revoked.json");
    await mkdir(join(repo, ".m9r", "agents", "opencode"), { recursive: true });
    await writeFile(revokedPath, JSON.stringify({ token: TOKEN_A }) + "\n", "utf8");

    const results = await migrateLegacyAgentCredentials(repo, env, ["opencode"], NO_WINDOWS_ACL);
    assert.equal(results[0]?.action, "none");
    const after = JSON.parse(await readFile(revokedPath, "utf8")) as Record<string, unknown>;
    assert.equal(after.token, undefined);
    assert.equal(after.migration, "m9r-user-scoped-credential-v1");
    const repeated = await migrateLegacyAgentCredentials(repo, env, ["opencode"], NO_WINDOWS_ACL);
    assert.equal(repeated[0]?.action, "none", "already-neutralized artifacts are idempotent");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a revoked user-scoped credential is retired without retaining its bearer", async () => {
  const { base, repo, env } = await fixture();
  try {
    const path = agentCredentialPath(agentCredentialRoot(repo, env), "opencode");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({ token: TOKEN_A }) + "\n", "utf8");

    assert.equal(await retireAgentCredentialFile(path, "opencode", NO_WINDOWS_ACL), true);
    const marker = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.equal(marker.migration, "m9r-user-scoped-credential-v1");
    assert.equal(marker.retired, "revoked");
    assert.equal("token" in marker, false);
    assert.equal(await readAgentCredential(repo, "opencode", env, NO_WINDOWS_ACL), null);
    assert.equal(await retireAgentCredentialFile(path, "opencode", NO_WINDOWS_ACL), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
