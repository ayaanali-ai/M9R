import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pagePath = new URL("../src/app/hackathon/page.tsx", import.meta.url);
const submissionPath = new URL("../docs/hackathon/SUBMISSION.md", import.meta.url);

test("hackathon page uses production routes without the retired demo report", async () => {
  const page = await readFile(pagePath, "utf8");

  for (const route of ["/agents", "/security", "/evidence", "/auth"]) {
    assert.match(page, new RegExp(`href=\\"${route}\\"`));
  }

  assert.doesNotMatch(page, /href=\"\/demo\"/i);
  assert.doesNotMatch(page, /guaranteed|unhackable|hack-proof|production proven/i);
  assert.doesNotMatch(page, /[—–]/);
});

test("submission keeps event-owned facts as explicit placeholders", async () => {
  const submission = await readFile(submissionPath, "utf8");

  assert.match(submission, /\[HACKATHON NAME\]/);
  assert.match(submission, /\[TRACK\]/);
  assert.match(submission, /\[TEAM MEMBER NAMES\]/);
  assert.match(submission, /\[VIDEO URL\]/);
  assert.match(submission, /bundled sample/i);
  assert.doesNotMatch(submission, /guaranteed|unhackable|hack-proof|production proven/i);
});
