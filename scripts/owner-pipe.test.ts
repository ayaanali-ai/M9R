import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { requestOwnerPipe } from "@/lib/native/owner-pipe";
import { ownerPipePath } from "@/lib/native/web-broker-paths";
import { createWebAuthority } from "@/lib/native/web-authority-core";
import { startWebBroker } from "@/lib/native/web-broker-server";

async function http(port: number, key: string, path: string, method = "GET", body?: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers: { "x-m9r-key": key, ...(body === undefined ? {} : { "content-type": "application/json" }) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.on("error", reject);
    if (body === undefined) req.end(); else req.end(JSON.stringify(body));
  });
}

test("owner mutations use the authenticated loopback API and the local pipe is read-only", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-owner-pipe-"));
  const authority = createWebAuthority({ ownerId: "alice" });
  try {
    const key = "k".repeat(32);
    const broker = await startWebBroker({ key, port: 0, ownerPipePath: ownerPipePath(root), authority });
    try {
      assert.equal((await http(broker.port, key, "/web/mode", "POST", { mode: "hands-off" })).status, 200);
      const mode = await requestOwnerPipe<{ ok: boolean; error?: string }>(ownerPipePath(root), { method: "POST", path: "/web/mode", body: { mode: "watch" } });
      assert.equal(mode?.ok, false, "a raw local pipe call must not change the room mode");

      const requested = authority.requestGrant({ grantee: { owner: "bob", agent: "codex" }, origin: "https://example.test", actions: ["read"] });
      assert.equal(requested.ok, true);
      assert.equal((await http(broker.port, key, "/web/approve", "POST", { id: requested.ok ? requested.request.id : "" })).status, 200);
      const approved = await requestOwnerPipe<{ ok: boolean; error?: string }>(ownerPipePath(root), {
        method: "POST", path: "/web/approve", body: { id: requested.ok ? requested.request.id : "" },
      });
      assert.equal(approved?.ok, false, "a raw local pipe call must not approve web access");
    } finally {
      await broker.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("AWARE membership and disclosure mutations require the authenticated owner channel, not a raw pipe call", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-owner-pipe-aware-"));
  try {
    const key = "k".repeat(32);
    const broker = await startWebBroker({ key, port: 0, ownerPipePath: ownerPipePath(root), ownerId: "alice" });
    try {
      const directInvite = await requestOwnerPipe<{ ok: boolean }>(ownerPipePath(root), {
        method: "POST", path: "/web/aware/members/invite", body: { agent: "codex" },
      });
      assert.equal(directInvite?.ok, false, "a process that can open the local pipe must not become the human approver by impersonating the CLI");

      const directProtocolMutation = await requestOwnerPipe<{ ok: boolean }>(ownerPipePath(root), {
        method: "POST", path: "/web/protocol", body: { message_type: "membership" },
      });
      assert.equal(directProtocolMutation?.ok, false, "the generic protocol route must not remain a pipe bypass for owner decisions");

      const authenticatedInvite = await http(broker.port, key, "/web/aware/members/invite", "POST", { agent: "codex" });
      assert.equal(authenticatedInvite.status, 200, "the confirmed owner CLI's broker-key request remains functional");
      const members = await http(broker.port, key, "/web/aware/members");
      assert.equal((members.body as { members: Array<{ principalId: string }> }).members.some((member) => member.principalId === "agent:alice/codex"), true);
    } finally {
      await broker.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
