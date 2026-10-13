import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ripgrepSearch } from "@/lib/bridge/governed-agent-tools";

test("a search pattern that looks like a ripgrep flag is treated as a literal pattern, not parsed as one", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-rg-flag-"));
  try {
    writeFileSync(join(root, "haystack.txt"), "nothing matches this pattern literally\n");
    // Before the "--" fix, ripgrep reads a pattern starting with "--" as its own flag. "--help" is the
    // clearest proof: unfixed, rg recognizes it and prints its usage banner instead of searching;
    // fixed, "--" ends option parsing and ripgrep searches the file for the literal text "--help",
    // which isn't on disk, so the tool returns a normal (empty-ish) no-match result instead.
    let output: string;
    try {
      output = await ripgrepSearch(root, "--help", "haystack.txt", false, 10);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // rg isn't on PATH in this environment; nothing to verify here.
      throw error;
    }
    assert.ok(!/Usage:\s*rg/i.test(output), `pattern was parsed as a real ripgrep flag instead of a literal search string:\n${output}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
