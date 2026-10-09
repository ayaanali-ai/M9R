import assert from "node:assert/strict";
import test from "node:test";
import { splitTestFilesIntoBatches, validateTestFileManifest } from "./test-suite-runner-core.mjs";

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
