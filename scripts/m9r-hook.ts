/**
 * The program an agent runs for each hook event: `node m9r-hook.js <Event> <provider>`, event JSON on stdin.
 * Kept deliberately tiny (it imports only the native cores, never the big CLI) because it runs before every prompt.
 * Prints one JSON object or nothing, and always exits 0: a broken M9R must never block or slow someone's prompt.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createLocalStore, defaultStoreRoot } from "@/lib/native/local-store";
import { handleHookEvent, type HookInput } from "@/lib/native/hook-handler";

try {
  const [event, provider = "claude-code"] = process.argv.slice(2);
  let input: HookInput = {};
  try { input = JSON.parse(readFileSync(0, "utf8")) as HookInput; } catch { /* no or invalid stdin: fall back to the argument */ }
  if (!input.hook_event_name && event) input.hook_event_name = event;
  const store = createLocalStore(defaultStoreRoot(homedir(), process.env));
  const result = handleHookEvent(input, { provider, store });
  if (result) process.stdout.write(JSON.stringify(result));
} catch {
  /* silent by design */
}
process.exit(0);
