import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pagePath = new URL("../src/app/hackathon/page.tsx", import.meta.url);

test("hackathon page links only routes that exist, without the retired demo report or overclaiming", async () => {
  const page = await readFile(pagePath, "utf8");
  const routes = [...page.matchAll(/href=\"(\/[a-z-]+)\"/g)].map((match) => match[1]);
  assert.ok(routes.length > 0);
  for (const route of routes) {
    assert.ok(existsSync(new URL(`../src/app${route}`, import.meta.url)), `${route} must be a real app route`);
  }
  assert.doesNotMatch(page, /href=\"\/demo\"/i);
  assert.doesNotMatch(page, /guaranteed|unhackable|hack-proof|production proven/i);
  assert.doesNotMatch(page, /[—–]/);
});
