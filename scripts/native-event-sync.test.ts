import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createLocalStore } from "../src/lib/native/local-store.ts";
import { syncNativeEventsOnce } from "../src/lib/native-event-sync.ts";

async function credential(home: string, workspaceId: string, repoRoot: string, connectedAt: string): Promise<void> {
  const directory = join(home, ".m9r", "workspaces", workspaceId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "codex.json"), JSON.stringify({ workspaceId, deviceId: randomUUID(),
    token: `token-${workspaceId}`, agentKind: "codex", apiUrl: "https://example.test",
    repoRoots: [{ path: repoRoot, connectedAt }],
  }));
}

test("native sync requires consent, persists offline metadata, and never sends task text", async () => {
  const home = await mkdtemp(join(tmpdir(), "m9r-sync-"));
  try {
    const repo = join(home, "project-a");
    const store = createLocalStore(join(home, ".m9r"));
    store.addTask({ from: "you", to: "codex", goal: "private goal that must not upload", origin: "human_typed", cwd: repo, idempotencyKey: randomUUID() });
    let calls = 0;
    const bodies: string[] = [];
    const post = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      bodies.push(String(init?.body));
      if (calls === 1) throw new Error("offline");
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await syncNativeEventsOnce({ home, post });
    assert.equal(calls, 0);

    const workspaceId = randomUUID();
    await credential(home, workspaceId, repo, new Date(Date.now() - 60_000).toISOString());
    await syncNativeEventsOnce({ home, post });
    const statePath = join(home, ".m9r", "sync", `${workspaceId}.json`);
    const offline = JSON.parse(await readFile(statePath, "utf8")) as { pending: Array<{ id: string }> };
    assert.equal(offline.pending.length, 1);
    await syncNativeEventsOnce({ home, post });
    const online = JSON.parse(await readFile(statePath, "utf8")) as { pending: Array<{ id: string }> };
    assert.equal(online.pending.length, 0);
    assert.equal(calls, 2);
    assert.doesNotMatch(bodies.join("\n"), /private goal/);
    assert.equal(JSON.parse(bodies[0]).events[0].id, JSON.parse(bodies[1]).events[0].id);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("native sync separates two connected repos and skips old or ambiguous events", async () => {
  const home = await mkdtemp(join(tmpdir(), "m9r-scope-"));
  try {
    const a = join(home, "a");
    const b = join(home, "b");
    const first = randomUUID();
    const second = randomUUID();
    await credential(home, first, a, new Date(Date.now() - 60_000).toISOString());
    await credential(home, second, b, new Date(Date.now() - 60_000).toISOString());
    const store = createLocalStore(join(home, ".m9r"));
    store.addTask({ from: "you", to: "codex", goal: "alpha", origin: "human_typed", cwd: a, idempotencyKey: randomUUID() });
    store.addTask({ from: "you", to: "codex", goal: "beta", origin: "human_typed", cwd: b, idempotencyKey: randomUUID() });
    store.addTask({ from: "you", to: "codex", goal: "unknown", origin: "human_typed", cwd: home, idempotencyKey: randomUUID() });
    const sent = new Map<string, Array<{ taskId?: string }>>();
    await syncNativeEventsOnce({ home, post: (async (_url: string | URL | Request, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).authorization;
      sent.set(auth, JSON.parse(String(init?.body)).events);
      return new Response("{}", { status: 200 });
    }) as typeof fetch });
    assert.equal(sent.get(`Bearer token-${first}`)?.length, 1);
    assert.equal(sent.get(`Bearer token-${second}`)?.length, 1);
    assert.notEqual(sent.get(`Bearer token-${first}`)?.[0].taskId, sent.get(`Bearer token-${second}`)?.[0].taskId);
  } finally { await rm(home, { recursive: true, force: true }); }
});
