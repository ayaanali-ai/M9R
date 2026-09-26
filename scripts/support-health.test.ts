import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("support page uses the configured contact address and links the privacy notice", () => {
  const page = read("src/app/support/page.tsx");
  assert.match(page, /CONTACT_EMAIL/);
  assert.match(page, /CONTACT_MAILTO/);
  assert.match(page, /href="\/privacy"|href=\{[^}]*\/privacy/);
});

test("support page is included in the public sitemap and footer navigation", () => {
  assert.match(read("src/app/sitemap.ts"), /"\/support"/);
  assert.match(read("src/components/world/WorldShell.tsx"), /href="\/support"/);
});
