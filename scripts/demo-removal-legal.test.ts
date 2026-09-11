import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("obsolete public demo report route and links are removed", () => {
  assert.equal(existsSync(resolve(root, "src/app/demo/page.tsx")), false);
  assert.doesNotMatch(read("src/components/Footer.tsx"), /href=["']\/demo/);
  assert.doesNotMatch(read("src/app/hackathon/page.tsx"), /href=["']\/demo/);
});

test("footer keeps core product and legal routes without legacy tool clutter", () => {
  const footer = read("src/components/Footer.tsx");
  for (const route of ["/", "/agents", "/auth", "/pricing", "/security", "/privacy", "/terms", "/acceptable-use", "/data-processing"]) {
    assert.match(footer, new RegExp(`href: ["']${route.replace("/", "\\/")}["']`));
  }
  assert.doesNotMatch(footer, /Upload a trace|Improvement|Detectors|Benchmarks|Normalize trace|Import log|Compare runs|Custody audit|Hackathon showcase/);
});

test("legal pages describe OathLock and contain no unresolved jurisdiction placeholder", () => {
  const terms = read("src/app/terms/page.tsx");
  const privacy = read("src/app/privacy/page.tsx");
  assert.doesNotMatch(terms, /RUNLEAK|INSERT STATE|custody clinic/i);
  assert.match(terms, /AI|agent/i);
  assert.match(terms, /human/i);
  assert.match(privacy, /username/i);
  assert.match(privacy, /retention/i);
  assert.match(privacy, /California|European/i);
});
