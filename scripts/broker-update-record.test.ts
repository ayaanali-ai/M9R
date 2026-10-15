import assert from "node:assert/strict";
import test from "node:test";
import { parseBrokerUpdateRecord } from "@/lib/native/broker-update-record";

test("broker update records parse UTF-8 JSON with or without a BOM", () => {
  const expected = { version: 1, path: "C:/Users/test/.m9r/bin/m9r-web-broker.exe" };
  assert.deepEqual(parseBrokerUpdateRecord(Buffer.from(JSON.stringify(expected), "utf8"), "web broker install"), expected);
  assert.deepEqual(parseBrokerUpdateRecord(Buffer.from(`\uFEFF${JSON.stringify(expected)}`, "utf8"), "web broker install"), expected);
});

test("a missing broker update record remains optional", () => {
  assert.equal(parseBrokerUpdateRecord(null, "web broker install"), null);
});

test("invalid or non-object broker update records fail closed with a safe error", () => {
  for (const content of ["not json", "null", "[]", "\uFEFF[]"]) {
    assert.throws(
      () => parseBrokerUpdateRecord(Buffer.from(content, "utf8"), "web broker install"),
      /The M9R web broker install ownership record is unreadable; refusing to change the broker process\./,
    );
  }
});
