import assert from "node:assert/strict";
import test from "node:test";
import { WORKSPACE_RESULT_MAX_CHARS, truncateWorkspaceResult } from "@/lib/bridge/result-truncation";

test("a reply that fits is returned untouched, including exactly at the limit", () => {
  assert.equal(truncateWorkspaceResult("short"), "short");
  const exact = "x".repeat(WORKSPACE_RESULT_MAX_CHARS);
  assert.equal(truncateWorkspaceResult(exact), exact);
});

test("a longer reply keeps as much as fits, never exceeds the limit, and says how much was left out", () => {
  const long = "word ".repeat(1_500);
  const out = truncateWorkspaceResult(long);
  assert.ok(out.length <= WORKSPACE_RESULT_MAX_CHARS, String(out.length));
  assert.match(out, /… \[reply truncated: \d+ more characters not shown\]$/);
  const omitted = Number(/truncated: (\d+) more/.exec(out)![1]);
  const kept = out.slice(0, out.indexOf("\n\n… [reply truncated"));
  assert.equal(kept.length + omitted, long.length, "the marker's count is exact");
  assert.ok(long.startsWith(kept));
});

test("the marker's own length is accounted for at every size, and a tiny limit cannot go negative", () => {
  for (const size of [2_001, 2_050, 9_999, 100_000, 1_000_000]) {
    const out = truncateWorkspaceResult("a".repeat(size));
    assert.ok(out.length <= WORKSPACE_RESULT_MAX_CHARS, `${size} -> ${out.length}`);
    const omitted = Number(/truncated: (\d+) more/.exec(out)![1]);
    assert.equal(out.indexOf("\n\n… [reply truncated") + omitted, size);
  }
  assert.ok(truncateWorkspaceResult("a".repeat(500), 10).length <= 10);
});
