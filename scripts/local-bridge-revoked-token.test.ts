import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyWhoamiResponse, listLocalConnectedProviders, retireRevokedLocalToken } from "../src/lib/bridge/local-mission-bridge-bootstrap.ts";

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

test("a retired token stops the provider from being treated as connected, and is kept for reversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "m9r-revoked-"));
  const dir = join(root, ".oathlock", "agents", "opencode");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "local.json"), JSON.stringify({ token: "m9r_dead_token" }));
  assert.deepEqual(await listLocalConnectedProviders(root), ["opencode"]);

  const moved = await retireRevokedLocalToken(root, "opencode");
  assert.equal(moved, join(dir, "local.revoked.json"));
  assert.deepEqual(await listLocalConnectedProviders(root), [], "no longer listed as connected, so no bridge is spawned for it");
  await assert.rejects(access(join(dir, "local.json")));
  assert.equal(JSON.parse(await readFile(join(dir, "local.revoked.json"), "utf8")).token, "m9r_dead_token", "moved, not deleted");
  assert.equal(await retireRevokedLocalToken(root, "opencode"), null, "second call is a harmless no-op");
  assert.equal(await retireRevokedLocalToken(root, "../evil"), null, "provider names are validated");
});
