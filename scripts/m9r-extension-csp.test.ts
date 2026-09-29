import assert from "node:assert/strict";
import test from "node:test";
import { m9rExtensionFrameSource } from "@/lib/m9r-extension-csp";

test("development CSP allows only the fixed unpacked M9R extension origin by default", () => {
  assert.equal(
    m9rExtensionFrameSource(undefined, "development"),
    "chrome-extension://mahhaigfogjneccbmbpbedlnkhgdcmhb",
  );
});

test("production CSP fails closed until the published M9R extension ID is configured", () => {
  assert.equal(m9rExtensionFrameSource(undefined, "production"), null);
  assert.equal(
    m9rExtensionFrameSource("abcdefghijklmnopabcdefghijklmnop", "production"),
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
  );
});

test("configured extension IDs must use Chrome's 32-character a-p alphabet", () => {
  for (const invalid of ["not-an-id", "abcdefghijklmnopabcdefghijklmnopq", "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"]) {
    assert.throws(() => m9rExtensionFrameSource(invalid, "development"), /Chrome extension ID/i);
  }
});
