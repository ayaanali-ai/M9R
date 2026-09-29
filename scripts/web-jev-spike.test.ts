import assert from "node:assert/strict";
import test from "node:test";
import { measureJevControlSelection } from "../src/lib/native/web-jev-spike.ts";

test("Jev control spike measures choice accuracy without wiring into broker dispatch", async () => {
  const result = await measureJevControlSelection({
    pageText: "Search the docs",
    controls: [{ ref: "e1", role: "textbox", name: "Search", position: 1 }, { ref: "e2", role: "button", name: "Save", position: 2 }],
    expectedRef: "e1",
    mode: "mock",
  });
  assert.equal(result.status, "measured");
  assert.equal(result.correct, true, "the deterministic mock provides a repeatable measurement baseline");
  assert.ok(typeof result.latencyMs === "number");
});
