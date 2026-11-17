import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateCliRelativeImports } from "./cli-import-validation.mjs";
import { NATIVE_TEST_FILES, codeCheckPlan, requireNativeReleaseCoverage, testNodeArgs, testSummary, splitTestFilesIntoBatches, validateTestFileManifest } from "./test-suite-runner-core.mjs";

test("CLI validation catches extensionless and missing local imports before publishing", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-cli-imports-"));
  try {
    writeFileSync(join(root, "multiplayer-a2a.js"), "export const ready = true;\n");
    writeFileSync(join(root, "runtime.js"), 'import { ready } from "./multiplayer-a2a";\n');
    assert.throws(() => validateCliRelativeImports(root), /missing relative import \.\/multiplayer-a2a/);
    writeFileSync(join(root, "runtime.js"), 'import { ready } from "./multiplayer-a2a.js";\nexport { thing } from "./missing.js";\n');
    assert.throws(() => validateCliRelativeImports(root), /missing relative import \.\/missing\.js/);
    mkdirSync(join(root, "folder"));
    writeFileSync(join(root, "runtime.js"), 'import "./folder";\n');
    assert.throws(() => validateCliRelativeImports(root), /missing relative import \.\/folder/);
    writeFileSync(join(root, "runtime.js"), 'import { ready } from "./multiplayer-a2a.js";\nimport { join } from "node:path";\n');
    assert.doesNotThrow(() => validateCliRelativeImports(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("test batches preserve every filename and stay below the Windows argument budget", () => {
  const files = ["one.test.ts", "two.test.ts", "three.test.ts", "four.test.ts"];
  const batches = splitTestFilesIntoBatches(files, { maxArgumentChars: 30 });

  assert.deepEqual(batches.flat(), files);
  assert.ok(batches.every((batch) => batch.reduce((sum, file) => sum + `./scripts/${file}`.length + 1, 0) <= 30));
});

test("test batching keeps a filename that fits exactly and rejects an oversized single filename", () => {
  assert.deepEqual(splitTestFilesIntoBatches(["one.test.ts"], { maxArgumentChars: "./scripts/one.test.ts".length }), [["one.test.ts"]]);
  assert.throws(() => splitTestFilesIntoBatches(["an-excessively-long-test-name.test.ts"], { maxArgumentChars: 10 }), /exceeds the test runner argument budget/);
});

test("test batching rejects unsafe or duplicate manifest entries", () => {
  assert.throws(() => splitTestFilesIntoBatches(["../outside.test.ts"]), /Invalid test file name/);
  assert.throws(() => splitTestFilesIntoBatches(["one.test.ts", "one.test.ts"]), /Duplicate test file/);
});

test("full test manifests reject missing files and preserve the declared order", () => {
  const files = ["first.test.ts", "second.test.mjs"];
  assert.deepEqual(validateTestFileManifest(files, [...files, "not-in-manifest.test.ts"]), files);
  assert.throws(() => validateTestFileManifest(files, ["first.test.ts"]), /references a missing test file/);
});

test("the actual release manifest cannot silently omit critical native workflow coverage", () => {
  const files = JSON.parse(readFileSync(new URL("./test-files.json", import.meta.url), "utf8"));
  requireNativeReleaseCoverage(files);
  for (const file of NATIVE_TEST_FILES) assert.throws(() => requireNativeReleaseCoverage(files.filter(item => item !== file)), /missing/);
});

test("named suites batch the same validated files with bounded Node test concurrency", () => {
  const args = testNodeArgs(["one.test.ts", "two.test.ts"]);
  assert.ok(args.includes("--test")); assert.ok(args.includes("--test-concurrency=8"));
  assert.deepEqual(args.slice(-2), ["./scripts/one.test.ts", "./scripts/two.test.ts"]);
  assert.throws(() => testNodeArgs(["one.test.ts"], 0));
  assert.throws(() => testNodeArgs(["one.test.ts"], 99));
  assert.throws(() => testNodeArgs(["../one.test.ts"]));
  assert.deepEqual(testSummary("ℹ tests 10\nℹ pass 8\nℹ fail 1\nℹ skipped 1"), { tests: 10, pass: 8, fail: 1, skipped: 1 });
  assert.deepEqual(testSummary("# tests 10\n# pass 8\n# fail 1\n# skipped 1"), { tests: 10, pass: 8, fail: 1, skipped: 1 });
});

test("development profiles never substitute scoped checks for the full project/release test gate", () => {
  const native = codeCheckPlan("native"), full = codeCheckPlan("full");
  assert.equal(native[0].args.at(-1), "scripts/tsconfig.native-dev.json");
  assert.equal(full[0].args.at(-1), "."); assert.equal(full[1].args.at(-1), "all");
  const scoped = JSON.parse(readFileSync(new URL("./tsconfig.native-dev.json", import.meta.url), "utf8"));
  assert.equal(scoped.extends, "../tsconfig.json");
  assert.ok(scoped.include.includes("../src/lib/native/**/*.ts"));
  assert.equal(scoped.compilerOptions.tsBuildInfoFile, "../.workcache/native-dev.tsbuildinfo");
  const root = JSON.parse(readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8"));
  assert.ok(root.include.includes("**/*.tsx"));
  assert.throws(() => codeCheckPlan("skip-tests"));
});
