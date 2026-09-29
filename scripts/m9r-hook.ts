/**
 * The program an agent runs for each hook event: `node m9r-hook.js <Event> <provider>`, event JSON on stdin.
 * Kept deliberately tiny (it imports only the native cores, never the big CLI) because it runs before every prompt.
 * Prints one JSON object or nothing, and always exits 0: a broken M9R must never block or slow someone's prompt.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createLocalStore, defaultStoreRoot } from "@/lib/native/local-store";
import { isAgentContext } from "@/lib/native/approval-core";
import type { HookInput } from "@/lib/native/hook-handler";
import { armRawMentionHookCapture, runHookRequest } from "@/lib/native/hook-run";
import { deliverToCodex, pushAnswerToCodex, realDeps } from "@/lib/native/codex-delivery";

async function main() {
  const [event, provider = "claude-code", extra] = process.argv.slice(2);
  if (event === "arm-raw-mention-capture") {
    if (isAgentContext(process.env) || !process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write("Arming raw mention capture requires an interactive human terminal.\n");
      return;
    }
    const root = defaultStoreRoot(homedir(), process.env);
    const armed = armRawMentionHookCapture(root);
    process.stdout.write(armed
      ? "Armed one local capture: the next Claude typed mention's exact hook payload will be saved once under .m9r/diagnostics.\n"
      : "A one-shot raw mention capture is already armed under .m9r/diagnostics.\n");
    return;
  }
  // Runner mode (started detached by a hook): push one task into Codex, then exit. Never prints.
  if (event === "queue" && extra) { await deliverToCodex(createLocalStore(defaultStoreRoot(homedir(), process.env)), extra, realDeps()); return; }
  if (event === "answer" && extra) { const d = realDeps(); await pushAnswerToCodex(createLocalStore(defaultStoreRoot(homedir(), process.env)), extra, d); return; }
  let input: HookInput | null = null;
  let rawPayload: string | undefined;
  try { rawPayload = readFileSync(0, "utf8"); input = JSON.parse(rawPayload) as HookInput; } catch { /* no or invalid stdin: fall back to the argument */ }
  const text = await runHookRequest({ event: event ?? "", provider, input, rawPayload }, process.argv[1] ?? "");
  if (text) process.stdout.write(text);
}

main().catch(() => { /* silent by design */ }).finally(() => process.exit(0));
