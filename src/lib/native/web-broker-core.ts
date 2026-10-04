/**
 * Web broker core (spike, docs: M9R_DEMO_BUILD_PLAN_2026-09-23.md Phase 1-2). Pure logic, no sockets: an agent's
 * browser command goes in through submit(), the connected extension does the work and answers through
 * onExtensionMessage(). Two things live here so they cannot be bypassed by the transport: per-tab claims and
 * fair, scope-aware turns for conflicting writers; and the presence label the overlay draws, derived from the
 * command that really ran rather than reported by the agent.
 */

import { originOf, pathOf, type WebAuthority } from "./web-authority-core";
import { redactSecrets } from "./inbox-core";
import { classifyWebActionRisk } from "./risk-core";
import { narrateStep, type WebActivity } from "./web-ui-bridge";
import { classifyPowerRisk, describePower, extraTimeoutFor, grantActionFor, isPowerAction, powerScopeFor, sanitizeLabel, validatePowerRequest, type WebPowerAction, type WebPowerArgs } from "./web-powers-core";
import { createTurnScheduler, type TurnScheduler, type TurnSchedulerLane } from "./turn-scheduler-core";

export type WebAction = "open" | "read" | "click" | "type" | WebPowerAction;

const ACTIONS: readonly WebAction[] = ["open", "read", "click", "type"];

export const MAX_SELECTOR_LENGTH = 500;
export const MAX_TEXT_LENGTH = 5_000;
export const MAX_READ_LENGTH = 4_000;

export interface WebRequest {
  agent: string;
  provider: string;
  sessionId: string;
  /** Owner of the requesting agent when it belongs to someone other than this browser's owner. */
  owner?: string;
  action: WebAction;
  tab?: string;
  url?: string;
  selector?: string;
  /** Destination for drag gestures; validated by web-powers-core. */
  endSelector?: string;
  /** Untrusted, optional visible-control label used only for risk classification and owner review. */
  targetLabel?: string;
  /** Optional stable parent-form selector used only to coordinate field claims. */
  formSelector?: string;
  /** A click can explicitly reserve a form; opens and submit-like clicks always reserve the tab. */
  claimScope?: { kind: "form"; key: string };
  /** Named M9R handles allowed to act within this claim until it expires. */
  shareWith?: string[];
  text?: string;
  /** Parameters for the power actions (web-powers-core.ts); refused on open/read/click/type. */
  args?: WebPowerArgs;
  /** Internal batch marker: the ordered operation owns one tab claim for its entire sequence. */
  batchClaim?: boolean;
}

export interface WebResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
  /** Accessible name or nearest visible text of the target (the page title for page-level actions), max 80 chars. */
  label?: string;
  /** What teammates did since this agent's last action (newest last, at most 5): the shared-room awareness. */
  room?: string[];
  /** Compact state returned after a batched action; controls carry unique snapshot-scoped refs. */
  pageState?: WebPageState;
  /** Bounded text that changed since the previous state in the same batched call. */
  changedPart?: string;
}

export interface WebPageControl {
  ref: string;
  role: string;
  name: string;
  position: number;
}

export interface WebPageState {
  url: string;
  title: string;
  topControls: WebPageControl[];
}

export interface WebBatchStep {
  action: "open" | "click" | "type" | "press" | "scroll";
  tab?: string;
  url?: string;
  selector?: string;
  targetLabel?: string;
  formSelector?: string;
  text?: string;
  args?: WebPowerArgs;
}

export interface WebBatchRequest {
  agent: string;
  provider: string;
  sessionId: string;
  owner?: string;
  tab?: string;
  shareWith?: string[];
  steps: WebBatchStep[];
  includePageState?: boolean;
}

export interface WebBatchStepResult {
  index: number;
  action: WebBatchStep["action"];
  response: WebResponse;
}

export interface WebBatchResponse {
  ok: boolean;
  steps: WebBatchStepResult[];
  failedAt?: number;
  changedPart?: string;
}

/** How much the owner is asked. Money and secrets are held in every mode. */
export type RoomMode = "watch" | "ask" | "hands-off";
export const ROOM_MODES: readonly RoomMode[] = ["watch", "ask", "hands-off"];

/**
 * watch: agents act freely on the shared page; only things that leave it (post, message, buy, upload, download, and send/delete-like
 * controls) ask. ask: every risky action asks. hands-off: nothing asks except money and secrets.
 */
export function autoAllowedInMode(mode: RoomMode, request: { action: string; selector?: string; targetLabel?: string }, risk: { risky: boolean; category?: string }): boolean {
  if (!risk.risky) return true;
  if (mode === "ask") return false;
  if (risk.category === "money" || risk.category === "secrets") return false;
  if (request.action === "adopt") return false; // which tab an agent may work in stays the owner's call, in every mode
  if (mode === "hands-off") return true;
  if (["post", "dm", "follow", "like", "download", "upload", "buy"].includes(request.action)) return false;
  if (["click_at", "drag", "drop"].includes(request.action)) return true;
  // Everything else was flagged by what the control says (Send, Delete, Pay...), and a page-level submit such as a search box
  // is fine unless its own label reads like one of those.
  if (request.action === "submit") return !classifyWebActionRisk({ action: "click", selector: request.selector, targetLabel: request.targetLabel }).risky;
  return false;
}

export interface WebBrokerDeps {
  send(message: unknown): boolean;
  /** CDP input owns one pointer/focus per tab: serialize every writer through a tab lane. */
  oneWriterPerTab?: boolean;
  /** Current room mode; absent means every risky action asks (the original behavior). */
  roomMode?(): RoomMode;
  ownerId?: string;
  authority?: WebAuthority;
  onAuthorityChange?(): void;
  now?: () => number;
  timeoutMs?: number;
  claimTtlMs?: number;
  /** Stops runaway agents: a repeat limit for identical state-changing actions and an action budget per window. Off unless set. */
  loopGuard?: { repeat: number; budget: number; windowMs: number };
  approvalTimeoutMs?: number;
  newId?: () => string;
  /** Adds plain-words `step` and `phase` to presence frames and sends a 'done' notice after each result. */
  narrate?: boolean;
  /** In-process activity stream for the UI bridge (web-ui-bridge.ts). */
  onActivity?(activity: WebActivity): void;
}

function parseSnapshotState(data: unknown, urlHint?: string): { state: WebPageState; visibleText: string } | null {
  const snapshotRefPattern = /^e[a-f0-9]{24}_\d{1,3}$/;
  if (data && typeof data === "object") {
    const snapshot = data as { url?: unknown; title?: unknown; text?: unknown; elements?: unknown };
    const url = typeof snapshot.url === "string" ? snapshot.url : urlHint || "";
    const title = typeof snapshot.title === "string" ? snapshot.title : "";
    const visibleText = typeof snapshot.text === "string" ? snapshot.text.trim().slice(0, 4_000) : "";
    const controls: WebPageControl[] = [];
    if (Array.isArray(snapshot.elements)) {
      for (const element of snapshot.elements.slice(0, 12)) {
        if (!element || typeof element !== "object") continue;
        const candidate = element as { ref?: unknown; role?: unknown; name?: unknown };
        if (typeof candidate.ref !== "string" || !snapshotRefPattern.test(candidate.ref)
          || typeof candidate.role !== "string" || typeof candidate.name !== "string") continue;
        controls.push({ ref: candidate.ref, role: candidate.role.slice(0, 40), name: candidate.name.slice(0, 160), position: controls.length + 1 });
      }
    }
    if (!url && !title && !visibleText && controls.length === 0) return null;
    return { state: { url, title, topControls: controls }, visibleText };
  }
  if (typeof data !== "string") return null;
  const url = data.match(/^URL:\s*(.*)$/m)?.[1]?.trim() || urlHint || "";
  const title = data.match(/^Title:\s*(.*)$/m)?.[1]?.trim() || "";
  if (!url && !title && !data.includes("Controls (act by ")) return null;
  const controls: WebPageControl[] = [];
  const controlPattern = /^(e[a-f0-9]{24}_\d{1,3})\s+\[([^\]]+)\]\s+"([^"]*)"[^\n]*$/gm;
  let match: RegExpExecArray | null;
  while ((match = controlPattern.exec(data)) && controls.length < 12) {
    controls.push({ ref: match[1], role: match[2], name: match[3], position: controls.length + 1 });
  }
  const textStart = data.indexOf("Text:");
  const controlsStart = data.indexOf("Controls (act by ref");
  const visibleText = textStart >= 0 ? data.slice(textStart + 5, controlsStart >= textStart ? controlsStart : undefined).trim().slice(0, 4_000) : "";
  return { state: { url, title, topControls: controls }, visibleText };
}

