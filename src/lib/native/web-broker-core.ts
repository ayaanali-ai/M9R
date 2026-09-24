/**
 * Web broker core (spike, docs: M9R_DEMO_BUILD_PLAN_2026-09-23.md Phase 1-2). Pure logic, no sockets: an agent's
 * browser command goes in through submit(), the connected extension does the work and answers through
 * onExtensionMessage(). Two things live here so they cannot be bypassed by the transport: the per-tab claim (a
 * second agent's click/type/open on a tab another agent is using is refused) and the presence label the overlay
 * draws, which is derived from the command that really ran rather than reported by the agent.
 */

import { originOf, pathOf, type WebAuthority } from "./web-authority-core";
import { redactSecrets } from "./inbox-core";
import { classifyWebActionRisk } from "./risk-core";

export type WebAction = "open" | "read" | "click" | "type";

const ACTIONS: readonly WebAction[] = ["open", "read", "click", "type"];
const MUTATING: ReadonlySet<WebAction> = new Set<WebAction>(["open", "click", "type"]);

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
  /** Untrusted, optional visible-control label used only for risk classification and owner review. */
  targetLabel?: string;
  /** Optional stable parent-form selector used only to coordinate field claims. */
  formSelector?: string;
  /** A click can explicitly reserve a form; opens and submit-like clicks always reserve the tab. */
  claimScope?: { kind: "form"; key: string };
  /** Named M9R handles allowed to act within this claim until it expires. */
  shareWith?: string[];
  text?: string;
}

export interface WebResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface WebBrokerDeps {
  send(message: unknown): boolean;
  ownerId?: string;
  authority?: WebAuthority;
  onAuthorityChange?(): void;
  now?: () => number;
  timeoutMs?: number;
  claimTtlMs?: number;
  approvalTimeoutMs?: number;
  newId?: () => string;
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
  }
}

