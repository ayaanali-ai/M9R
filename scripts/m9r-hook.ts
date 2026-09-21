/**
 * The program an agent runs for each hook event: `node m9r-hook.js <Event> <provider>`, event JSON on stdin.
 * Kept deliberately tiny (it imports only the native cores, never the big CLI) because it runs before every prompt.
 * Prints one JSON object or nothing, and always exits 0: a broken M9R must never block or slow someone's prompt.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createLocalStore, defaultStoreRoot } from "@/lib/native/local-store";
import { handleHookEvent, type HookInput } from "@/lib/native/hook-handler";
import { collectCodexResults, deliverToCodex, realDeps, spawnDeliveryRunner } from "@/lib/native/codex-delivery";

async function main() {
  const [event, provider = "claude-code", extra] = process.argv.slice(2);
  const store = createLocalStore(defaultStoreRoot(homedir(), process.env));
  // Runner mode (started detached by a hook): push one task into Codex, then exit. Never prints.
  if (event === "queue" && extra) { await deliverToCodex(store, extra, realDeps()); return; }
  const entry = process.argv[1] ?? "";
  const deps = realDeps();
  let input: HookInput = {};
  try { input = JSON.parse(readFileSync(0, "utf8")) as HookInput; } catch { /* no or invalid stdin: fall back to the argument */ }
  if (!input.hook_event_name && event) input.hook_event_name = event;
  const result = handleHookEvent(input, { provider, store, dispatch: (id) => spawnDeliveryRunner(entry, id), collect: () => { collectCodexResults(store, deps); } });
  if (result) process.stdout.write(JSON.stringify(result));
}

main().catch(() => { /* silent by design */ }).finally(() => process.exit(0));
