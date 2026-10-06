// Desktop shell: the pill running in the Tauri window. State is the engine's feed (read by the Rust side, which already
// merges feed.json and web-activity.json); owner decisions go to the same commands the current overlay uses. No npm
// dependency: Tauri's invoke is on the window object.
//
// Typed messages go through the overlay's `send_message` command, which hands them to the engine's own human-typed send.
// The window hooks tell the Rust side where the island is (everything around it is click-through), when it has folded
// away (the window shrinks to a wake strip) and when the message field needs the keyboard. They apply when the overlay
// runs in one-pill mode (M9R_PILL_NEXT=1); the Rust side validates every value.

import type { Decision, DesktopStage, DesktopStageActionProof, DesktopStageCapture, DesktopStageCursorMove, DesktopStageWindowOption, PillTransport, SessionRow } from "../core/transport";
import { fromFeed, type Feed } from "./convert";

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export function tauriInvoke(): Invoke | null {
  const internals = (globalThis as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__;
  return typeof internals?.invoke === "function" ? internals.invoke : null;
}

const POLL_MS = 1000;

export function createDesktopTransport(invoke: Invoke): PillTransport {
  let feed: Feed | null = null;

  type StageAction = "list" | "create" | "activate" | "return" | "capture" | "cursor" | "windows" | "attach" | "click" | "type" | "scroll" | "drag" | "allow-agent" | "allow-control" | "revoke-agent";
  async function stageRequest(action: StageAction, name?: string, args: Record<string, unknown> = {}): Promise<{
    stages?: DesktopStage[];
    capture?: DesktopStageCapture;
    cursorMove?: DesktopStageCursorMove;
    windows?: DesktopStageWindowOption[];
    actionProof?: DesktopStageActionProof;
  }> {
    const raw = await invoke("desktop_stage_action", { action, ...(name ? { name } : {}), ...args });
    if (!raw || typeof raw !== "object") throw new Error("The desktop stage command returned an invalid response.");
    const response = raw as { ok?: unknown; error?: unknown; stages?: unknown; capture?: unknown; cursor?: unknown; windows?: unknown; outcome?: unknown };
    if (response.ok !== true) throw new Error(typeof response.error === "string" ? response.error : "The desktop stage command failed.");
    if (action === "list") {
      if (!Array.isArray(response.stages)) throw new Error("The desktop stage command returned an invalid stage list.");
      return { stages: response.stages as DesktopStage[] };
    }
    if (action === "windows") {
      if (!Array.isArray(response.windows)) throw new Error("The desktop stage command returned an invalid window list.");
      const windows = response.windows.flatMap((rawWindow): DesktopStageWindowOption[] => {
        if (!rawWindow || typeof rawWindow !== "object") return [];
        const window = rawWindow as Partial<DesktopStageWindowOption>;
        if (!Number.isSafeInteger(window.pid) || (window.pid ?? 0) < 1 || typeof window.windowId !== "string" || !/^\d{1,20}$/.test(window.windowId)
          || !/[^0]/.test(window.windowId) || typeof window.appName !== "string" || typeof window.title !== "string"
          || !Number.isInteger(window.width) || (window.width ?? 0) < 80 || !Number.isInteger(window.height) || (window.height ?? 0) < 60) return [];
        return [{ pid: window.pid!, windowId: window.windowId, appName: window.appName.slice(0, 80), title: window.title.slice(0, 160), width: window.width!, height: window.height! }];
      });
      return { windows };
    }
    if (["capture", "cursor", "click", "type", "scroll", "drag"].includes(action)) {
      const capture = response.capture as Partial<DesktopStageCapture> | undefined;
      if (!capture || typeof capture.dataUrl !== "string" || !/^data:image\/(?:png|jpeg);base64,/.test(capture.dataUrl)
        || !Number.isInteger(capture.width) || !Number.isInteger(capture.height) || typeof capture.capturedAt !== "string") {
        throw new Error("The desktop stage command returned an invalid local stage snapshot.");
      }
      if (action === "capture") return { capture: capture as DesktopStageCapture };
      if (action === "cursor") {
        const cursor = response.cursor as { x?: unknown; y?: unknown; enabled?: unknown } | undefined;
        if (!cursor || !Number.isFinite(cursor.x) || !Number.isFinite(cursor.y) || cursor.enabled !== true) {
          throw new Error("The desktop stage command returned an invalid cursor confirmation.");
        }
        return { cursorMove: { capture: capture as DesktopStageCapture, cursor: cursor as DesktopStageCursorMove["cursor"] } };
      }
      const outcome = response.outcome as { status?: unknown; route?: unknown; summary?: unknown } | undefined;
      const allowed = ["confirmed", "partial", "unverifiable", "suspected-noop", "unverified"];
      if (!outcome || !allowed.includes(String(outcome.status)) || (outcome.route !== undefined && !Number.isInteger(outcome.route))) {
        throw new Error("The desktop stage command returned no valid Cua Driver action outcome.");
      }
      return {
        actionProof: {
          capture: capture as DesktopStageCapture,
          outcome: {
            status: outcome.status as DesktopStageActionProof["outcome"]["status"],
            ...(typeof outcome.route === "number" ? { route: outcome.route } : {}),
            ...(typeof outcome.summary === "string" ? { summary: outcome.summary.slice(0, 180) } : {}),
          },
        },
      };
    }
    return {};
  }

  return {
    capabilities: { allowForADay: true, linkSessions: true, saveMemory: true },
    desktopStages: /Windows/i.test(navigator.userAgent) ? {
      async setAgentPermission(handle, enabled, control = false) { await stageRequest(enabled ? (control ? "allow-control" : "allow-agent") : "revoke-agent", handle); },
      async list() { return (await stageRequest("list")).stages ?? []; },
      async create(name) { await stageRequest("create", name); },
      async activate(name) { await stageRequest("activate", name); },
      async returnToOwner(name) { await stageRequest("return", name); },
      async capture(name) { const result = await stageRequest("capture", name); return result.capture!; },
      async moveCursor(name, x, y) { const result = await stageRequest("cursor", name, { x, y }); return result.cursorMove!; },
      async windows(name) { return (await stageRequest("windows", name)).windows ?? []; },
      async attachWindow(name, pid, windowId) { await stageRequest("attach", name, { pid, windowId }); },
      async click(name, x, y) { return (await stageRequest("click", name, { x, y })).actionProof!; },
      async typeText(name, text) { return (await stageRequest("type", name, { text })).actionProof!; },
      async scroll(name, x, y, direction) { return (await stageRequest("scroll", name, { x, y, direction })).actionProof!; },
      async drag(name, fromX, fromY, toX, toY) { return (await stageRequest("drag", name, { fromX, fromY, toX, toY })).actionProof!; },
    } : undefined,
    async listSessions(handle) {
      const raw = await invoke("list_sessions", { handle });
      const rows = typeof raw === "string" ? JSON.parse(raw) : [];
      return (Array.isArray(rows) ? rows : []).flatMap((r: Partial<SessionRow>) => typeof r?.sessionId === "string" ? [{ sessionId: r.sessionId, cwd: typeof r.cwd === "string" ? r.cwd : undefined, lastSeenAt: String(r.lastSeenAt ?? "") }] : []);
    },
    async linkSession(offer, toSession) {
      if (!offer.fromSession) throw new Error("This message has no session to link from.");
      await invoke("link_sessions", { fromHandle: offer.from, fromSession: offer.fromSession, toHandle: offer.to, toSession });
    },
    subscribe(listener) {
      let last = "";
      const tick = async () => {
        try {
          const raw = (await invoke("read_feed")) as string | null;
          if (raw && raw !== last) {
            last = raw;
            feed = JSON.parse(raw) as Feed;
            listener(fromFeed(feed));
          }
        } catch { /* feed missing or mid-write: keep the last good state and try again */ }
      };
      void tick();
      const timer = setInterval(() => void tick(), POLL_MS);
      return () => clearInterval(timer);
    },
    async send(text) {
      const reply = await invoke("send_message", { text });
      return typeof reply === "string" ? reply.trim().slice(0, 300) : undefined;
    },
    async saveMemory(text) {
      await invoke("save_memory", { text });
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
      const need = feed?.needsYou?.find((n) => n.kind === "approval" && n.taskId === approvalId);
      const from = need && "from" in need ? need.from : undefined;
      const to = need && "to" in need ? need.to : undefined;
      await invoke("decide", { taskId: approvalId, action: decision === "deny" ? "deny" : decision === "allow_day" ? "allow_day" : "approve", from, to });
    },
  };
}