function changedText(previous: string, next: string): string | undefined {
  if (!next || next === previous) return undefined;
  if (!previous) return next.slice(0, 4_000);
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start += 1;
  let endPrevious = previous.length - 1;
  let endNext = next.length - 1;
  while (endPrevious >= start && endNext >= start && previous[endPrevious] === next[endNext]) { endPrevious -= 1; endNext -= 1; }
  return next.slice(start, endNext + 1).trim().slice(0, 4_000) || undefined;
}

export interface WebAgentMessage {
  agent: string;
  provider: string;
  sessionId: string;
  owner?: string;
  to: string;
  messageId: string;
  text: string;
}

export type WebClaimScope =
  | { kind: "tab"; key: "*" }
  | { kind: "form"; key: string }
  | { kind: "field"; key: string; formKey?: string };

interface Claim {
  agent: string;
  participantId: string;
  provider: string;
  sessionId: string;
  expiresAt: number;
  scope: WebClaimScope;
  sharedWith: Set<string>;
}

interface Pending {
  resolve: (response: WebResponse) => void;
  timer: ReturnType<typeof setTimeout>;
  tab: string;
  actorTabsKey: string;
  action: WebAction;
  addedOpenCandidate: boolean;
  expectedOrigin?: string;
  expectedPathPrefix?: string;
  request?: WebRequest;
  presence?: Record<string, unknown>;
  claimKey?: string;
  participantId: string;
  turnLaneKey?: string;
  turnToken?: string;
}

interface TurnParticipant {
  agent: string;
  provider: string;
  sessionId: string;
}

interface QueuedTurn {
  request: WebRequest;
  resolve: (response: WebResponse) => void;
}

interface TurnLane {
  key: string;
  tab: string;
  scope: WebClaimScope;
  scheduler: TurnSchedulerLane;
  participants: Map<string, TurnParticipant>;
  queues: Map<string, QueuedTurn[]>;
  activeParticipantId: string | null;
  activeTokens: Set<string>;
  activeQueued?: QueuedTurn;
}

interface TurnDispatchContext {
  laneKey: string;
  participantId: string;
  token: string;
}

function fail(error: string): WebResponse {
  return { ok: false, error };
}

function describe(request: WebRequest): string {
  switch (request.action) {
    case "open": {
      try {
        return `opening ${new URL(request.url ?? "").host}`;
      } catch {
        return "opening a page";
      }
    }
    case "read":
      return request.selector ? `reading ${request.selector}` : "reading the page";
    case "click":
      return `clicking ${request.selector}`;
    case "type":
      return `typing in ${request.selector}`;
    default:
      return describePower(request);
  }
}

const SEARCH_QUERY_PARAMS = new Set(["q", "query", "search", "search_query", "searchterm", "keyword", "keywords", "term"]);

/**
 * A search opened as a URL (`/search?q=...`) skips what teammates are meant to watch: the search box being used. Agents open a
 * site's own page and search through its control, like a person. Returns the refusal text, or null when the URL is fine.
 */
export function searchDeepLinkProblem(url: string | undefined): string | null {
  let parsed: URL;
  try { parsed = new URL(url ?? ""); } catch { return null; }
  const params = [...parsed.searchParams.keys()].map((key) => key.toLowerCase());
  const hasQuery = params.some((key) => SEARCH_QUERY_PARAMS.has(key)) || (params.includes("s") && /^\/(search)?\/?$/.test(parsed.pathname));
  if (!hasQuery) return null;
  return "Do this the way a person would: open the site's own page (for example its home page), take a snapshot, click the page's search box, type the query with m9r_web_type and press Enter with m9r_web_press. A search URL skips the steps your teammates and the owner are meant to see.";
}

