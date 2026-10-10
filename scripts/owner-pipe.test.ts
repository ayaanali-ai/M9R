import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { connect } from "node:net";
import { requestOwnerPipe, startOwnerPipe } from "@/lib/native/owner-pipe";
import { ownerPipePath } from "@/lib/native/web-broker-paths";
import { createWebAuthority } from "@/lib/native/web-authority-core";
import { startWebBroker } from "@/lib/native/web-broker-server";
import { createWebBrokerClient } from "@/lib/native/web-broker-client";

test("additional socket data cannot dispatch an in-flight pipe request twice", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-pipe-once-"));
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const path = ownerPipePath(root);
  const server = await startOwnerPipe({ path, handle: async () => { calls += 1; await gate; return { ok: true }; } });
  const socket = connect(path);
  try {
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.write(JSON.stringify({ method: "POST", path: "/web/stage/action" }) + "\n");
    await new Promise((resolve) => setTimeout(resolve, 30));
    socket.write("extra data\n");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls, 1);
    release();
    const reply = await new Promise<string>((resolve, reject) => { socket.once("data", (data) => resolve(data.toString())); socket.once("error", reject); });
    assert.equal(JSON.parse(reply).ok, true);
  } finally { release(); socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});

test("desktop IPC uses session authorization without reading the owner key or using HTTP", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-desktop-ipc-"));
  let actions = 0;
  const broker = await startWebBroker({ key: "k".repeat(32), port: 0, ownerPipePath: ownerPipePath(root), taskStages: {
    prepare: async (token) => {
      if (token !== "fixture-session") throw new Error("Session rejected");
      await new Promise((resolve) => setTimeout(resolve, 2100));
      return { ready: true };
    },
    act: async (token, _task, _action, _mode, operationId) => {
      if (token !== "fixture-session") throw new Error("Session rejected");
      actions += 1;
      return { operationId, capture: { dataUrl: "A".repeat(100_000) } };
    },
  } });
  try {
    const client = createWebBrokerClient({ keyPath: join(root, "unreadable-key"), ownerPipePath: ownerPipePath(root),
      fetchImpl: async () => { throw new Error("HTTP must not run"); } });
    assert.equal((await client.prepareTaskStage!("fixture-session", "T1" )).ok, true, "desktop requests outlive the ordinary two-second pipe deadline");
    const captured = await client.taskStageAction!("fixture-session", "T1", { kind: "capture" });
    assert.equal((captured.result as { capture: { dataUrl: string } }).capture.dataUrl.length, 100_000);
    assert.equal((await client.taskStageAction!("bad-session", "T1", { kind: "capture" })).ok, false);
    assert.equal(actions, 1);
    assert.equal((await client.taskStageAction!("fixture-session", "T1", { kind: "click", x: 1, y: 2 })).ok, false, "mutating inputs still require receipts");
    assert.equal(actions, 1);
    assert.equal((await requestOwnerPipe<{ ok: boolean }>(ownerPipePath(root), { method: "POST", path: "/web/approve", body: {} }))?.ok, false);
  } finally { await broker.close(); rmSync(root, { recursive: true, force: true }); }
});

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

test("owner mutations use the authenticated loopback API while the local pipe allows only scoped agent task writes", async () => {
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
