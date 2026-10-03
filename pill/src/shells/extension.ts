// Browser shell: the pill running inside an extension frame. State comes from the service worker's existing bridge
// (a long-lived port that carries the broker's ui-state) and owner commands go back through the same validated path
// the current pill uses, so the trust rules (nonce-bound frames only) are unchanged.

import type { Decision, PillTransport } from "../core/transport";
import { fromUiState, type UiState } from "./convert";

interface ChromeRuntime {
  id?: string;
  connect(info: { name: string }): {
    onMessage: { addListener(fn: (m: unknown) => void): void };
    onDisconnect: { addListener(fn: () => void): void };
  };
  sendMessage(message: unknown): Promise<{ ok?: boolean; error?: string } | undefined>;
}

export function chromeRuntime(): ChromeRuntime | null {
  const c = (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome;
  return c?.runtime?.id ? c.runtime : null;
}

export function createExtensionTransport(runtime: ChromeRuntime): PillTransport {
  async function command(cmd: Record<string, unknown>) {
    let reply: { ok?: boolean; error?: string } | undefined;
    try {
      reply = await runtime.sendMessage({ type: "m9r-pill-cmd", command: cmd });
    } catch (error) {
      const text = String(error instanceof Error ? error.message : error);
      // A page opened before the extension was reloaded keeps a frame that can no longer reach it.
      throw new Error(/context invalidated|receiving end does not exist/i.test(text) ? "M9R was reloaded. Refresh this page and try again." : text);
    }
    if (!reply?.ok) throw new Error(reply?.error || "the local M9R broker is not connected");
  }

  return {
    // The bridge has no "allow for a day" for in-page approvals; the button is hidden rather than silently meaning "once".
    capabilities: { allowForADay: false, dictation: true, saveMemory: true },
    openMicSetup() { void runtime.sendMessage({ type: "m9r-pill-open-mic-setup" }).catch(() => {}); },
    subscribe(listener) {
      const connect = () => {
        let port: ReturnType<ChromeRuntime["connect"]>;
        try {
          port = runtime.connect({ name: "m9r-pill" });
        } catch {
          setTimeout(connect, 1500);
          return;
        }
        port.onMessage.addListener((message) => {
          const m = message as { type?: string } | null;
          if (m && m.type === "ui-state") listener(fromUiState(m as UiState));
        });
        port.onDisconnect.addListener(() => setTimeout(connect, 1000));
      };
      connect();
    },
    send: (text) => command({ type: "ui-command", text }),
    saveMemory: (text) => command({ type: "ui-save-note", text }),
    decide: (approvalId: string, decision: Decision) =>
      command({ type: decision === "deny" ? "ui-deny" : "ui-approve", id: approvalId }),
  };
}
