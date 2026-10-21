import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("runtime MCP verifier isolates the candidate from the installed runtime", () => {
  const source = readFileSync(new URL("./verify-runtime-mcp.mjs", import.meta.url), "utf8");
  assert.match(source, /mkdtempSync\(join\(tmpdir\(\),\s*["']m9r-runtime-mcp-/);
  assert.match(source, /env:\s*\{\s*\.\.\.process\.env,\s*M9R_HOME:\s*smokeHome/);
  assert.match(source, /rmSync\(smokeHome,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)/);
});
