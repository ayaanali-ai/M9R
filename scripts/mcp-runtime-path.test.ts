import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isPackagedMcpExecutable, resolveMcpRuntimeExecutable } from "../src/lib/native/mcp-runtime-path.ts";

test("a packaged supervisor spawned from a retired image resolves the active installed engine", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-mcp-runtime-path-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const active = join(bin, "m9r-engine.exe");
    writeFileSync(active, "current", "utf8");
    const retired = join(bin, "m9r-engine.exe.m9r-retired-1234-abcd");
    assert.equal(resolveMcpRuntimeExecutable({ M9R_HOME: root }, retired, "win32"), active);
    assert.equal(isPackagedMcpExecutable(retired), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a retired packaged supervisor never falls back to its own image when the stable engine is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-mcp-runtime-missing-"));
  try {
    const retired = join(root, "bin", "m9r-engine.exe.m9r-retired-1234-abcd");
    assert.throws(
      () => resolveMcpRuntimeExecutable({ M9R_HOME: root }, retired, "win32"),
      /stable M9R engine is missing.*refusing to start another provider worker/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-engine MCP entrypoints are not redirected to the installed runtime", () => {
  assert.equal(resolveMcpRuntimeExecutable({ M9R_HOME: "C:/m9r" }, "node.exe", "win32"), "node.exe");
  assert.equal(isPackagedMcpExecutable("node.exe"), false);
});
