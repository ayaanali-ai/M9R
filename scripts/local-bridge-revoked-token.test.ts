import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from "node:fs/promises";
import { join } from "node:path";
import { classifyWhoamiResponse, listLocalConnectedProviders, retireRevokedLocalToken } from "../src/lib/bridge/local-mission-bridge-bootstrap.ts";

const testCacheRoot = join(process.cwd(), ".test-tmp");

test("only a 401 saying the agent token is invalid/revoked counts as revoked", () => {
  assert.deepEqual(classifyWhoamiResponse(401, JSON.stringify({ error: "Invalid or expired agent token." })), { kind: "revoked" });
  assert.deepEqual(classifyWhoamiResponse(200, JSON.stringify({ workspaceId: "ws-1" })), { kind: "ok", workspaceId: "ws-1" });
});

test("transient or ambiguous failures never retire a token", () => {
  assert.deepEqual(classifyWhoamiResponse(500, "boom"), { kind: "unresolved" });
  assert.deepEqual(classifyWhoamiResponse(503, ""), { kind: "unresolved" });
  assert.deepEqual(classifyWhoamiResponse(401, "<html>Cloudflare Access</html>"), { kind: "unresolved" }, "a proxy 401 is not a revoked token");
  assert.deepEqual(classifyWhoamiResponse(200, "not json"), { kind: "unresolved" });
  assert.deepEqual(classifyWhoamiResponse(200, JSON.stringify({})), { kind: "unresolved" });
});

test("a retired token stops provider discovery without retaining the bearer", async () => {
  await mkdir(testCacheRoot, { recursive: true });
  const root = await mkdtemp(join(testCacheRoot, "m9r-revoked-"));
  try {
    const credentialRoot = join(root, "credentials");
    const dir = join(credentialRoot, "agents", "opencode");
    await mkdir(dir, { recursive: true });
    const localPath = join(dir, "local.json");
    await writeFile(localPath, JSON.stringify({ token: "m9r_dead_token_123" }));
    assert.deepEqual(await listLocalConnectedProviders(root, credentialRoot), ["opencode"]);

    const retired = await retireRevokedLocalToken(root, "opencode", credentialRoot);
    assert.equal(retired, localPath);
    assert.deepEqual(await listLocalConnectedProviders(root, credentialRoot), [], "no longer listed as connected, so no bridge is spawned for it");
    const marker = JSON.parse(await readFile(localPath, "utf8"));
    assert.equal(marker.migration, "m9r-user-scoped-credential-v1");
    assert.equal(marker.retired, "revoked");
    assert.equal("token" in marker, false, "the revoked bearer is not retained");
    await assert.rejects(access(join(dir, "local.revoked.json")));
    assert.equal(await retireRevokedLocalToken(root, "opencode", credentialRoot), null, "second call is a harmless no-op");
    assert.equal(await retireRevokedLocalToken(root, "../evil"), null, "provider names are validated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
