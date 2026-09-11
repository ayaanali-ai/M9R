import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync("src/components/product/ApprovalDecisionForm.tsx", "utf8");

/**
 * /dashboard/approvals/[id] is force-dynamic but has no other live-refresh
 * path -- confirmed live: a human decided a request from elsewhere (another
 * tab, the CLI-printed approval link opened a second time) and an already-
 * open copy of this page kept showing "pending" indefinitely. A mounted
 * server component only refetches on navigation or an explicit
 * router.refresh(); it never polls on its own.
 */
test("the approval decision form polls router.refresh() while a decision is still outstanding", () => {
  assert.match(source, /const STALE_DECISION_POLL_MS = 5_000;/);
  assert.match(source, /setInterval\(\(\) => \{\s*if \(document\.visibilityState === "visible"\) router\.refresh\(\);\s*\}, STALE_DECISION_POLL_MS\)/);
  // Cleared on unmount -- no leaked timer once the form is gone.
  assert.match(source, /return \(\) => clearInterval\(timer\);/);
});

test("polling only runs while the tab is actually visible, not in a backgrounded tab", () => {
  const start = source.indexOf("useEffect(() => {");
  const end = source.indexOf("}, [router]);", start);
  assert.ok(start >= 0 && end > start, "the polling effect must remain a single, locatable block");
  const block = source.slice(start, end);
  assert.match(block, /document\.visibilityState === "visible"/);
});
