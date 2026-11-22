import assert from "node:assert/strict";
import test from "node:test";
import { codeFrom } from "./bench/strategies";

test("benchmark value parsing ignores the M9R teammate activity suffix", () => {
  assert.equal(codeFrom("A7K2QM\n[teammates meanwhile] Codex opened /search/list-2"), "A7K2QM");
  assert.equal(codeFrom("A7K2QM"), "A7K2QM");
});
