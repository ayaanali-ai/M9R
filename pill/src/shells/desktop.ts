// Desktop shell: the pill running in the Tauri window. State is the engine's feed (read by the Rust side, which already
// merges feed.json and web-activity.json); owner decisions go to the same commands the current overlay uses. No npm
// dependency: Tauri's invoke is on the window object.
//
// Typed messages go through the overlay's `send_message` command, which hands them to the engine's own human-typed send.
// The window hooks tell the Rust side where the island is (everything around it is click-through), when it has folded
// away (the window shrinks to a wake strip) and when the message field needs the keyboard. They apply when the overlay
// runs in one-pill mode (M9R_PILL_NEXT=1); the Rust side validates every value.

import type { Decision, PillTransport } from "../core/transport";
import { listen, TauriEvent } from "@tauri-apps/api/event";
import type { SpeechEnv } from "../core/speech";
import type { Settings } from "../core/state";
import { fromUiState, type UiState } from "./convert";

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export function tauriInvoke(): Invoke | null {
  const internals = (globalThis as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__;
  return typeof internals?.invoke === "function" ? internals.invoke : null;
}

const POLL_MS = 1000;

export function createDesktopTransport(invoke: Invoke): PillTransport {
  type NativeSpeechHandlers = NonNullable<SpeechEnv["native"]> extends { start(handlers: infer T): Promise<void> } ? T : never;
  let nativeSpeechHandlers: NativeSpeechHandlers | null = null;
  let nativeSpeechListeners: Promise<void> | null = null;
  const ensureNativeSpeechListeners = () => {
    nativeSpeechListeners ??= Promise.all([
      listen<string>("dictation-interim", ({ payload }) => nativeSpeechHandlers?.interim(payload)),
      listen<string>("dictation-final", ({ payload }) => nativeSpeechHandlers?.final(payload)),
      listen("dictation-ended", () => { const handlers = nativeSpeechHandlers; nativeSpeechHandlers = null; handlers?.ended(); }),
      listen<string>("dictation-error", ({ payload }) => { const handlers = nativeSpeechHandlers; nativeSpeechHandlers = null; handlers?.error(payload); }),
      listen<string>("dictation-unavailable", ({ payload }) => { const handlers = nativeSpeechHandlers; nativeSpeechHandlers = null; handlers?.error(payload); }),
    ]).then(() => undefined).catch((error) => { nativeSpeechListeners = null; throw error; });
    return nativeSpeechListeners;
  };
  const desktopNativeSpeechEnv = (openMicSetup: () => void): SpeechEnv => ({
    Recognition: null,
    lang: navigator.language || "en-US",
    openMicSetup,
    native: {
      async start(handlers) {
        await ensureNativeSpeechListeners();
        nativeSpeechHandlers = handlers;
        await invoke("start_dictation");
      },
      stop() {
        void invoke("stop_dictation").catch((error) => {
          const current = nativeSpeechHandlers;
          nativeSpeechHandlers = null;
          current?.error(error instanceof Error ? error.message : "Windows dictation could not stop cleanly.");
        });
      },
    },
  });

  return {
    // The desktop runtime owns long-lived provider processes. Session linking
    // belongs only to the legacy extension transport and must not surface here.
    capabilities: { allowForADay: false, dictation: true, saveMemory: true, dismissTask: true },
    createDictationEnvironment() { return desktopNativeSpeechEnv(() => { void invoke("open_microphone_settings").catch(() => {}); }); },
    subscribe(listener) {
      let lastPillState = "";
      let connection: "connected" | "disconnected" = "disconnected";
      const tick = async () => {
        try {
          // The resident owner broker publishes the only authoritative desktop
          // state envelope. Do not fall back to the historical session/feed
          // transport: that path can resurrect stale provider-session state and
          // make the pill appear to regress after a restart.
          const pillState = (await invoke("read_pill_state")) as string | null;
          if (!pillState) {
            // A stale/missing envelope means the broker is no longer the
            // authoritative owner. Emit a connection-only transition so the
            // renderer cannot keep showing the last connected state forever.
            if (connection !== "disconnected") {
              connection = "disconnected";
              lastPillState = "";
              listener({ agents: [], approvals: [], thread: [], connection, connectionOnly: true });
            }
            return;
          }
          if (pillState !== lastPillState || connection !== "connected") {
            lastPillState = pillState;
            connection = "connected";
            listener({ ...fromUiState(JSON.parse(pillState) as UiState), connection });
          }
        } catch {
          if (connection !== "disconnected") {
            connection = "disconnected";
            lastPillState = "";
            listener({ agents: [], approvals: [], thread: [], connection, connectionOnly: true });
          }
        }
      };
      void tick();
      const timer = setInterval(() => void tick(), POLL_MS);
      return () => clearInterval(timer);
    },
    async send(text) {
      const reply = await invoke("send_message", { text });
      return typeof reply === "string" ? reply.trim().slice(0, 300) : undefined;
    },
    async selectModel(handle, model, effort) {
      await invoke("select_model", { handle, model, effort });
    },
    async saveMemory(text) {
      await invoke("save_memory", { text });
    },
    saveSettings(settings) {
      void invoke("save_settings", { soundEnabled: settings.soundEnabled, soundVolume: settings.soundVolume, autoCloseInterval: settings.autoCloseInterval }).catch(() => { /* the running settings still apply; only persistence failed */ });
    },
    async loadSettings() {
      const raw = await invoke("load_settings").catch(() => null) as { soundEnabled?: boolean | null; soundVolume?: number | null; autoCloseInterval?: number | null } | null;
      if (!raw) return;
      const out: Partial<Settings> = {};
      if (typeof raw.soundEnabled === "boolean") out.soundEnabled = raw.soundEnabled;
      if (typeof raw.soundVolume === "number" && Number.isFinite(raw.soundVolume)) out.soundVolume = raw.soundVolume;
      if (typeof raw.autoCloseInterval === "number" && Number.isFinite(raw.autoCloseInterval)) out.autoCloseInterval = raw.autoCloseInterval;
      return out;
    },
    async dismissTask(taskId) {
      await invoke("dismiss_task", { taskId });
    },
    // Tauri owns file drops on this window (the page never sees them), and it hands over real paths agents can open.
    onFileDrop(handlers) {
      type Pos = { position?: { x: number; y: number } };
      const at = (p: Pos) => ({ x: (p.position?.x ?? 0) / devicePixelRatio, y: (p.position?.y ?? 0) / devicePixelRatio });
      const name = (path: string) => path.split(/[\\/]/).pop() || path;
      void listen<Pos>(TauriEvent.DRAG_ENTER, ({ payload }) => { const p = at(payload); handlers.over(p.x, p.y); });
      void listen<Pos>(TauriEvent.DRAG_OVER, ({ payload }) => { const p = at(payload); handlers.over(p.x, p.y); });
      void listen(TauriEvent.DRAG_LEAVE, () => handlers.leave());
      void listen<Pos & { paths?: string[] }>(TauriEvent.DRAG_DROP, ({ payload }) => {
        const p = at(payload);
        const files = (payload.paths ?? []).slice(0, 10).map((path) => ({ name: name(path), path }));
        if (files.length) handlers.drop(files, p.x, p.y);
        else handlers.leave();
      });
    },
    setIslandRect(x, y, width, height) {
      void invoke("pill_set_rect", { x, y, width, height }).catch(() => { /* a rejected rectangle keeps the last good one */ });
    },
    setCollapsed(collapsed) {
      void invoke("pill_set_collapsed", { collapsed }).catch(() => { /* the window keeps its size */ });
    },
    focusWindow(focused) {
      void invoke("pill_set_focus", { focused }).catch(() => { /* typing falls back to clicking the field */ });
    },
    async decide(approvalId: string, decision: Decision) {
      if (decision === "allow_day") throw new Error("Allow-for-a-day is not available on the broker-owned desktop path.");
      await invoke("pill_decide", { approvalId, decision });
    },
  };
}
