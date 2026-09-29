import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createResidentActivityWriter, parseResidentActivityLine, residentActivityJournalPath, summarizeResidentProviderLine } from "../src/lib/resident-activity-journal.ts";

test("resident journal accepts bounded lifecycle records", () => {
  const line = JSON.stringify({
    protocolVersion: "oathlock.resident-activity.v1",
    grantId: "grant-journal-1234",
    provider: "codex",
    kind: "started",
    occurredAt: "2026-07-18T12:00:00.000Z",
    sequence: 1,
    data: "started",
  });
  assert.equal(parseResidentActivityLine(line)?.grantId, "grant-journal-1234");
  assert.equal(parseResidentActivityLine("not json"), null);
});

test("provider stream summaries retain activity categories without raw assistant content", () => {
  const raw = JSON.stringify({ type: "assistant", message: { content: "private source and prompt" } });
  const summary = summarizeResidentProviderLine("claude-code", "stdout", raw);
  assert.equal(summary, "Claude produced an assistant update.\r\n");
  assert.doesNotMatch(summary ?? "", /private source|prompt/);
});

test("resident activity journal stops appending at its byte budget without rewriting history", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-resident-journal-"));
  try {
    const writer = createResidentActivityWriter(root, { maxBytes: 512 });
    for (let sequence = 1; sequence <= 20; sequence += 1) {
      writer.publish({
        protocolVersion: "oathlock.resident-activity.v1",
        grantId: "grant-journal-1234",
        provider: "codex",
        kind: "output",
        occurredAt: new Date(1_700_000_000_000 + sequence).toISOString(),
        sequence,
        data: `activity-${sequence}-` + "x".repeat(32),
      });
    }
    await writer.flush();
    const path = residentActivityJournalPath(root);
    assert.ok(statSync(path).size <= 512);
    const lines = readFileSync(path, "utf8").trim().split(/\r?\n/);
    assert.ok(lines.length > 0);
    assert.ok(lines.every((line) => parseResidentActivityLine(line) !== null));
    assert.doesNotMatch(lines.join("\n"), /activity-20/);
    const beforeRejectedWrite = readFileSync(path, "utf8");
    writer.publish({
      protocolVersion: "oathlock.resident-activity.v1",
      grantId: "grant-journal-1234",
      provider: "codex",
      kind: "output",
      occurredAt: new Date(1_700_000_000_021).toISOString(),
      sequence: 21,
      data: "after-capacity",
    });
    await writer.flush();
    assert.equal(readFileSync(path, "utf8"), beforeRejectedWrite, "full-journal writes are dropped without truncating the existing event history");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