export function validateRequest(request: WebRequest): string | null {
  if (!request.agent || typeof request.agent !== "string") return "missing agent";
  if (!ACTIONS.includes(request.action) && !isPowerAction(request.action)) return `unknown action ${String(request.action)}`;
  if (request.tab !== undefined && !/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(request.tab)) {
    return "tab must be 1-40 letters, digits, dashes or underscores";
  }
  if (isPowerAction(request.action)) {
    const problem = validatePowerRequest(request as unknown as Parameters<typeof validatePowerRequest>[0]);
    if (problem) return problem;
  } else if (request.args !== undefined) return `${request.action} does not take args`;
  if (request.action === "open") {
    let parsed: URL;
    try {
      parsed = new URL(request.url ?? "");
    } catch {
      return "open needs a valid url";
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "only http and https urls can be opened";
  }
  if ((request.action === "click" || request.action === "type") && !request.selector) return `${request.action} needs a selector`;
  if (request.selector !== undefined && request.selector.length > MAX_SELECTOR_LENGTH) return "selector is too long";
  if (request.targetLabel !== undefined && (typeof request.targetLabel !== "string" || request.targetLabel.length > 200)) return "target label is too long";
  if (request.formSelector !== undefined && (!request.formSelector.trim() || request.formSelector.length > MAX_SELECTOR_LENGTH)) return "form selector is invalid";
  if (request.claimScope !== undefined && (request.claimScope.kind !== "form" || !request.claimScope.key.trim() || request.claimScope.key.length > MAX_SELECTOR_LENGTH)) return "claim scope is invalid";
  if (request.shareWith !== undefined && (!Array.isArray(request.shareWith) || request.shareWith.length > 16 || request.shareWith.some((name) => typeof name !== "string" || !/^[A-Za-z0-9_.-]{1,80}$/.test(name)))) return "shared agent names are invalid";
  if (request.action === "type" && typeof request.text !== "string") return "type needs text";
  if (request.text !== undefined && request.text.length > MAX_TEXT_LENGTH) return "text is too long";
  return null;
}

export function createWebBroker(deps: WebBrokerDeps) {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 15_000;
  const doneNoticeAckTimeoutMs = 1_000;
  const claimTtlMs = deps.claimTtlMs ?? 8_000;
  const approvalTimeoutMs = Math.min(10 * 60_000, Math.max(1, deps.approvalTimeoutMs ?? 120_000));
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const claims = new Map<string, Claim>();
  const pending = new Map<string, Pending>();
  const turnSchedulersByTab = new Map<string, TurnScheduler>();
  const turnLanes = new Map<string, TurnLane>();
  const tabUrls = new Map<string, string>();
  // URLs an agent may open directly: exact URLs the owner typed to it, and pages this room has already been on.
  const ownerUrls = new Set<string>();
  const visitedUrls = new Set<string>();
  const flatUrl = (value: string): string => { try { const u = new URL(value); u.hash = ""; return `${u.origin}${u.pathname.replace(/\/+$/, "")}${u.search}`; } catch { return ""; } };
  const rememberVisit = (value: string | undefined): void => { const flat = value ? flatUrl(value) : ""; if (flat) visitedUrls.add(flat); };
  function noteOwnerUrls(text: string): void {
    for (const match of String(text).matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) { const flat = flatUrl(match[0]); if (flat) ownerUrls.add(flat); }
  }
  /**
   * A person who wants a page on a site they are already using clicks or searches; they do not jump by URL. Once a site is open in
   * the room, an agent may open a page of it by URL only when the owner typed that URL or the room has already been there.
   */
  function sameSiteJumpProblem(target: string | undefined): string | null {
    const wanted = target ? flatUrl(target) : "";
    if (!wanted || ownerUrls.has(wanted) || visitedUrls.has(wanted)) return null;
    let origin: string;
    try { origin = new URL(wanted).origin; } catch { return null; }
    const open = [...tabUrls.values()].some((known) => { try { return new URL(known).origin === origin; } catch { return false; } });
    if (!open) return null;
    return "This site is already open in the room. Move around it the way a person does: take a snapshot, then click its links or use its search box (m9r_web_type, then m9r_web_press Enter). A page of an open site can be opened by URL only when the owner typed that exact URL to you.";
  }
  const tabsByActor = new Map<string, Set<string>>();
  const focusedTabByActor = new Map<string, string>();
  const openedBy = new Map<string, string>();
  const tabLastActivity = new Map<string, number>();
  // Shared-room awareness: what each agent did, so every agent's next reply can carry what its teammates did meanwhile.
  const roomLog: Array<{ seq: number; agent: string; actorKey: string; tab: string; action: string; text: string }> = [];
  let roomSeq = 0;
  const roomCursor = new Map<string, number>();
  const tabLastBy = new Map<string, string>();
  function roomEventsFor(actor: string, actorKey: string): string[] | undefined {
    const since = roomCursor.get(actorKey) ?? 0;
    const actorTabs = tabsByActor.get(actorKey) ?? new Set<string>();
    const changes = roomLog.filter(event => event.seq > since && event.actorKey !== actorKey && actorTabs.has(event.tab) && !["read", "snapshot", "screenshot", "tabs"].includes(event.action));
    // Keep the newest change per teammate/tab, bounded to three short facts.
    const latest = new Map<string, typeof roomLog[number]>();
    for (const event of changes) latest.set(`${event.agent}:${event.tab}`, event);
    const events = [...latest.values()].sort((a, b) => a.seq - b.seq).slice(-3).map(event => event.text.slice(0, 240));
    roomCursor.set(actorKey, roomSeq);
    return events.length ? events : undefined;
  }
  const presenceByTab = new Map<string, Map<string, Record<string, unknown>>>();
  const hiddenMessageSessions = new Set<string>();
  const typedValuesBySession = new Map<string, Array<{ value: string; expiresAt: number }>>();
  const seenMessageIds = new Set<string>();
  const recent: Array<Record<string, unknown>> = [];
  let feedSequence = 0;
  let stopState: { state: "running" | "stopped"; stoppedAt: number | null; stoppedBy: string | null } = {
    state: "running", stoppedAt: null, stoppedBy: null,
  };
  interface ApprovalEntry {
    id: string;
    actor: string;
    request: WebRequest;
    risk: string;
    origin?: string;
    createdAt: number;
    expiresAt: number;
    resolve: (response: WebResponse) => void;
    timer: ReturnType<typeof setTimeout>;
  }
  interface DoneNoticeAckEntry {
    tab: string;
    agent: string;
    provider: string;
    sessionId: string;
    resolve: (rendered: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  }
  const approvals = new Map<string, ApprovalEntry>();
  const doneNoticeAcks = new Map<string, DoneNoticeAckEntry>();
  let doneNoticeSequence = 0;
  const narrate = deps.narrate === true;
  const emit = (activity: WebActivity) => {
    try { deps.onActivity?.(activity); } catch { /* the UI must never break the broker */ }
  };

  function advanceFeed(): void {
    feedSequence += 1;
  }

  function activityKey(agent: string, provider: string, sessionId: string): string {
    return JSON.stringify([agent, provider, sessionId]);
  }

  function recordPresence(tab: string, presence: Record<string, unknown>, owner?: string): void {
    const key = activityKey(String(presence.agent ?? ""), String(presence.provider ?? ""), String(presence.sessionId ?? ""));
    const records = presenceByTab.get(tab) ?? new Map<string, Record<string, unknown>>();
    const record: Record<string, unknown> = { ...presence, owner: owner ?? deps.ownerId ?? "you", tab, updatedAt: now() };
    records.set(key, record);
    presenceByTab.set(tab, records);
    tabLastActivity.set(tab, now());
    advanceFeed();
    recent.unshift({
      seq: feedSequence,
      at: new Date(now()).toISOString(),
      tab,
      agent: record.agent,
      provider: record.provider,
      owner: record.owner,
      action: record.action,
      message: record.message,
      messageKind: record.messageKind ?? "activity",
      sessionId: record.sessionId,
      to: record.to,
      showMessageText: record.showMessageText,
    });
    if (recent.length > 50) recent.length = 50;
  }

  function sessionTypedValues(sessionId: string): Array<{ value: string; expiresAt: number }> {
    const values = (typedValuesBySession.get(sessionId) ?? []).filter((entry) => entry.expiresAt > now());
    typedValuesBySession.set(sessionId, values);
    return values;
  }

  function addTypedValue(sessionId: string, value: string | undefined): void {
    if (!value) return;
    // Ordinary lowercase search words are not secrets; redacting them would blank them out of the whole thread.
    if (/^[\p{L}][\p{L} ]{0,30}$/u.test(value)) return;
    const values = sessionTypedValues(sessionId);
    values.push({ value, expiresAt: now() + Math.max(claimTtlMs, 60_000) });
    while (values.length > 32) values.shift();
    typedValuesBySession.set(sessionId, values);
  }

  function redactTypedValues(sessionId: string, text: string): string {
    let safe = redactSecrets(text);
    for (const { value } of sessionTypedValues(sessionId).sort((a, b) => b.value.length - a.value.length)) {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      try {
        safe = safe.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "gu"), "$1[redacted]");
      } catch {
        // An unexpected value is omitted from the preview rather than interpolated unsafely.
        return "[message preview hidden]";
      }
    }
    return safe;
  }

  function scopeFor(request: WebRequest): WebClaimScope | null {
    if (request.batchClaim && request.action !== "read") return { kind: "tab", key: "*" };
    const powerScope = powerScopeFor(request as unknown as Parameters<typeof powerScopeFor>[0]);
    if (powerScope !== undefined) return powerScope;
    if (request.action === "read") return null;
    if (request.action === "type") return { kind: "field", key: request.selector!, ...(request.formSelector ? { formKey: request.formSelector } : {}) };
    if (request.action === "open" || (request.action === "click" && /(?:submit|checkout|purchase|buy|pay|send|delete|remove|confirm|place[-_ ]?order)/i.test(request.selector ?? ""))) return { kind: "tab", key: "*" };
    if (request.action === "click" && request.claimScope?.kind === "form") return { kind: "form", key: request.claimScope.key };
    return { kind: "tab", key: "*" };
  }

  function scopesOverlap(a: WebClaimScope, b: WebClaimScope): boolean {
    if (a.kind === "tab" || b.kind === "tab") return true;
    if (a.kind === "form" && b.kind === "form") return a.key === b.key;
    if (a.kind === "form" && b.kind === "field") return b.formKey === a.key;
    if (a.kind === "field" && b.kind === "form") return a.formKey === b.key;
    return a.kind === "field" && b.kind === "field" && a.key === b.key;
  }

  function activeClaims(tab: string): Claim[] {
    const active: Claim[] = [];
    for (const [claimKey, claim] of claims) {
      if (!claimKey.startsWith(`${tab}\u0000`)) continue;
      if (claim.expiresAt <= now()) claims.delete(claimKey);
      else active.push(claim);
    }
    return active;
  }

  function claimKey(tab: string, scope: WebClaimScope): string {
    return `${tab}\u0000${scope.kind}\u0000${scope.kind === "tab" ? "*" : scope.key}`;
  }

  function turnParticipantId(actor: string, request: WebRequest): string {
    return JSON.stringify([actor, request.provider, request.sessionId]);
  }

  function turnParticipant(actor: string, request: WebRequest): TurnParticipant {
    return { agent: actor, provider: request.provider, sessionId: request.sessionId };
  }

  function registerTurnParticipant(lane: TurnLane, actor: string, request: WebRequest): string {
    const id = turnParticipantId(actor, request);
    if (!lane.participants.has(id)) {
      lane.participants.set(id, turnParticipant(actor, request));
      lane.scheduler.register(id, { burstSize: (request.provider ?? "").toLowerCase().includes("codex") ? 4 : 1 });
    }
    return id;
  }

  function schedulerForTab(tab: string): TurnScheduler {
    let scheduler = turnSchedulersByTab.get(tab);
    if (!scheduler) {
      scheduler = createTurnScheduler({ now });
      turnSchedulersByTab.set(tab, scheduler);
    }
    return scheduler;
  }

  function turnLaneForClaim(tab: string, claim: Claim): TurnLane {
    const key = claimKey(tab, claim.scope);
    let lane = turnLanes.get(key);
    if (lane) return lane;
    lane = {
      key,
      tab,
      scope: claim.scope,
      scheduler: schedulerForTab(tab).forLane(key),
      participants: new Map(),
      queues: new Map(),
      activeParticipantId: null,
      activeTokens: new Set(),
    };
    lane.participants.set(claim.participantId, {
      agent: claim.agent,
      provider: claim.provider,
      sessionId: claim.sessionId,
    });
    lane.scheduler.register(claim.participantId, { burstSize: (claim.provider ?? "").toLowerCase().includes("codex") ? 4 : 1 });
    const inFlight = [...pending.entries()].filter(([, entry]) => entry.claimKey === key);
    lane.activeParticipantId = inFlight.length > 0 ? claim.participantId : null;
    lane.scheduler.setPending(claim.participantId, inFlight.length > 0);
    if (inFlight.length > 0) lane.scheduler.requestTurn(claim.participantId);
    for (const [token, entry] of inFlight) {
      entry.turnLaneKey = key;
      entry.turnToken = token;
      lane.activeTokens.add(token);
    }
    turnLanes.set(key, lane);
    return lane;
  }

  function turnLaneIsBusy(lane: TurnLane): boolean {
    return lane.activeTokens.size > 0 || [...lane.queues.values()].some((queue) => queue.length > 0);
  }

  function sendTurnNotice(tab: string, participant: TurnParticipant, message: string, phase: "waiting" | "done", scope?: WebClaimScope): void {
    deps.send({
      type: "notice",
      tab,
      presence: {
        id: newId(),
        agent: participant.agent,
        provider: participant.provider,
        sessionId: participant.sessionId,
        action: message,
        message,
        step: message,
        phase,
        ...(phase === "waiting" ? { blocked: true } : {}),
        claimed: false,
        claimMs: 0,
        ...(scope ? { claimScope: scope } : {}),
      },
    });
  }

  function updateTurnClaim(lane: TurnLane, participant: TurnParticipant): void {
    const claim = claims.get(lane.key);
    if (!claim) return;
    claim.agent = participant.agent;
    claim.participantId = JSON.stringify([participant.agent, participant.provider, participant.sessionId]);
    claim.provider = participant.provider;
    claim.sessionId = participant.sessionId;
    claim.expiresAt = now() + claimTtlMs;
  }

  function completeTurnLane(laneKey: string, token: string): void {
    const lane = turnLanes.get(laneKey);
    if (!lane || !lane.activeTokens.delete(token) || lane.activeTokens.size > 0) return;
    const departingId = lane.activeParticipantId;
    lane.activeParticipantId = null;
    lane.activeQueued = undefined;
    if (!departingId) return;

    const remaining = lane.queues.get(departingId)?.length ?? 0;
    lane.scheduler.setPending(departingId, remaining > 0);
    lane.scheduler.recordAction(departingId);
    const nextId = lane.scheduler.currentHolder();
    if (nextId && nextId !== departingId) {
      const departing = lane.participants.get(departingId);
      const next = lane.participants.get(nextId);
      if (departing && next) sendTurnNotice(lane.tab, departing, `Go @${next.agent}, I'm done for now`, "done");
    }
    pumpTurnLane(lane);
  }

  function pumpTurnLane(lane: TurnLane): void {
    if (lane.activeTokens.size > 0) return;
    const holderId = lane.scheduler.currentHolder();
    if (!holderId) return;
    const queue = lane.queues.get(holderId);
    if (!queue?.length) {
      lane.scheduler.setPending(holderId, false);
      if (lane.scheduler.currentHolder() !== holderId) pumpTurnLane(lane);
      return;
    }
    if (!lane.scheduler.requestTurn(holderId).granted) return;

    const queued = queue.shift()!;
    if (queue.length === 0) lane.queues.delete(holderId);
    lane.scheduler.setPending(holderId, true);
    const participant = lane.participants.get(holderId);
    if (!participant) {
      queued.resolve(fail("the scheduled browser turn no longer has an agent"));
      lane.scheduler.setPending(holderId, false);
      pumpTurnLane(lane);
      return;
    }
    updateTurnClaim(lane, participant);
    const token = `turn-${newId()}`;
    lane.activeParticipantId = holderId;
    lane.activeQueued = queued;
    lane.activeTokens.add(token);
    void dispatch(queued.request, { laneKey: lane.key, participantId: holderId, token }).then(
      (response) => {
        queued.resolve(response);
        completeTurnLane(lane.key, token);
      },
      () => {
        queued.resolve(fail("the scheduled browser action failed"));
        completeTurnLane(lane.key, token);
      },
    );
  }

  function queueTurnRequest(lane: TurnLane, request: WebRequest, actor: string): Promise<WebResponse> {
    return new Promise((resolve) => {
      const participantId = registerTurnParticipant(lane, actor, request);
      const queue = lane.queues.get(participantId) ?? [];
      queue.push({ request, resolve });
      lane.queues.set(participantId, queue);
      lane.scheduler.setPending(participantId, true);
      const holderId = lane.scheduler.currentHolder();
      if (holderId && holderId !== participantId) {
        const holder = lane.participants.get(holderId);
        if (holder) {
          const message = `Waiting on @${holder.agent}`;
          sendTurnNotice(lane.tab, turnParticipant(actor, request), message, "waiting", lane.scope);
        }
      }
      pumpTurnLane(lane);
    });
  }

  function cancelTurnLane(lane: TurnLane, error: string): void {
    for (const queue of lane.queues.values()) for (const queued of queue) queued.resolve(fail(error));
    lane.queues.clear();
    lane.activeQueued?.resolve(fail(error));
    lane.activeQueued = undefined;
    lane.activeTokens.clear();
    lane.activeParticipantId = null;
    for (const participantId of lane.participants.keys()) lane.scheduler.setPending(participantId, false);
    turnLanes.delete(lane.key);
  }

  function cancelTurnLanesForTab(tab: string, error: string): void {
    for (const lane of [...turnLanes.values()]) if (lane.tab === tab) cancelTurnLane(lane, error);
    turnSchedulersByTab.delete(tab);
  }

  function cancelAllTurnLanes(error: string): void {
    for (const lane of [...turnLanes.values()]) cancelTurnLane(lane, error);
    turnSchedulersByTab.clear();
  }

  function actorTabsKey(request: WebRequest): string {
    return `${request.owner ?? deps.ownerId ?? ""}\u0000${request.agent}\u0000${request.provider}\u0000${request.sessionId}`;
  }

  function rememberTab(actorKey: string, tab: string): void {
    const tabs = tabsByActor.get(actorKey) ?? new Set<string>();
    tabs.add(tab);
    tabsByActor.set(actorKey, tabs);
  }

  function forgetTab(actorKey: string, tab: string): void {
    const tabs = tabsByActor.get(actorKey);
    tabs?.delete(tab);
    if (tabs?.size === 0) tabsByActor.delete(actorKey);
  }

  function resolveTab(request: WebRequest): { tab: string; actorKey: string; publicName: string } | { error: string } {
    const crossOwner = request.owner !== undefined && request.owner !== deps.ownerId;
    const actorKey = actorTabsKey(request);
    const namespace = (name: string) => crossOwner ? `${request.owner}/${name}` : name;
    if (request.tab !== undefined) return { tab: namespace(request.tab), actorKey, publicName: request.tab };

    const openTabs = [...(tabsByActor.get(actorKey) ?? [])];
    // m9r_web_switch picks the tab later tab-less calls use; listing tabs never needs a choice.
    const focused = focusedTabByActor.get(actorKey);
    if (openTabs.length > 1 && focused && openTabs.includes(focused)) return { tab: focused, actorKey, publicName: crossOwner ? focused.slice(request.owner!.length + 1) : focused };
    if (openTabs.length > 1 && request.action !== "tabs") return { error: "multiple tabs are open for this agent; specify tab to choose one" };
    if (openTabs.length === 1) {
      const tab = openTabs[0];
      return { tab, actorKey, publicName: crossOwner ? tab.slice(request.owner!.length + 1) : tab };
    }
    // Nothing of its own yet: work on the page the room is already on (one shared tab) instead of starting a private one.
    // Opening still starts the agent's own tab, and several shared tabs still need a choice.
    if (request.action !== "open" && request.action !== "tabs" && !crossOwner && tabUrls.size === 1) {
      const [shared] = [...tabUrls.keys()];
      return { tab: shared, actorKey, publicName: shared };
    }
    return { tab: namespace(request.agent), actorKey, publicName: request.agent };
  }

  // Loop guard state: per session, the last state-changing action signature and recent action times.
  const recentActs = new Map<string, { sig: string; count: number; times: number[] }>();
  function loopProblem(request: WebRequest): string | null {
    const guard = deps.loopGuard;
    // Observing the page never changes it, so it cannot loop: a snapshot with a different query looks identical to the guard, and
    // an agent re-snapshotting after a page change was being told it was stuck.
    if (!guard || ["read", "find", "wait", "tabs", "snapshot", "screenshot", "extract", "link", "copy"].includes(request.action)) return null;
    const key = String(request.sessionId ?? request.agent);
    const at = now();
    const entry = recentActs.get(key) ?? { sig: "", count: 0, times: [] };
    entry.times = entry.times.filter((time) => at - time < guard.windowMs);
    if (entry.times.length >= guard.budget) return `action budget reached (${guard.budget} in ${Math.round(guard.windowMs / 60000)} minutes); stop and tell the owner what you did and what is left`;
    const sig = [request.action, request.tab, request.url, request.selector, request.text].join("\0");
    entry.count = entry.sig === sig ? entry.count + 1 : 1;
    entry.sig = sig;
    entry.times.push(at);
    recentActs.set(key, entry);
    if (entry.count >= guard.repeat) return `you have done this exact ${request.action} ${entry.count} times in a row; it either already worked (check with a read) or it will not work. Try a different approach, ask a teammate, or finish`;
    return null;
  }

  function dispatch(request: WebRequest, turnContext?: TurnDispatchContext): Promise<WebResponse> {
    if (stopState.state === "stopped") return Promise.resolve(fail("browser actions are stopped by the owner; restart the local broker to resume"));
    const problem = validateRequest(request);
    if (problem) return Promise.resolve(fail(problem));
    const looping = loopProblem(request);
    if (looping) return Promise.resolve(fail(looping));

    const crossOwner = request.owner !== undefined && request.owner !== deps.ownerId;
    // A guest's tabs are namespaced by owner, so a guest agent can never land in one of the host's own tabs.
    const resolvedTab = resolveTab(request);
    if ("error" in resolvedTab) return Promise.resolve(fail(resolvedTab.error));
    const { tab, actorKey } = resolvedTab;
    const actor = crossOwner ? `${request.agent}@${request.owner}` : request.agent;
    const participantId = turnParticipantId(actor, request);
    const publicTab = (name: string) => crossOwner && name.startsWith(`${request.owner}/`) ? name.slice(request.owner!.length + 1) : name;
    if (request.action === "switch" && !tabsByActor.get(actorKey)?.has(tab) && !tabUrls.has(tab) && !openedBy.has(tab)) return Promise.resolve(fail(`tab "${resolvedTab.publicName}" is not open in the room; m9r_web_tabs lists every tab`));
    if (request.action === "close" && openedBy.get(tab) !== actorKey) return Promise.resolve(fail(`tab "${resolvedTab.publicName}" was not opened by you; you can only close tabs you opened`));
    const powerFields = request.action === "tabs"
      ? { tabs: [...new Set<string>([...tabUrls.keys(), ...openedBy.keys(), ...(tabsByActor.get(actorKey) ?? [])])]
          .filter((name) => !crossOwner || name.startsWith(`${request.owner}/`))
          .map((name) => ({ tab: name, name: publicTab(name), opened: openedBy.get(name) === actorKey, url: tabUrls.get(name), lastBy: tabLastBy.get(name), mine: tabsByActor.get(actorKey)?.has(name) ?? false })) }
      : {};

    let expectOrigin: string | undefined;
    let expectPathPrefix: string | undefined;
    if (crossOwner) {
      if (!deps.authority) return Promise.resolve(fail("cross-owner actions are not enabled on this browser"));
      const currentUrl = request.action === "open" ? request.url : tabUrls.get(tab);
      const origin = originOf(currentUrl);
      if (!origin) return Promise.resolve(fail("open the page first so its site can be checked against your grant"));
      const decision = deps.authority.check({
        grantee: { owner: request.owner as string, agent: request.agent },
        action: grantActionFor(request.action, request as unknown as Parameters<typeof grantActionFor>[1]),
        origin,
        path: pathOf(currentUrl ?? undefined) ?? undefined,
        selector: request.selector,
      });
      try {
        deps.onAuthorityChange?.();
      } catch {
        return Promise.resolve(fail("web authority audit could not be persisted; the action was refused"));
      }
      if (!decision.allowed) return Promise.resolve(fail(decision.reason));
      expectOrigin = origin;
      expectPathPrefix = deps.authority.grants().find((grant) => grant.id === decision.grantId)?.pathPrefix;
    }

    if (request.action === "tabs") {
      // The room list is answered here, from what every agent has done, so it never depends on the extension.
      const room = roomEventsFor(actor, actorKey);
      return Promise.resolve({ ok: true, data: powerFields.tabs ?? [], ...(room ? { room } : {}) });
    }

    // A shared page is a shared document: opening a page a teammate already has open in this tab joins it instead of reloading it
    // (a reload would erase what the teammate is typing).
    if (request.action === "open" && !crossOwner && request.url && (tabsByActor.get(actorKey)?.has(tab) || openedBy.has(tab))) {
      const flat = (value: string | undefined) => String(value ?? "").replace(/#.*$/, "").replace(/\/+$/, "");
      const known = tabUrls.get(tab);
      if (known && flat(known) === flat(request.url)) {
        rememberTab(actorKey, tab);
        let host = "";
        try { host = new URL(known).host; } catch { /* the step text falls back to a plain phrase */ }
        deps.send({
          type: "notice",
          tab,
          presence: { id: newId(), agent: actor, provider: request.provider, action: "joined this page", message: "joined this page", claimed: false, claimMs: 0, phase: "done", step: host ? `Joined ${host}` : "Joined the page", target: undefined },
        });
        return Promise.resolve({ ok: true, data: { tab, url: known, note: "This page is already open in that tab; you joined it without reloading. Read it, or click and type in it: teammates may be here too." } });
      }
    }

    const deepLink = request.action === "open" ? searchDeepLinkProblem(request.url) : null;
    if (deepLink) return Promise.resolve(fail(deepLink));
    const siteJump = request.action === "open" && !crossOwner ? sameSiteJumpProblem(request.url) : null;
    if (siteJump) return Promise.resolve(fail(siteJump));

    const scope = scopeFor(request);
    const requestedScope: WebClaimScope | null = scope && deps.oneWriterPerTab ? { kind: "tab", key: "*" } : scope;
    if (requestedScope && !(request.action === "open" && !crossOwner)) {
      const activeLane = [...turnLanes.values()].find((lane) => lane.tab === tab && lane.key !== turnContext?.laneKey && turnLaneIsBusy(lane) && scopesOverlap(lane.scope, requestedScope));
      const activeLaneClaim = activeLane ? claims.get(activeLane.key) : undefined;
      const mayShareActiveClaim = activeLaneClaim?.agent !== actor && activeLaneClaim?.sharedWith.has(actor) === true;
      if (activeLane && (deps.oneWriterPerTab || !mayShareActiveClaim)) return queueTurnRequest(activeLane, request, actor);
    }
    let claimHolder: Claim | undefined;
    let commandClaimKey: string | undefined;
    if (requestedScope) {
      const conflicting = activeClaims(tab).find((claim) => scopesOverlap(claim.scope, requestedScope) && claim.agent !== actor && !claim.sharedWith.has(actor));
      if (conflicting && request.action === "open" && !crossOwner) {
        // Navigating a tab another agent is using would yank the page from under them: open a fresh tab instead.
        const base = `${request.tab}-${actor.replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 60);
        let fresh = base;
        for (let n = 2; tabsByActor.get(actorKey)?.has(fresh) || activeClaims(fresh).length > 0 || openedBy.has(fresh); n += 1) fresh = `${base}-${n}`;
        return dispatch({ ...request, tab: fresh }).then((response) => response.ok
          ? { ...response, data: { ...((typeof response.data === "object" && response.data) || {}), tab: fresh, note: `@${conflicting.agent} is using tab "${request.tab}", so this opened in a new tab "${fresh}". Use "${fresh}" for your next actions.` } as never }
          : response);
      }
      if (conflicting) {
        const lane = turnLaneForClaim(tab, conflicting);
        return queueTurnRequest(lane, request, actor);
      }
      const key = claimKey(tab, requestedScope);
      commandClaimKey = key;
      const existing = claims.get(key);
      const sharedWith = new Set(existing?.sharedWith ?? []);
      if (!existing || existing.agent === actor) for (const name of request.shareWith ?? []) sharedWith.add(name);
      claimHolder = existing && existing.agent !== actor ? existing : {
        agent: actor,
        participantId,
        provider: request.provider,
        sessionId: request.sessionId,
        scope: requestedScope,
        sharedWith,
        expiresAt: now() + claimTtlMs,
      };
      claimHolder.expiresAt = now() + claimTtlMs;
      if (claimHolder.agent === actor) {
        claimHolder.sharedWith = sharedWith;
        claimHolder.participantId = participantId;
        claimHolder.provider = request.provider;
        claimHolder.sessionId = request.sessionId;
      }
      claims.set(key, claimHolder);
    }

    const id = newId();
    const addedOpenCandidate = request.action === "open" && !(tabsByActor.get(actorKey)?.has(tab) ?? false);
    if (request.action === "open") rememberTab(actorKey, tab);
    const message = {
      type: "command",
      id,
      action: request.action,
      tab,
      url: request.url,
      selector: request.selector,
      text: request.text,
      ...(request.endSelector ? { endSelector: request.endSelector } : {}),
      ...(request.args ? { args: request.args } : {}),
      ...powerFields,
      expectOrigin,
      expectPathPrefix,
      // Presence summaries are derived from the action only; never include request.text or page values.
      presence: {
        id,
        agent: actor,
        provider: request.provider,
        sessionId: request.sessionId,
        owner: request.owner ?? deps.ownerId ?? "you",
        action: describe(request),
        message: describe(request),
        claimed: requestedScope !== null,
        claimMs: requestedScope !== null ? claimTtlMs : 0,
        target: request.selector ? { selector: request.selector } : undefined,
        ...(requestedScope ? { claimScope: requestedScope } : {}),
        ...(claimHolder?.sharedWith.size ? { sharedWith: [...claimHolder.sharedWith].sort() } : {}),
        ...(narrate ? { phase: "start", step: narrateStep(request, "start") } : {}),
      },
    };

    if (request.action === "type") addTypedValue(request.sessionId, request.text);

    return new Promise<WebResponse>((resolve) => {
      const timer = setTimeout(() => {
        const entry = pending.get(id);
        pending.delete(id);
        resolve(fail("timed out waiting for the browser"));
        if (entry?.turnLaneKey && entry.turnToken) completeTurnLane(entry.turnLaneKey, entry.turnToken);
      }, timeoutMs + extraTimeoutFor(request as unknown as Parameters<typeof extraTimeoutFor>[0]));
      pending.set(id, {
        resolve,
        timer,
        tab,
        actorTabsKey: actorKey,
        action: request.action,
        addedOpenCandidate,
        expectedOrigin: expectOrigin,
        expectedPathPrefix: expectPathPrefix,
        request: { ...request, text: undefined },
        presence: message.presence,
        ...(commandClaimKey ? { claimKey: commandClaimKey } : {}),
        participantId: turnContext?.participantId ?? participantId,
        ...(turnContext ? { turnLaneKey: turnContext.laneKey, turnToken: turnContext.token } : {}),
      });
      if (deps.oneWriterPerTab && claimHolder && !turnContext) turnLaneForClaim(tab, claimHolder);
      if (!deps.send(message)) {
        clearTimeout(timer);
        const entry = pending.get(id);
        pending.delete(id);
        if (entry?.turnLaneKey && entry.turnToken) completeTurnLane(entry.turnLaneKey, entry.turnToken);
        if (addedOpenCandidate) forgetTab(actorKey, tab);
        resolve(fail("no browser extension is connected"));
      } else {
        recordPresence(tab, message.presence, request.owner);
        emit({ kind: "action", phase: "start", id, agent: actor, provider: request.provider, sessionId: request.sessionId, tab, action: request.action, step: narrateStep(request, "start"), url: request.url ?? tabUrls.get(tab), ...(request.action === "type" && request.text ? { typedText: request.text } : {}) });
      }
    });
  }

  function submit(request: WebRequest): Promise<WebResponse> {
    if (stopState.state === "stopped") return Promise.resolve(fail("browser actions are stopped by the owner; restart the local broker to resume"));
    const invalid = validateRequest(request);
    if (invalid) return Promise.resolve(fail(invalid));
    const risk = isPowerAction(request.action)
      ? classifyPowerRisk(request as unknown as Parameters<typeof classifyPowerRisk>[0])
      : classifyWebActionRisk(request as Parameters<typeof classifyWebActionRisk>[0]);
    if (!risk.risky) return dispatch(request);
    const mode = deps.roomMode?.() ?? "ask";
    if (autoAllowedInMode(mode, request, risk)) {
      try {
        deps.authority?.recordActionDecision("action.approved", request.owner !== undefined && request.owner !== deps.ownerId ? `${request.agent}@${request.owner}` : request.agent, { action: request.action, origin: originOf(request.url) ?? undefined, selector: request.selector, detail: `auto-allowed in ${mode} mode: ${risk.category ?? "risky"}` });
        deps.onAuthorityChange?.();
      } catch { /* the audit line is best effort here; the action still shows in the feed */ }
      return dispatch(request);
    }
    if (!deps.authority) return Promise.resolve(fail("risky browser action requires owner approval, but the approval audit is unavailable"));

    const crossOwner = request.owner !== undefined && request.owner !== deps.ownerId;
    const actor = crossOwner ? `${request.agent}@${request.owner}` : request.agent;
    const resolvedTab = resolveTab(request);
    if ("error" in resolvedTab) return Promise.resolve(fail(resolvedTab.error));
    const tab = resolvedTab.tab;
    const approvedRequest = { ...request, tab: resolvedTab.publicName };
    const origin = originOf(request.url ?? tabUrls.get(tab)) ?? undefined;
    const id = newId();
    const createdAt = now();
    let resolveResponse: (response: WebResponse) => void = () => {};
    const result = new Promise<WebResponse>((resolve) => { resolveResponse = resolve; });
    const onAudit = (kind: "action.requested" | "action.timed_out", detail: string): boolean => {
      try {
        deps.authority!.recordActionDecision(kind, actor, {
          action: request.action,
          origin,
          selector: request.selector,
          detail,
        });
        deps.onAuthorityChange?.();
        return true;
      } catch {
        return false;
      }
    };
    if (!onAudit("action.requested", risk.category ?? "risky")) {
      return Promise.resolve(fail("approval audit could not be persisted; the action was refused"));
    }
    const timer = setTimeout(() => {
      const entry = approvals.get(id);
      if (!entry) return;
      approvals.delete(id);
      const persisted = onAudit("action.timed_out", risk.category ?? "risky");
      entry.resolve(fail(persisted ? "owner approval timed out; the action was not sent to the browser" : "approval timeout could not be audited; the action was refused"));
    }, approvalTimeoutMs);
    approvals.set(id, { id, actor, request: approvedRequest, risk: risk.category ?? "risky", origin, createdAt, expiresAt: createdAt + approvalTimeoutMs, resolve: resolveResponse, timer });
    advanceFeed();
    emit({ kind: "approval", id, agent: actor, provider: request.provider, step: narrateStep(request, "start") });
    void result.then(() => emit({ kind: "approvals-changed" }));
    return result;
  }

  function pendingApprovals(): Array<Omit<ApprovalEntry, "request" | "resolve" | "timer"> & Pick<WebRequest, "action" | "tab" | "selector" | "targetLabel">> {
    return [...approvals.values()].map(({ id, actor, request, risk, origin, createdAt, expiresAt }) => ({
      id, actor, risk, origin, createdAt, expiresAt,
      action: request.action,
      tab: request.tab,
      selector: request.selector,
      targetLabel: request.targetLabel,
    }));
  }

  function decideApproval(id: string, decision: "approve" | "deny"): boolean {
    const entry = approvals.get(id);
    if (!entry || entry.expiresAt <= now()) return false;
    clearTimeout(entry.timer);
    approvals.delete(id);
    advanceFeed();
    emit({ kind: "approvals-changed" });
    try {
      deps.authority?.recordActionDecision(decision === "approve" ? "action.approved" : "action.denied", entry.actor, {
        action: entry.request.action,
        origin: entry.origin,
        selector: entry.request.selector,
        detail: entry.risk,
      });
      deps.onAuthorityChange?.();
    } catch {
      entry.resolve(fail("approval decision could not be persisted; the action was refused"));
      return false;
    }
    if (decision === "deny") {
      entry.resolve(fail("owner denied the browser action"));
      return true;
    }
    void dispatch(entry.request).then(entry.resolve);
    return true;
  }

  function onExtensionMessage(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const message = raw as {
      type?: string; id?: string; ok?: boolean; data?: unknown; error?: string; origin?: string; url?: string;
      noticeId?: unknown; tab?: unknown; agent?: unknown; provider?: unknown; sessionId?: unknown; rendered?: unknown;
    };
    if (message.type === "notice-ack") {
      if (typeof message.noticeId !== "string" || typeof message.tab !== "string" || typeof message.agent !== "string" ||
          typeof message.provider !== "string" || typeof message.sessionId !== "string" || typeof message.rendered !== "boolean") return;
      const entry = doneNoticeAcks.get(message.noticeId);
      if (!entry || entry.tab !== message.tab || entry.agent !== message.agent || entry.provider !== message.provider || entry.sessionId !== message.sessionId) return;
      clearTimeout(entry.timer);
      doneNoticeAcks.delete(message.noticeId);
      entry.resolve(message.rendered);
      return;
    }
    if (message.type === "tab-closed" && typeof (raw as { tab?: unknown }).tab === "string") {
      const closedTab = (raw as { tab: string }).tab;
      cancelTurnLanesForTab(closedTab, `browser tab "${closedTab}" was closed`);
      for (const [id, entry] of pending) {
        if (entry.tab !== closedTab) continue;
        clearTimeout(entry.timer);
        pending.delete(id);
        entry.resolve(fail(`browser tab "${closedTab}" was closed`));
      }
      for (const key of claims.keys()) if (key.startsWith(`${closedTab}\u0000`)) claims.delete(key);
      tabUrls.delete(closedTab);
      openedBy.delete(closedTab);
      for (const [actorKey, focused] of focusedTabByActor) if (focused === closedTab) focusedTabByActor.delete(actorKey);
      for (const [actorKey, tabs] of tabsByActor) {
        tabs.delete(closedTab);
        if (tabs.size === 0) tabsByActor.delete(actorKey);
      }
      return;
    }
    if (message.type === "tab-opened" && typeof (raw as { tab?: unknown }).tab === "string" && typeof (raw as { parent?: unknown }).parent === "string") {
      const { tab: openedTab, parent, url: openedUrl } = raw as { tab: string; parent: string; url?: unknown };
      const owner = openedBy.get(parent);
      if (!owner || openedTab.length > 60) return;
      openedBy.set(openedTab, owner);
      rememberTab(owner, openedTab);
      if (typeof openedUrl === "string" && /^https?:\/\//.test(openedUrl)) { tabUrls.set(openedTab, openedUrl); rememberVisit(openedUrl); }
      return;
    }
    if (message.type !== "result" || typeof message.id !== "string") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    const reported = originOf(message.origin);
    let reportedUrl: string | null = null;
    if (typeof message.url === "string") {
      try {
        const parsed = new URL(message.url);
        if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password && (!reported || parsed.origin === reported)) reportedUrl = parsed.toString();
      } catch {
        // Invalid extension location metadata is never trusted for later grant checks.
      }
    }
    if (reportedUrl) { tabUrls.set(entry.tab, reportedUrl); rememberVisit(reportedUrl); }
    else if (reported) { tabUrls.set(entry.tab, `${reported}/`); rememberVisit(`${reported}/`); }
    let data = message.data;
    if (typeof data === "string" && data.length > MAX_READ_LENGTH) data = data.slice(0, MAX_READ_LENGTH);
    const reportedPath = reportedUrl ? pathOf(reportedUrl) : null;
    const outsideOrigin = entry.expectedOrigin !== undefined && reported !== entry.expectedOrigin;
    const outsidePath = entry.expectedPathPrefix !== undefined && (!reportedPath || !(entry.expectedPathPrefix === "/" || reportedPath === entry.expectedPathPrefix || reportedPath.startsWith(`${entry.expectedPathPrefix}/`)));
    const response = outsideOrigin
      ? fail("the page ended up outside the granted site")
      : outsidePath
        ? fail("the page ended up outside the granted path")
        : message.ok
          ? { ok: true, data, ...(sanitizeLabel((raw as { label?: unknown }).label) ? { label: sanitizeLabel((raw as { label?: unknown }).label) } : {}) }
          : fail(typeof message.error === "string" ? message.error : "the browser reported a failure");
    if (response.ok && entry.action === "close") {
      forgetTab(entry.actorTabsKey, entry.tab);
      tabUrls.delete(entry.tab);
      openedBy.delete(entry.tab);
      if (focusedTabByActor.get(entry.actorTabsKey) === entry.tab) focusedTabByActor.delete(entry.actorTabsKey);
    } else if (response.ok && entry.action !== "tabs") {
      rememberTab(entry.actorTabsKey, entry.tab);
      if (entry.action === "open") openedBy.set(entry.tab, entry.actorTabsKey);
      if (entry.action === "switch") focusedTabByActor.set(entry.actorTabsKey, entry.tab);
    }
    else if (entry.addedOpenCandidate || /tab .* is not open/i.test(response.error ?? "")) forgetTab(entry.actorTabsKey, entry.tab);
    if (/tab .* is not open/i.test(response.error ?? "")) tabUrls.delete(entry.tab);
    if (entry.request && entry.presence) {
      const rawLabel = typeof (raw as { label?: unknown }).label === "string" ? (raw as { label: string }).label
        : message.data && typeof message.data === "object" && typeof (message.data as { label?: unknown }).label === "string" ? (message.data as { label: string }).label : undefined;
      // A label for an opened page is its title; for a typed field it names the field, never the value.
      const label = rawLabel ? redactTypedValues(entry.request.sessionId, rawLabel.slice(0, 200)) : undefined;
      const step = narrateStep(entry.request, "done", { ok: response.ok, label, error: response.error });
      if (narrate) deps.send({ type: "notice", tab: entry.tab, presence: { ...entry.presence, phase: "done", step, ok: response.ok } });
      emit({ kind: "action", phase: "done", id: message.id, agent: String(entry.presence.agent), provider: entry.request.provider, sessionId: entry.request.sessionId, tab: entry.tab, action: entry.action, step, ok: response.ok, url: tabUrls.get(entry.tab) });
      if (response.ok && entry.action !== "tabs") {
        const who = String(entry.presence.agent);
        tabLastBy.set(entry.tab, who);
        roomLog.push({ seq: ++roomSeq, agent: who, actorKey: entry.actorTabsKey, tab: entry.tab, action: entry.action, text: `@${who}: ${step} [tab ${entry.tab}]` });
        if (roomLog.length > 100) roomLog.splice(0, roomLog.length - 100);
      }
      if (response.ok) {
        const room = roomEventsFor(String(entry.presence.agent), entry.actorTabsKey);
        if (room) (response as WebResponse).room = room;
      }
    }
    entry.resolve(response);
    if (entry.turnLaneKey && entry.turnToken) completeTurnLane(entry.turnLaneKey, entry.turnToken);
  }

  function onExtensionClosed(): void {
    cancelAllTurnLanes("the browser extension disconnected");
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve(fail("the browser extension disconnected"));
      pending.delete(id);
    }
    for (const [id, entry] of doneNoticeAcks) {
      clearTimeout(entry.timer);
      entry.resolve(false);
      doneNoticeAcks.delete(id);
    }
  }

  /** Runs a bounded, ordered browser sequence. The broker owns the tab claim for every step and never continues after a refusal. */
  async function submitBatch(input: WebBatchRequest): Promise<WebBatchResponse> {
    if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 24) {
      return { ok: false, steps: [{ index: 0, action: "scroll", response: fail("m9r_web_do needs 1-24 ordered steps") }], failedAt: 0 };
    }
    const results: WebBatchStepResult[] = [];
    let tab = input.tab;
    let previousText = "";
    let lastChanged: string | undefined;
    for (let index = 0; index < input.steps.length; index += 1) {
      const step = input.steps[index];
      const request: WebRequest = {
        agent: input.agent,
        provider: input.provider,
        sessionId: input.sessionId,
        ...(input.owner ? { owner: input.owner } : {}),
        ...(input.shareWith ? { shareWith: input.shareWith } : {}),
        ...(step.tab ?? tab ? { tab: step.tab ?? tab } : {}),
        action: step.action,
        ...(step.url !== undefined ? { url: step.url } : {}),
        ...(step.selector !== undefined ? { selector: step.selector } : {}),
        ...(step.targetLabel !== undefined ? { targetLabel: step.targetLabel } : {}),
        ...(step.formSelector !== undefined ? { formSelector: step.formSelector } : {}),
        ...(step.text !== undefined ? { text: step.text } : {}),
        ...(step.args !== undefined ? { args: step.args } : {}),
        batchClaim: true,
      };
      const response = await submit(request);
      if (response.ok && input.includePageState && ["open", "click", "type", "press"].includes(step.action)) {
        const stateResponse = await submit({
          agent: input.agent,
          provider: input.provider,
          sessionId: input.sessionId,
          ...(input.owner ? { owner: input.owner } : {}),
          action: "snapshot",
          ...(step.tab ?? tab ? { tab: step.tab ?? tab } : {}),
          args: { limit: 12 },
        });
        const parsed = stateResponse.ok ? parseSnapshotState(stateResponse.data, typeof response.data === "object" && response.data !== null && typeof (response.data as { url?: unknown }).url === "string" ? (response.data as { url: string }).url : undefined) : null;
        if (parsed) {
          response.pageState = parsed.state;
          response.changedPart = changedText(previousText, parsed.visibleText);
          if (response.changedPart) lastChanged = response.changedPart;
          previousText = parsed.visibleText;
        }
      }
      results.push({ index, action: step.action, response });
      if (!response.ok) return { ok: false, steps: results, failedAt: index, ...(lastChanged ? { changedPart: lastChanged } : {}) };
      if (step.tab) tab = step.tab;
      if (!tab && typeof response.data === "object" && response.data !== null && typeof (response.data as { tab?: unknown }).tab === "string") tab = (response.data as { tab: string }).tab;
    }
    return { ok: true, steps: results, ...(lastChanged ? { changedPart: lastChanged } : {}) };
  }

  function currentClaims(): Array<{ tab: string; agent: string; expiresAt: number; scope: WebClaimScope }> {
    const live: Array<{ tab: string; agent: string; expiresAt: number; scope: WebClaimScope }> = [];
    for (const key of [...claims.keys()]) {
      const tab = key.slice(0, key.indexOf("\u0000"));
      for (const claim of activeClaims(tab)) {
        if (!live.some((item) => item.tab === tab && item.agent === claim.agent && item.scope.kind === claim.scope.kind && (item.scope.kind === "tab" || item.scope.key === (claim.scope as Exclude<WebClaimScope, { kind: "tab" }>).key))) {
          live.push({ tab, agent: claim.agent, expiresAt: claim.expiresAt, scope: claim.scope });
        }
      }
    }
    return live;
  }

  function notifyAgentMessage(input: WebAgentMessage): boolean {
    if (!input.agent || !input.provider || !input.sessionId || !input.to || !input.messageId || typeof input.text !== "string") return false;
    const actorKey = actorTabsKey({
      agent: input.agent,
      provider: input.provider,
      sessionId: input.sessionId,
      owner: input.owner,
      action: "read",
    });
    const tabs = [...(tabsByActor.get(actorKey) ?? [])].sort((a, b) => (tabLastActivity.get(b) ?? 0) - (tabLastActivity.get(a) ?? 0));
    const tab = tabs[0];
    if (!tab || seenMessageIds.has(input.messageId)) return false;
    const key = activityKey(input.agent, input.provider, input.sessionId);
    const previous = presenceByTab.get(tab)?.get(key);
    if (!previous) return false;
    const showMessageText = !hiddenMessageSessions.has(input.sessionId);
    const body = showMessageText ? redactTypedValues(input.sessionId, input.text) : "";
    const complete = showMessageText ? `${input.agent} to ${input.to}: ${body}` : `${input.agent} sent a message to ${input.to}`;
    const message = Array.from(complete).slice(0, 80).join("");
    const presence = {
      id: `message:${input.messageId}`,
      messageId: input.messageId,
      messageKind: "agent_message",
      agent: input.agent,
      provider: input.provider,
      sessionId: input.sessionId,
      to: input.to,
      action: "sent an M9R message",
      message,
      showMessageText,
      createdAt: now(),
      claimed: false,
      claimMs: 0,
      target: previous.target,
    };
    if (!deps.send({ type: "notice", tab, presence })) return false;
    seenMessageIds.add(input.messageId);
    if (seenMessageIds.size > 2_000) seenMessageIds.delete(seenMessageIds.values().next().value as string);
    recordPresence(tab, presence, input.owner);
    return true;
  }

  /**
   * A NATIVE agent session (one the owner runs directly -- a real Codex/Claude terminal, not a worker this broker
   * spawned) has no equivalent of web-live-sessions.ts's finish(): nobody here manages its process lifecycle, so
   * nothing ever told the overlay its turn was over. Its cursor just sat on whatever the last individual action
   * happened to be ("Read 'page'") forever, indistinguishable from actually being stuck. This is called from the
   * agent's own Stop hook (handleHookEvent in hook-handler.ts) the moment its turn really ends, and marks every tab
   * it is tracked on as done. The Stop hook supplies the provider session ID, so another concurrent session using the
   * same agent/provider is never incorrectly marked complete.
   */
  async function markAgentDone(agent: string, provider: string, sessionId: string): Promise<boolean> {
    const actorKey = `${deps.ownerId ?? ""}\u0000${agent}\u0000${provider}\u0000${sessionId}`;
    const tabs = [...(tabsByActor.get(actorKey) ?? [])];
    if (tabs.length === 0) return false;
    const rendered = await Promise.all(tabs.map((tab) => new Promise<boolean>((resolve) => {
      const noticeId = `done-${now().toString(36)}-${(++doneNoticeSequence).toString(36)}`;
      const timer = setTimeout(() => {
        doneNoticeAcks.delete(noticeId);
        resolve(false);
      }, doneNoticeAckTimeoutMs);
      doneNoticeAcks.set(noticeId, { tab, agent, provider, sessionId, resolve, timer });
      const sent = deps.send({
        type: "notice",
        noticeId,
        tab,
        presence: { agent, provider, sessionId, action: "finished", step: "Done", phase: "done", createdAt: now() },
      });
      if (!sent) {
        clearTimeout(timer);
        doneNoticeAcks.delete(noticeId);
        resolve(false);
      }
    })));
    return rendered.length > 0 && rendered.every(Boolean);
  }

  function setMessageTextVisibility(sessionId: string, show: boolean): boolean {
    const isKnownSession = [...presenceByTab.values()].some((records) => [...records.values()].some((entry) => entry.sessionId === sessionId));
    if (!isKnownSession) return false;
    if (show) hiddenMessageSessions.delete(sessionId);
    else hiddenMessageSessions.add(sessionId);
    advanceFeed();
    return true;
  }

  function stopAll(owner: string): boolean {
    if (stopState.state === "stopped") return true;
    stopState = { state: "stopped", stoppedAt: now(), stoppedBy: owner.trim().slice(0, 80) || "owner" };
    cancelAllTurnLanes("browser work was stopped by the owner");
    claims.clear();
    advanceFeed();
    // The extension signal stops future dispatch and page-side presence. An action already running in a page
    // may still finish; M9R cannot roll back or cancel an external side effect after it was dispatched.
    deps.send({ type: "stop-all", owner: stopState.stoppedBy, stoppedAt: new Date(stopState.stoppedAt ?? now()).toISOString() });
    emit({ kind: "stopped" });
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.resolve(fail("browser work was stopped by the owner; an action already sent to the page may still finish"));
    }
    for (const [id, entry] of approvals) {
      clearTimeout(entry.timer);
      approvals.delete(id);
      try {
        deps.authority?.recordActionDecision("action.denied", entry.actor, {
          action: entry.request.action,
          origin: entry.origin,
          selector: entry.request.selector,
          detail: "owner_stop_all",
        });
        deps.onAuthorityChange?.();
      } catch {
        // The local kill switch remains active even if optional audit persistence fails.
      }
      entry.resolve(fail("owner stopped browser work before approval"));
    }
    return true;
  }

  function feedSnapshot() {
    const at = now();
    const tabs = [...presenceByTab.entries()].map(([tab, records]) => {
      const url = tabUrls.get(tab);
      let origin: string | null = null;
      let path: string | null = null;
      try {
        if (url) {
          const parsed = new URL(url);
          if (parsed.protocol === "http:" || parsed.protocol === "https:") {
            origin = parsed.origin;
            path = parsed.pathname;
          }
        }
      } catch { /* invalid extension metadata is omitted from the feed */ }
      const active = [...records.values()].filter((entry) => Number(entry.updatedAt) + 30_000 > at);
      return {
        tab,
        ...(origin ? { origin } : {}),
        ...(path ? { path } : {}),
        agents: active.map((entry) => {
          const sessionId = String(entry.sessionId ?? "");
          const messageHidden = entry.messageKind === "agent_message" && hiddenMessageSessions.has(sessionId);
          return {
            agent: entry.agent,
            provider: entry.provider,
            owner: entry.owner,
            activity: { kind: entry.messageKind === "agent_message" ? "message" : entry.action, label: messageHidden ? "M9R message hidden" : entry.message },
            lastSeenAt: new Date(Number(entry.updatedAt)).toISOString(),
            claim: { scope: (entry.claimScope as WebClaimScope | undefined)?.kind ?? null, claimed: entry.claimed === true, sharedWith: Array.isArray(entry.sharedWith) ? entry.sharedWith : [] },
          };
        }),
      };
    }).filter((tab) => tab.agents.length > 0);
    const pending = pendingApprovals().map((entry) => ({
      id: entry.id,
      agent: entry.actor,
      action: entry.action,
      tab: entry.tab,
      origin: entry.origin ?? null,
      targetLabel: entry.targetLabel ?? null,
      createdAt: new Date(entry.createdAt).toISOString(),
      expiresAt: new Date(entry.expiresAt).toISOString(),
    }));
    const safeRecent = recent.slice(0, 20).map((entry) => {
      if (entry.messageKind === "agent_message" && hiddenMessageSessions.has(String(entry.sessionId ?? ""))) {
        return { ...entry, message: "M9R message hidden", showMessageText: false };
      }
      return { ...entry };
    });
    return {
      schema: "m9r.web-feed.v1",
      seq: feedSequence,
      generatedAt: new Date(at).toISOString(),
      stop: {
        state: stopState.state,
        stoppedAt: stopState.stoppedAt === null ? null : new Date(stopState.stoppedAt ?? now()).toISOString(),
        stoppedBy: stopState.stoppedBy,
      },
      tabs,
      pendingApprovals: pending,
      recent: safeRecent,
    };
  }

  return { submit, submitBatch, pendingApprovals, decideApproval, onExtensionMessage, onExtensionClosed, currentClaims, notifyAgentMessage, markAgentDone, noteOwnerUrls, setMessageTextVisibility, stopAll, feedSnapshot };
}
