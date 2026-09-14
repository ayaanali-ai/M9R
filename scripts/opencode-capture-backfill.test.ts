import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  backfillOpenCodeCapture,
  parseOpenCodeExportOutput,
  parseOpenCodeSessionListOutput,
  opencodeBackfillCursorPath,
  type OpenCodeCommandRunner,
} from "../src/lib/opencode-capture-backfill-core.ts";
import { drainCaptureSpool, spoolPath } from "../src/lib/cross-agent-capture-core.ts";

function commandRunner(responses: Record<string, string>): OpenCodeCommandRunner {
  return async (args) => {
    const key = args[0] === "export" ? `export:${args[1]}` : "list";
    const output = responses[key];
    if (output === undefined) throw new Error(`unexpected OpenCode command: ${args.join(" ")}`);
    return { stdout: output, stderr: "" };
  };
}

test("OpenCode session list/export parsers tolerate the CLI's status preamble", () => {
  const sessions = parseOpenCodeSessionListOutput('Loading local sessions...\n[{"id":"ses_1","directory":"C:\\\\repo","updated":42}]');
  assert.deepEqual(sessions, [{ id: "ses_1", directory: "C:\\repo", updated: 42 }]);

  const exported = parseOpenCodeExportOutput('Exporting session: ses_1\n{"info":{"id":"ses_1"},"messages":[]}');
  assert.deepEqual(exported, { info: { id: "ses_1" }, messages: [] });
});

test("backfill queues a persisted OpenCode session after the process is gone, then the normal drainer writes memory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "m9r-opencode-backfill-"));
  try {
    const sessionId = "ses_process_died";
    const list = JSON.stringify([{ id: sessionId, directory: dir, updated: 200, created: 100, title: "recovered" }]);
    const exported = JSON.stringify({
      info: { id: sessionId, directory: dir },
      messages: [{ info: { role: "user" }, parts: [{ type: "text", text: "recover this after the process died" }] }],
    });
    const result = await backfillOpenCodeCapture({
      repositoryRoot: dir,
      runCommand: commandRunner({ list, [`export:${sessionId}`]: `Exporting session: ${sessionId}\n${exported}` }),
      maxCount: 20,
    });

    assert.deepEqual(result, { scanned: 1, queued: 1, skipped: 0, failed: 0 });
    const pending = await readFile(spoolPath(dir), "utf8");
    assert.match(pending, new RegExp(sessionId));

    const drained = await drainCaptureSpool({ repositoryRoot: dir, readTranscript: async () => "" });
    assert.deepEqual(drained, { drained: 1, failed: 0 });
    const memory = await readFile(join(dir, ".oathlock", "memory", "local", "opencode", `${sessionId}.md`), "utf8");
    assert.match(memory, /recover this after the process died/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the backfill cursor and durable spool prevent a restart from queueing the same session twice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "m9r-opencode-backfill-restart-"));
  try {
    const sessionId = "ses_restart_once";
    const runCommand = commandRunner({
      list: JSON.stringify([{ id: sessionId, directory: dir, updated: 300 }]),
      [`export:${sessionId}`]: JSON.stringify({ info: { id: sessionId }, messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "one capture" }] }] }),
    });

    const first = await backfillOpenCodeCapture({ repositoryRoot: dir, runCommand });
    const second = await backfillOpenCodeCapture({ repositoryRoot: dir, runCommand });
    assert.deepEqual(first, { scanned: 1, queued: 1, skipped: 0, failed: 0 });
    assert.deepEqual(second, { scanned: 1, queued: 0, skipped: 1, failed: 0 });
    assert.equal((await readFile(spoolPath(dir), "utf8")).trim().split(/\r?\n/).length, 1);
    assert.match(await readFile(opencodeBackfillCursorPath(dir), "utf8"), /ses_restart_once/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("empty sessions are remembered for their current revision, while export failures remain retryable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "m9r-opencode-backfill-retry-"));
  try {
    const emptyId = "ses_empty";
    const failedId = "ses_failed";
    const list = JSON.stringify([
      { id: emptyId, directory: dir, updated: 10 },
      { id: failedId, directory: dir, updated: 20 },
    ]);
    let fail = true;
    const runCommand: OpenCodeCommandRunner = async (args) => {
      if (args[0] === "session") return { stdout: list, stderr: "" };
      if (args[1] === emptyId) return { stdout: JSON.stringify({ info: { id: emptyId }, messages: [] }), stderr: "" };
      if (fail) throw new Error("temporary export failure");
      return { stdout: JSON.stringify({ info: { id: failedId }, messages: [{ info: { role: "user" }, parts: [{ type: "text", text: "retry me" }] }] }), stderr: "" };
    };

    assert.deepEqual(await backfillOpenCodeCapture({ repositoryRoot: dir, runCommand }), { scanned: 2, queued: 0, skipped: 1, failed: 1 });
    fail = false;
    assert.deepEqual(await backfillOpenCodeCapture({ repositoryRoot: dir, runCommand }), { scanned: 2, queued: 1, skipped: 1, failed: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