export function validateRequest(request: WebRequest): string | null {
  if (!request.agent || typeof request.agent !== "string") return "missing agent";
  if (!ACTIONS.includes(request.action)) return `unknown action ${String(request.action)}`;
  if (request.tab !== undefined && !/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(request.tab)) {
    return "tab must be 1-40 letters, digits, dashes or underscores";
  }
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
  const claimTtlMs = deps.claimTtlMs ?? 8_000;
  const approvalTimeoutMs = Math.min(10 * 60_000, Math.max(1, deps.approvalTimeoutMs ?? 120_000));
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const claims = new Map<string, Claim>();
  const pending = new Map<string, Pending>();
  const tabUrls = new Map<string, string>();
  const tabsByActor = new Map<string, Set<string>>();
  const tabLastActivity = new Map<string, number>();
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
  const approvals = new Map<string, ApprovalEntry>();

  function advanceFeed(): void {
    feedSequence += 1;
  }

  function activityKey(agent: string, provider: string, sessionId: string): string {
    return JSON.stringify([agent, provider, sessionId]);
  }

  function recordPresence(tab: string, presence: Record<string, unknown>, owner?: string): void {
    const key = activityKey(String(presence.agent ?? ""), String(presence.provider ?? ""), String(presence.sessionId ?? ""));
    const records = presenceByTab.get(tab) ?? new Map<string, Record<string, unknown>>();
    const record: Record<string, any> = { ...presence, owner: owner ?? deps.ownerId ?? "you", tab, updatedAt: now() };
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
    if (openTabs.length > 1) return { error: "multiple tabs are open for this agent; specify tab to choose one" };
    if (openTabs.length === 1) {
      const tab = openTabs[0];
      return { tab, actorKey, publicName: crossOwner ? tab.slice(request.owner!.length + 1) : tab };
    }
    return { tab: namespace(request.agent), actorKey, publicName: request.agent };
  }

  function dispatch(request: WebRequest): Promise<WebResponse> {
    if (stopState.state === "stopped") return Promise.resolve(fail("browser actions are stopped by the owner; restart the local broker to resume"));
    const problem = validateRequest(request);
    if (problem) return Promise.resolve(fail(problem));

    const crossOwner = request.owner !== undefined && request.owner !== deps.ownerId;
    // A guest's tabs are namespaced by owner, so a guest agent can never land in one of the host's own tabs.
    const resolvedTab = resolveTab(request);
    if ("error" in resolvedTab) return Promise.resolve(fail(resolvedTab.error));
    const { tab, actorKey } = resolvedTab;
    const actor = crossOwner ? `${request.agent}@${request.owner}` : request.agent;

    let expectOrigin: string | undefined;
    let expectPathPrefix: string | undefined;
    if (crossOwner) {
      if (!deps.authority) return Promise.resolve(fail("cross-owner actions are not enabled on this browser"));
      const currentUrl = request.action === "open" ? request.url : tabUrls.get(tab);
      const origin = originOf(currentUrl);
      if (!origin) return Promise.resolve(fail("open the page first so its site can be checked against your grant"));
      const decision = deps.authority.check({
        grantee: { owner: request.owner as string, agent: request.agent },
        action: request.action,
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

    const requestedScope = scopeFor(request);
    let claimHolder: Claim | undefined;
    if (requestedScope) {
      const conflicting = activeClaims(tab).find((claim) => scopesOverlap(claim.scope, requestedScope) && claim.agent !== actor && !claim.sharedWith.has(actor));
      if (conflicting) {
        const seconds = Math.max(1, Math.ceil((conflicting.expiresAt - now()) / 1000));
        const scopeName = conflicting.scope.kind;
        // Display-only: lets the page show that the guardrail fired. It carries no request text and no page values.
        deps.send({
          type: "notice",
          tab,
          presence: {
            id: newId(),
            agent: actor,
            provider: request.provider,
            action: `blocked: @${conflicting.agent} has this ${scopeName}`,
            message: `blocked: @${conflicting.agent} has this ${scopeName}`,
            blocked: true,
            claimed: false,
            claimMs: 0,
            target: request.selector ? { selector: request.selector } : undefined,
            claimScope: conflicting.scope,
          },
        });
        return Promise.resolve(
          fail(`${scopeName} in tab "${tab}" is in use by @${conflicting.agent} for about ${seconds}s. Reading is allowed; wait, or use a different tab name.`),
        );
      }
      const key = claimKey(tab, requestedScope);
      const existing = claims.get(key);
      const sharedWith = new Set(existing?.sharedWith ?? []);
      if (!existing || existing.agent === actor) for (const name of request.shareWith ?? []) sharedWith.add(name);
      claimHolder = existing && existing.agent !== actor ? existing : { agent: actor, scope: requestedScope, sharedWith, expiresAt: now() + claimTtlMs };
      claimHolder.expiresAt = now() + claimTtlMs;
      if (claimHolder.agent === actor) claimHolder.sharedWith = sharedWith;
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
        claimed: MUTATING.has(request.action),
        claimMs: MUTATING.has(request.action) ? claimTtlMs : 0,
        target: request.selector ? { selector: request.selector } : undefined,
        ...(requestedScope ? { claimScope: requestedScope } : {}),
        ...(claimHolder?.sharedWith.size ? { sharedWith: [...claimHolder.sharedWith].sort() } : {}),
      },
    };

    if (request.action === "type") addTypedValue(request.sessionId, request.text);

    return new Promise<WebResponse>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(fail("timed out waiting for the browser"));
      }, timeoutMs);
      pending.set(id, { resolve, timer, tab, actorTabsKey: actorKey, action: request.action, addedOpenCandidate, expectedOrigin: expectOrigin, expectedPathPrefix: expectPathPrefix });
      if (!deps.send(message)) {
        clearTimeout(timer);
        pending.delete(id);
        if (addedOpenCandidate) forgetTab(actorKey, tab);
        resolve(fail("no browser extension is connected"));
      } else recordPresence(tab, message.presence, request.owner);
    });
  }

  function submit(request: WebRequest): Promise<WebResponse> {
    if (stopState.state === "stopped") return Promise.resolve(fail("browser actions are stopped by the owner; restart the local broker to resume"));
    const invalid = validateRequest(request);
    if (invalid) return Promise.resolve(fail(invalid));
    const risk = classifyWebActionRisk(request);
    if (!risk.risky) return dispatch(request);
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
    const message = raw as { type?: string; id?: string; ok?: boolean; data?: unknown; error?: string; origin?: string; url?: string };
    if (message.type === "tab-closed" && typeof (raw as { tab?: unknown }).tab === "string") {
      const closedTab = (raw as { tab: string }).tab;
      tabUrls.delete(closedTab);
      for (const [actorKey, tabs] of tabsByActor) {
        tabs.delete(closedTab);
        if (tabs.size === 0) tabsByActor.delete(actorKey);
      }
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
    if (reportedUrl) tabUrls.set(entry.tab, reportedUrl);
    else if (reported) tabUrls.set(entry.tab, `${reported}/`);
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
          ? { ok: true, data }
          : fail(typeof message.error === "string" ? message.error : "the browser reported a failure");
    if (response.ok) rememberTab(entry.actorTabsKey, entry.tab);
    else if (entry.addedOpenCandidate || /tab .* is not open/i.test(response.error ?? "")) forgetTab(entry.actorTabsKey, entry.tab);
    if (/tab .* is not open/i.test(response.error ?? "")) tabUrls.delete(entry.tab);
    entry.resolve(response);
  }

  function onExtensionClosed(): void {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve(fail("the browser extension disconnected"));
      pending.delete(id);
    }
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
    claims.clear();
    advanceFeed();
    // The extension signal stops future dispatch and page-side presence. An action already running in a page
    // may still finish; M9R cannot roll back or cancel an external side effect after it was dispatched.
    deps.send({ type: "stop-all", owner: stopState.stoppedBy, stoppedAt: new Date(stopState.stoppedAt ?? now()).toISOString() });
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

  return { submit, pendingApprovals, decideApproval, onExtensionMessage, onExtensionClosed, currentClaims, notifyAgentMessage, setMessageTextVisibility, stopAll, feedSnapshot };
}
