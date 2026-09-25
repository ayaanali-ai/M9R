import assert from "node:assert/strict";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { attributeNativeEvents, workspaceForNativePath, type NativeWorkspaceBinding } from "../src/lib/native-event-attribution.ts";
import type { Task } from "../src/lib/native/inbox-core.ts";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const at = "2026-09-22T12:00:00.000Z";
const roots: NativeWorkspaceBinding[] = [
  { workspaceId: first, hmacKey: "first-secret", repoRoots: [{ path: resolve("example", "alpha"), connectedAt: "2026-09-22T10:00:00.000Z" }] },
  { workspaceId: second, hmacKey: "second-secret", repoRoots: [{ path: resolve("example", "beta"), connectedAt: "2026-09-22T10:00:00.000Z" }] },
];

test("native event paths map only inside one consented repo root", () => {
  assert.equal(workspaceForNativePath(join(roots[0].repoRoots[0].path, "src"), at, roots), first);
  assert.equal(workspaceForNativePath(join(roots[1].repoRoots[0].path, "src"), at, roots), second);
  assert.equal(workspaceForNativePath(resolve("example", "alphabeta"), at, roots), null);
  assert.equal(workspaceForNativePath(undefined, at, roots), null);
  assert.equal(workspaceForNativePath(roots[0].repoRoots[0].path, "2026-09-22T09:00:00.000Z", roots), null);
  assert.equal(workspaceForNativePath(roots[0].repoRoots[0].path, at, [...roots, { ...roots[0], workspaceId: second }]), null);
});

test("only attributable metadata is selected; prompt and result text never enter the output", () => {
  const task = { id: "T17", cwd: join(roots[0].repoRoots[0].path, "src") } as Task;
  const events = attributeNativeEvents({ tasks: [task], sessions: [], events: [
    { at, kind: "task.created", taskId: "T17", handle: "codex", text: "secret goal text" },
    { at, kind: "task.result", taskId: "T17", handle: "codex", text: "secret result text" },
    { at, kind: "task.created", taskId: "unknown", text: "other workspace" },
  ] }, roots);
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.workspaceId === first));
  assert.deepEqual(events.map((event) => event.kind), ["task_created", "task_result"]);
  assert.doesNotMatch(JSON.stringify(events), /secret|goal|result text|other workspace/);
  assert.match(events[0].localIdentity, /^[a-f0-9]{64}$/);
});

test("session connection is attributed by its own original cwd and first-seen time", () => {
  const events = attributeNativeEvents({ tasks: [], events: [], sessions: [
    { handle: "claude", provider: "claude-code", sessionId: "s1", cwd: roots[1].repoRoots[0].path, firstSeenAt: at, lastSeenAt: at },
    { handle: "codex", provider: "codex", sessionId: "s2", firstSeenAt: at, lastSeenAt: at },
  ] }, roots);
  assert.equal(events.length, 1);
  assert.equal(events[0].workspaceId, second);
  assert.equal(events[0].kind, "agent_connected");
});
