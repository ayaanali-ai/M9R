import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ManagedProviderConnection, type ManagedProviderConnectionProfile, type ManagedProviderEvent } from "@/lib/native/managed-provider-contract";
import { createManagedProviderOwner } from "@/lib/native/managed-provider-owner";

function fakeConnection(profile: ManagedProviderConnectionProfile, calls: string[]): ManagedProviderConnection {
  let generation = 0;
  let status: "stopped" | "ready" | "working" = "stopped";
  let activeTaskId: string | undefined;
  return {
    profile,
    async start() {
      calls.push(`start:${profile.connectionId}`);
      generation += 1;
      status = "ready";
      return { connectionId: profile.connectionId, generation };
    },
    async *send(task) {
      assert.equal(task.connectionId, profile.connectionId);
      assert.equal(task.cwd, profile.cwd);
      activeTaskId = task.taskId;
      status = "working";
      yield { kind: "status", status: "working", doing: "Working" } satisfies ManagedProviderEvent;
      yield { kind: "accepted" } satisfies ManagedProviderEvent;
      yield { kind: "result", text: "completed", isError: false } satisfies ManagedProviderEvent;
      activeTaskId = undefined;
      status = "ready";
      yield { kind: "status", status: "ready", doing: "Ready" } satisfies ManagedProviderEvent;
    },
    async cancel() { activeTaskId = undefined; status = "ready"; },
    async pause() { status = "ready"; },
    async resume() { status = "ready"; },
    status() {
      return {
        connectionId: profile.connectionId,
        handle: profile.handle,
        provider: profile.provider,
        cwd: profile.cwd,
        status,
        generation,
        ...(activeTaskId ? { activeTaskId } : {}),
      };
    },
    continuation() { return undefined; },
    async drain() { status = "ready"; },
    async stop() { calls.push(`stop:${profile.connectionId}`); status = "stopped"; generation += 1; },
  };
}

test("managed owner routes a task through one logical provider/cwd connection", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-managed-owner-"));
  const calls: string[] = [];
  const identities: string[] = [];
  const events: Array<{ kind: string; handle?: string; text?: string }> = [];
  const tasks = new Map<string, { id: string; to: string; from: string; origin: "human_typed"; approval: "approved"; createdAt: string; delivery: { state: "deferred"; attempts: number }; goal: string }>();
  try {
    const owner = createManagedProviderOwner({
      agents: [{ handle: "claude", provider: "claude-code", folder: "C:/Work/Project" }],
      storeRoot: root,
      repoRoot: "C:/Work/Project",
      brokerPort: 47777,
      store: {
        issueIdentity(handle, provider, sessionId) { identities.push(`${handle}:${provider}:${sessionId}`); return { token: `token-${sessionId}` }; },
        revokeIdentity(sessionId) { identities.push(`revoked:${sessionId}`); },
        getTask(id) { return tasks.get(id) as never; },
        claimProviderDelivery() { return undefined; },
        setDelivery() { return undefined; },
        recordTaskResult() { return { ok: true }; },
      },
      createConnection(selected) { return fakeConnection(selected, calls); },
      onEvent(event) { events.push(event as never); },
    });

    const first = owner.deliver("claude", "first task", "runtime-task-1");
    assert.equal(first.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = owner.deliver("claude", "second task", "runtime-task-2");
    assert.equal(second.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(calls.filter((value) => value.startsWith("start:")).length, 1);
    assert.equal(identities.filter((value) => value.startsWith("claude:claude-code:")).length, 1);
    assert.ok(events.some((event) => event.kind === "result" && event.text === "completed"));
    assert.equal(owner.snapshot()[0]?.folder, "c:/work/project");
    owner.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
