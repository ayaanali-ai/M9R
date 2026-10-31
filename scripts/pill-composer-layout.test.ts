import assert from "node:assert/strict";
import test from "node:test";
import { cappedDraftHeight } from "../pill/src/views/composer";
import { botPosition, chatPromptHeight, islandSize } from "../pill/src/core/layout";

test("long drafts stay inside a 120px typing area and a 300px island", () => {
  assert.equal(cappedDraftHeight(0), 48, "a short draft retains two readable lines");
  assert.equal(cappedDraftHeight(88), 88);
  assert.equal(cappedDraftHeight(12_000), 120, "a pasted document scrolls inside its draft area");
  assert.equal(cappedDraftHeight(Number.NaN), 48);
  assert.equal(chatPromptHeight(0, 48), 240);
  assert.equal(chatPromptHeight(0, 88), 280, "the island grows with the draft before reaching the cap");
  assert.deepEqual(islandSize("expanded", "prompt", 0, 120), { w: 640, h: 300 });
  assert.equal(chatPromptHeight(100, 120), 300, "history cannot grow the island beyond its render window");
});

test("the full-width composer has no decorative mark over its input", () => {
  assert.equal(botPosition("expanded", "prompt", 300).opacity, 0);
  assert.equal(botPosition("expanded", "overview", 160).opacity, 1, "other views keep their mark");
});
