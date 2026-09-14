import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMemoryExportOnce } from "../src/lib/memory-export-core.ts";
import { renderCaptureMarkdown } from "../src/lib/cross-agent-capture-core.ts";

test("dashboard memory export advances its cursor but does not write a duplicate of local capture", async () => {
  const dir = await mkdtemp(join(tmpdir(), "m9r-memory-export-dedup-"));
  try {
    const transcript = [
      { sender: "User", body: "Please keep this durable shared-memory transcript exactly once." },
      { sender: "Assistant", body: "It is already present from the provider-side capture path." },
    ];
    const localJob = {
      provider: "opencode" as const,
      sessionId: "ses_local_canonical",
      cwd: dir,
      capturedAtIso: "2026-09-12T00:00:00.000Z",
      export: {},
    };
    const localPath = join(dir, ".oathlock", "memory", "local", "opencode", "ses_local_canonical.md");
    await mkdir(join(dir, ".oathlock", "memory", "local", "opencode"), { recursive: true });
    await writeFile(localPath, renderCaptureMarkdown(localJob, transcript), "utf8");
    await mkdir(join(dir, ".oathlock", "agents", "claude-code"), { recursive: true });
    await writeFile(join(dir, ".oathlock", "agents", "claude-code", "local.json"), JSON.stringify({ token: "test-token" }), "utf8");

    const result = await runMemoryExportOnce({
      repositoryRoot: dir,
      appUrl: "https://example.test",
      fetch: async () => new Response(JSON.stringify({ sessions: [{
        id: "dashboard-session",
        conversationTopic: "general",
        ownerLabel: "Ayaan",
        title: "Same work",
        archivedAtIso: "2026-09-12T00:01:00.000Z",
        transcript: [
          { sender: "Ayaan", body: transcript[0].body },
          { sender: "Claude", body: transcript[1].body },
        ],
      }] }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    assert.deepEqual(result, { exported: 0 });
    await assert.rejects(readFile(join(dir, ".oathlock", "memory", "Ayaan", "general", "dashboard-session.md")));
    assert.match(await readFile(join(dir, ".oathlock", "memory", ".cursor.json"), "utf8"), /2026-09-12T00:01:00\.000Z/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
