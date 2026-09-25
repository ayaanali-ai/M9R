/**
 * The program an agent runs for each hook event: `node m9r-hook.js <Event> <provider>`, event JSON on stdin.
 * Kept deliberately tiny (it imports only the native cores, never the big CLI) because it runs before every prompt.
 * Prints one JSON object or nothing, and always exits 0: a broken M9R must never block or slow someone's prompt.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createLocalStore, defaultStoreRoot } from "@/lib/native/local-store";
import type { HookInput } from "@/lib/native/hook-handler";
import { runHookRequest } from "@/lib/native/hook-run";
import { deliverToCodex, pushAnswerToCodex, realDeps } from "@/lib/native/codex-delivery";

async function main() {
  const [event, provider = "claude-code", extra] = process.argv.slice(2);
  // Runner mode (started detached by a hook): push one task into Codex, then exit. Never prints.
  if (event === "queue" && extra) { await deliverToCodex(createLocalStore(defaultStoreRoot(homedir(), process.env)), extra, realDeps()); return; }
  if (event === "answer" && extra) { const d = realDeps(); await pushAnswerToCodex(createLocalStore(defaultStoreRoot(homedir(), process.env)), extra, d); return; }
  let input: HookInput | null = null;
  try { input = JSON.parse(readFileSync(0, "utf8")) as HookInput; } catch { /* no or invalid stdin: fall back to the argument */ }
  const text = runHookRequest({ event: event ?? "", provider, input }, process.argv[1] ?? "");
  if (text) process.stdout.write(text);
}

main().catch(() => { /* silent by design */ }).finally(() => process.exit(0));
