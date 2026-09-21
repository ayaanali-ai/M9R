/**
 * Manual smoke test (uses real provider subscriptions, so it never runs in `npm test`):
 * does a session M9R starts through its ACP adapter show up in the provider's own native history?
 *
 *   NATIVE_HISTORY_SMOKE=1 node --disable-warning=ExperimentalWarning --import ./scripts/register-alias.mjs scripts/native-history-smoke.ts [claude-code|codex|opencode ...]
 *
 * Each provider gets one trivial prompt in a fresh temp directory. Output is PASS/FAIL per provider.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeAcpAdapter, createCodexAcpAdapter, createOpenCodeAcpAdapter, type AcpStdioProviderAdapter } from "@/lib/bridge/acp-stdio-adapter";

if (process.env.NATIVE_HISTORY_SMOKE !== "1") {
  console.log("Set NATIVE_HISTORY_SMOKE=1 to run. This starts real Claude/Codex/OpenCode sessions and uses your subscriptions.");
  process.exit(0);
}

function findFile(root: string, predicate: (name: string) => boolean, depth = 6): string | null {
  if (!existsSync(root) || depth < 0) return null;
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    let isDir = false;
    try { isDir = statSync(full).isDirectory(); } catch { continue; }
    if (isDir) { const hit = findFile(full, predicate, depth - 1); if (hit) return hit; }
    else if (predicate(entry)) return full;
  }
  return null;
}

const checks: Record<string, { make: () => AcpStdioProviderAdapter; inHistory: (id: string) => string | null }> = {
  "claude-code": {
    make: () => createClaudeAcpAdapter(),
    inHistory: (id) => findFile(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects"), (name) => name === `${id}.jsonl`),
  },
  codex: {
    make: () => createCodexAcpAdapter(),
    inHistory: (id) => findFile(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions"), (name) => name.endsWith(".jsonl") && name.includes(id)),
  },
  opencode: {
    make: () => createOpenCodeAcpAdapter(),
    inHistory: (id) => {
      // `session list` is scoped to the current project, so ask for the session by id instead.
      try {
        const out = execFileSync(process.platform === "win32" ? "opencode.cmd" : "opencode", ["export", id], { encoding: "utf8", shell: process.platform === "win32", stdio: ["ignore", "pipe", "ignore"] });
        return out.includes(id) ? `opencode export ${id}` : null;
      } catch {
        return null;
      }
    },
  },
};

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(checks);
let failed = 0;
for (const kind of wanted) {
  const check = checks[kind];
  if (!check) { console.log(`SKIP ${kind}: unknown provider`); continue; }
  const cwd = mkdtempSync(join(tmpdir(), `m9r-history-${kind}-`));
  const assignment = { missionId: "history-smoke", dispatchKey: "history-smoke", goal: "history smoke", executionConstraints: {} };
  const adapter = check.make();
  try {
    const server = await adapter.launchServer({ assignment, environment: { workingDirectory: cwd, kind: "disposable" } });
    await adapter.initialize(server);
    const session = await adapter.createSession({ server, assignment });
    for await (const _event of adapter.prompt({ session, text: "Reply with exactly the word ok. Do not use any tools." })) { /* drain */ }
    const ref = session.providerSessionRef;
    await adapter.closeSession({ session });
    await adapter.shutdown(server);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const where = ref ? check.inHistory(ref) : null;
    console.log(`${where ? "PASS" : "FAIL"} ${kind}: session ${ref ?? "(none reported)"} ${where ? `found in ${where}` : "NOT found in native history"}`);
    if (!where) failed += 1;
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${kind}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
process.exit(failed ? 1 : 0);
