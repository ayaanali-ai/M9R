import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

test("AWARE export script has a standalone public-package boundary", () => {
  const source = readFileSync(resolve("scripts/export-aware-spec.mjs"), "utf8");
  assert.match(source, /packages.*web-protocol-placeholder/);
  assert.match(source, /LICENSE-APACHE/);
  assert.match(source, /LICENSE-CC-BY-4\.0/);
  assert.match(source, /early reference implementation/i);
  assert.match(source, /not currently wired to every M9R execution path/i);
  const readme = readFileSync(resolve("aware-spec/README.md"), "utf8");
  assert.match(readme, /early reference implementation/i);
  assert.match(readme, /do not describe AWARE as governing every browser, shell, or file action/i);
  assert.equal(existsSync(join(resolve("aware-spec"), "schema", "aware-web-protocol-v0.schema.json")), true);
  assert.equal(existsSync(join(resolve("aware-spec"), "package.json")), true);
});
