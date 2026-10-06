// The pill talks to its host only through this interface. The desktop shell and the browser shell each provide an adapter;
// in a plain browser tab (npm run dev) the mock below stands in so the UI can be developed and inspected alone.

import type { LinkOffer, PillSnapshot, Settings } from "./state";

export type Decision = "allow" | "deny" | "allow_day";

export interface SessionRow {
  sessionId: string;
  cwd?: string;
  lastSeenAt: string;
}

export interface DesktopStage {
  name: string;
  desktopId: string;
  returnToDesktopId: string | null;
  hasAnchor?: boolean;
  isCurrent: boolean;
  status: "current" | "background" | "unavailable";
  /** Local-only identity for the agent session mapped to this Windows stage. */
  agentAssignment?: { handle: string; sessionTag: string };
  error?: string;
}

export interface DesktopStageCapture {
  dataUrl: string;
  width: number;
  height: number;
  capturedAt: string;
}

export interface DesktopStageCursor {
  x: number;
  y: number;
  enabled: true;
}

export interface DesktopStageCursorMove {
  capture: DesktopStageCapture;
  cursor: DesktopStageCursor;
}

export interface DesktopStageWindowOption {
  pid: number;
  windowId: string;
  appName: string;
  title: string;
  width: number;
  height: number;
}

export interface DesktopStageActionOutcome {
  status: "confirmed" | "partial" | "unverifiable" | "suspected-noop" | "unverified";
  route?: number;
  summary?: string;
}

export interface DesktopStageActionProof {
  capture: DesktopStageCapture;
  outcome: DesktopStageActionOutcome;
}

/** Local Windows virtual-desktop controls. Only the native desktop shell supplies this capability. */
export interface DesktopStageTransport {
  setAgentPermission?(handle: string, enabled: boolean, control?: boolean): Promise<void>;
  list(): Promise<DesktopStage[]>;
  create(name: string): Promise<void>;
  activate(name: string): Promise<void>;
  returnToOwner(name: string): Promise<void>;
  capture(name: string): Promise<DesktopStageCapture>;
  moveCursor(name: string, x: number, y: number): Promise<DesktopStageCursorMove>;
  windows(name: string): Promise<DesktopStageWindowOption[]>;
  attachWindow(name: string, pid: number, windowId: string): Promise<void>;
  click(name: string, x: number, y: number): Promise<DesktopStageActionProof>;
  typeText(name: string, text: string): Promise<DesktopStageActionProof>;
  scroll(name: string, x: number, y: number, direction: "up" | "down"): Promise<DesktopStageActionProof>;
  drag(name: string, fromX: number, fromY: number, toX: number, toY: number): Promise<DesktopStageActionProof>;
}

export interface PillTransport {
  /** What this host can actually do; the UI hides controls a host cannot honour instead of faking them. */
  capabilities?: { allowForADay?: boolean; linkSessions?: boolean; dictation?: boolean; saveMemory?: boolean };
  /** Present only in the Windows desktop pill; the browser pill cannot control this machine's desktops. */
  desktopStages?: DesktopStageTransport;
  /** Opens the one-time microphone setup. Only with `capabilities.dictation`. */
  openMicSetup?(): void;
  /** Sessions the engine knows for one agent, for the link picker. Only with `capabilities.linkSessions`. */
  listSessions?(handle: string): Promise<SessionRow[]>;
  /** Always route future messages from `offer.from` to this session of `offer.to`. Rejects with a sentence the owner can read. */
  linkSession?(offer: LinkOffer, toSession: string): Promise<void>;
  /** Starts delivering snapshots. The first call should arrive promptly with the current state. */
  subscribe(listener: (snapshot: PillSnapshot) => void): void | (() => void);
  /** Owner typed a message; `@handle` mentions inside it address agents. */
  /** May resolve to a short confirmation to show in the thread. Rejects with a sentence the owner can read. */
  send(text: string): Promise<string | void>;
  decide(approvalId: string, decision: Decision): Promise<void>;
  /** Saves a reply to the team's shared memory. Only with `capabilities.saveMemory`. */
  saveMemory?(text: string): Promise<void>;
  /** Window-level hooks; no-ops in the browser shell. */
  setIslandRect?(x: number, y: number, width: number, height: number): void;
  setCollapsed?(collapsed: boolean): void;
  /** The other pill is showing; hide this one (browser shell). Called only when the answer changes. */
  setSuppressed?(suppressed: boolean): void;
  focusWindow?(focused: boolean): void;
  saveSettings?(settings: Settings): void;
}

declare global {
  interface Window {
    /** Set by a shell before the bundle loads. */
    __M9R_PILL_TRANSPORT__?: PillTransport;
  }
}

export const IN_HOST = typeof window !== "undefined" && window.__M9R_PILL_TRANSPORT__ !== undefined;

const SAMPLE: PillSnapshot = {
  agents: [
    { handle: "claude", provider: "claude", state: "working", activity: ["Opened the shared tab", "Reading the pricing table", "Comparing plans for the summary"] },
    { handle: "codex", provider: "codex", state: "idle", activity: ["Finished the broker fix"] },
    { handle: "opencode", provider: "opencode", state: "waiting", activity: ["Waiting for @claude's answer"] },
  ],
  approvals: [],
  thread: [],
};

/** Developer mock: a few agents, an approval that appears after a while, and echoed replies. */
export function createMockTransport(): PillTransport {
  let listener: ((s: PillSnapshot) => void) | null = null;
  const snap: PillSnapshot = structuredClone(SAMPLE);
  const push = () => listener?.(structuredClone(snap));
  const params = new URLSearchParams(location.search);
  if (params.has("approval")) {
    snap.approvals.push({ id: "a1", agent: "codex", title: "Post to the page", detail: "Click “Post” on x.com/compose" });
  } else if (!params.has("calm")) {
    setTimeout(() => {
      snap.approvals.push({ id: "a1", agent: "codex", title: "Post to the page", detail: "Click “Post” on x.com/compose" });
      push();
    }, 9000);
  }
  return {
    capabilities: { allowForADay: true },
    subscribe(l) { listener = l; setTimeout(push, 0); },
    async send(text) {
      const target = /@(\w+)/.exec(text)?.[1] ?? "claude";
      snap.thread.push({ id: `t${snap.thread.length + 1}`, from: target, text: `Got it: “${text.replace(/@\w+\s*/g, "").slice(0, 80)}”` });
      const agent = snap.agents.find((a) => a.handle === target);
      if (agent) { agent.state = "working"; agent.activity.push("Working on your message"); }
      push();
    },
    async decide(id) {
      snap.approvals = snap.approvals.filter((a) => a.id !== id);
      push();
    },
  };
}

export function getTransport(): PillTransport {
  return window.__M9R_PILL_TRANSPORT__ ?? createMockTransport();
}
