import assert from "node:assert/strict";
import test from "node:test";
import { parseResidentActivityLine, summarizeResidentProviderLine } from "../src/lib/resident-activity-journal.ts";

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
