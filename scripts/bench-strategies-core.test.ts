import assert from "node:assert/strict";
import test from "node:test";
import { codeFrom, pageTextAfterBatchClick } from "./bench/strategies";

test("benchmark value parsing ignores the M9R teammate activity suffix", () => {
  assert.equal(codeFrom("A7K2QM\n[teammates meanwhile] Codex opened /search/list-2"), "A7K2QM");
  assert.equal(codeFrom("A7K2QM"), "A7K2QM");
});

test("batched browser click exposes the resulting page text and rejects an incomplete state", () => {
  const result = JSON.stringify({
    ok: true,
    steps: [{ index: 0, action: "click", response: { ok: true, changedPart: "Product id: P-34\nCertification code: A7K2QM" } }],
  });
  assert.equal(pageTextAfterBatchClick(result), "Product id: P-34\nCertification code: A7K2QM");
  assert.throws(() => pageTextAfterBatchClick('{"ok":true,"steps":[{"response":{"ok":true}}]}'), /did not return page text/);
});
