import assert from "node:assert/strict";
import test from "node:test";
import { generateToolsFromPage } from "./generator";
import { WIKIPEDIA_MAIN_PAGE_ELEMENTS, GITHUB_ADVANCED_SEARCH_ELEMENTS } from "./sample";

test("Wikipedia's textbox+button pair composes into one search tool", () => {
  const { tools, unmapped } = generateToolsFromPage(WIKIPEDIA_MAIN_PAGE_ELEMENTS);
  const search = tools.find((t) => t.name === "search_wikipedia");
  assert.ok(search, "expected a composed search_wikipedia tool");
  assert.deepEqual(search!.targets, ["ref_66", "ref_68"]);
  assert.equal(unmapped.length, 0);
});

test("a label's real for/id link resolves the field it names, no pattern-matching required", () => {
  const { tools } = generateToolsFromPage(GITHUB_ADVANCED_SEARCH_ELEMENTS);
  const owners = tools.find((t) => t.name === "from_these_owners");
  assert.ok(owners, "expected the 'From these owners' label to resolve to its linked textbox");
  assert.deepEqual(owners!.targets, ["ref_58", "ref_59"]);
});

test("a <select> resolved via its label exposes its real options as an enum, not free text", () => {
  const { tools } = generateToolsFromPage(GITHUB_ADVANCED_SEARCH_ELEMENTS);
  const language = tools.find((t) => t.name === "written_in_this_language");
  assert.ok(language, "expected the language select to resolve via its label");
  assert.match(language!.inputSchema.properties.value.type, /enum\(6 options/);
});

test("a label whose for/id never resolves is reported unmapped, never silently dropped or force-matched", () => {
  const { tools, unmapped } = generateToolsFromPage(GITHUB_ADVANCED_SEARCH_ELEMENTS);
  assert.ok(!tools.some((t) => t.name.includes("future")), "a broken link must not produce a fake tool");
  const broken = unmapped.find((u) => u.ref === "ref_90");
  assert.ok(broken, "expected the unresolved label to be reported, not silently skipped");
  assert.match(broken!.reason, /did not resolve/);
});
