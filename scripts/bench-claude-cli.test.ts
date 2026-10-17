import assert from "node:assert/strict";
import test from "node:test";
import { redactSecret, runCleanup, validateClaudeSmoke } from "./bench/claude-cli";

test("Claude smoke diagnostics redact every copy of its generated session token", () => {
  assert.equal(redactSecret("token=temporary-token; retry temporary-token", "temporary-token"), "token=[REDACTED]; retry [REDACTED]");
  assert.equal(redactSecret("ordinary diagnostic", ""), "ordinary diagnostic");
});

test("smoke cleanup attempts later finalizers when an earlier resource close fails", async () => {
  const calls: string[] = [];
  const errors: unknown[] = [];

  await runCleanup(
    [
      async () => {
        calls.push("browser");
        throw new Error("browser close failed");
      },
      () => {
        calls.push("site");
      },
      () => {
        calls.push("broker");
      },
    ],
    (error) => errors.push(error),
  );

  assert.deepEqual(calls, ["browser", "site", "broker"]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /browser close failed/);
});

test("Claude smoke fails closed when the provider exits unsuccessfully", () => {
  const validation = validateClaudeSmoke(
    { code: 1, stdout: "", stderr: "OAuth session expired" },
    { result: "OAuth session expired", is_error: true },
    "UU35D3",
    [],
    [],
  );

  assert.equal(validation.ok, false);
  assert.ok(validation.failures.some((failure) => /exit code/.test(failure)));
  assert.ok(validation.failures.some((failure) => /expected code/.test(failure)));
  assert.ok(validation.failures.some((failure) => /page/.test(failure)));
});

test("Claude smoke passes only when the provider reports the expected answer and opened the spec page", () => {
  const validation = validateClaudeSmoke(
    { code: 0, stdout: "", stderr: "" },
    { result: "UU35D3\nm9r_web_open, m9r_web_read\nNO BYPASS TOOL\ndone", is_error: false },
    "UU35D3",
    ["/search/spec"],
    [
      { action: "open", path: "/search/spec", ok: true },
      { action: "read", selector: "#code", ok: true },
    ],
  );

  assert.deepEqual(validation, { ok: true, failures: [] });
});

test("Claude smoke rejects matching text and page load if no successful field read was observed", () => {
  const validation = validateClaudeSmoke(
    { code: 0, stdout: "", stderr: "" },
    { result: "UU35D3", is_error: false },
    "UU35D3",
    ["/search/spec"],
    [{ action: "open", path: "/search/spec", ok: true }],
  );

  assert.equal(validation.ok, false);
  assert.ok(validation.failures.some((failure) => /read command/.test(failure)));
});
