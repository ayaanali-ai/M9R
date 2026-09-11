import test from "node:test";
import assert from "node:assert/strict";

import { parseAgentMessage, parseAgentMessageInline } from "../src/lib/agent-message-markdown.ts";

test("parses agent headings, paragraphs, lists, and fenced code", () => {
  const blocks = parseAgentMessage([
    "## Summary",
    "The **important** part is `ready`.",
    "",
    "- first file",
    "- second file",
    "",
    "```ts",
    "const answer = 42;",
    "```",
  ].join("\n"));

  assert.deepEqual(blocks, [
    { type: "heading", level: 2, text: "Summary" },
    { type: "paragraph", text: "The **important** part is `ready`." },
    { type: "list", ordered: false, items: ["first file", "second file"] },
    { type: "code", lang: "ts", text: "const answer = 42;" },
  ]);
});

test("keeps ordinary prose and line breaks intact", () => {
  assert.deepEqual(parseAgentMessage("one line\ntwo line"), [{ type: "paragraph", text: "one line\ntwo line" }]);
});

test("does not interpret raw HTML as markup", () => {
  assert.deepEqual(parseAgentMessageInline("<script>alert(1)</script>"), [{ type: "text", text: "<script>alert(1)</script>" }]);
});

test("keeps an unclosed fence visible as code instead of dropping content", () => {
  assert.deepEqual(parseAgentMessage("```\nnot dropped"), [{ type: "code", lang: null, text: "not dropped" }]);
});
