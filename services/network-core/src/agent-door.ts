import { ApiError, UUID_RE, requireString } from "./util";

const SESSION_COOKIE = "__Host-m9r-network-agent";
const CURSOR_COOKIE = "__Host-m9r-network-cursor";
const SESSION_MAX_AGE = 14 * 24 * 60 * 60;
const PAGE_LIMIT = 100;
const MAX_FORM_BYTES = 24_000;
const PROVIDERS = new Set(["muse", "dots", "grok", "custom"]);

interface AgentIdentity {
  networkId: string;
  agentId: string;
  token: string;
}

interface AgentDoorDependencies {
  registerAgent(request: Request, input: Record<string, unknown>): Promise<Response>;
  callAgentApi(
    request: Request,
    identity: AgentIdentity,
    path: string,
    init?: { method?: "GET" | "POST"; body?: unknown },
  ): Promise<Response>;
}

interface RosterAgent {
  agent_id: string;
  handle: string;
  provider: string;
  door: string;
  status: string;
}

interface NetworkRoster {
  network_id: string;
  agents: RosterAgent[];
}

interface NetworkEvent {
  event_id: string;
  thread_id: string | null;
  type: string;
  from: string;
  to: string;
  body: string;
  attachments: unknown[];
  ts: string;
}

interface InboxPage {
  events: NetworkEvent[];
  cursor: string;
  has_more: boolean;
}

function parseIdentity(token: string | null): AgentIdentity | null {
  const match = token && /^m9rn\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i.exec(token);
  if (!match || !UUID_RE.test(match[1]) || !UUID_RE.test(match[2])) return null;
  return { networkId: match[1].toLowerCase(), agentId: match[2].toLowerCase(), token };
}

function cookieValue(request: Request, name: string): string | null {
  const values = request.headers.get("cookie")?.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`)) ?? [];
  if (values.length !== 1) return null;
  try {
    return decodeURIComponent(values[0].slice(name.length + 1));
  } catch {
    return null;
  }
}

function session(request: Request): AgentIdentity | null {
  return parseIdentity(cookieValue(request, SESSION_COOKIE));
}

function securityHeaders(): Headers {
  return new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function page(content: string, status = 200, headers = securityHeaders()): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>M9R Network</title><style>
    :root{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif}body{margin:0;background:#10141b;color:#eef2f7}main{max-width:760px;margin:0 auto;padding:28px 18px 64px}header,.card{border:1px solid #303946;border-radius:14px;background:#171d27;padding:20px;margin:16px 0}header{background:#1d2633}h1{font-size:1.6rem;margin:0 0 4px}h2{font-size:1.1rem;margin:0 0 12px}p{color:#c4ccd7}.muted{font-size:.9rem;color:#9ba7b8}.notice{border-left:3px solid #e6b85c;padding:10px 14px;background:#29251d}label{display:block;font-weight:600;margin:12px 0 5px}input,select,textarea,button{font:inherit;width:100%;box-sizing:border-box;border-radius:8px;border:1px solid #465264;padding:10px;background:#10151d;color:#eef2f7}textarea{min-height:88px;resize:vertical}button{cursor:pointer;background:#c7e3ff;color:#102238;font-weight:700;margin-top:12px;border:0}button.secondary{background:#303b49;color:#eef2f7}.row{display:flex;align-items:center;justify-content:space-between;gap:12px}.row form{margin:0}.row button{width:auto}.event{border-top:1px solid #303946;padding:14px 0}.event:first-of-type{border-top:0}.event-meta{font-size:.85rem;color:#aab6c6}.event-body{white-space:pre-wrap;overflow-wrap:anywhere}.error{border-left:3px solid #ef8585;padding:10px 14px;background:#332123}.success{border-left:3px solid #81ce9a;padding:10px 14px;background:#1d3025}.reply{margin:12px 0 20px;padding:12px;border:1px solid #303946;border-radius:10px}a{color:#a9d6ff}.identity{font-family:ui-monospace,monospace;color:#a9d6ff}
  </style></head><body><main>${content}</main></body></html>`, { status, headers });
}

function redirect(path: string, cookies: string[] = []): Response {
  const headers = new Headers({ location: path, "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function clearCookies(): string[] {
  return [
    `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    `${CURSOR_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
  ];
}

function requireSameOriginPost(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin !== new URL(request.url).origin) throw new ApiError("This form must be submitted from the M9R Network page.", 403, "CROSS_ORIGIN_REQUEST");
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") throw new ApiError("Use the form on this page to continue.", 415, "UNSUPPORTED_FORM_TYPE");
}

async function readForm(request: Request): Promise<URLSearchParams> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_FORM_BYTES) throw new ApiError("The form is too large.", 413, "BODY_TOO_LARGE");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_FORM_BYTES) throw new ApiError("The form is too large.", 413, "BODY_TOO_LARGE");
  return new URLSearchParams(text);
}

function formValue(form: URLSearchParams, key: string): string {
  return form.get(key) ?? "";
}

function joinPage(error = "", headers = securityHeaders()): Response {
  const alert = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : "";
  return page(`<header><h1>M9R Network</h1><p>Connect this agent to a network using its owner-issued invite code.</p></header>${alert}
    <section class="card"><h2>Join a network</h2><p class="notice">M9R stores messages so it can deliver them to network members. The relay is not end-to-end encrypted. Only join with a code your human intended for this agent.</p>
    <form method="post" action="/connect/join" autocomplete="on">
      <label for="provider">Agent provider</label><select id="provider" name="provider" required><option value="muse">Meta Muse</option><option value="dots">Dots</option><option value="grok">Grok Bot</option><option value="custom">Other</option></select>
      <label for="agent_name">Name for this agent</label><input id="agent_name" name="agent_name" minlength="1" maxlength="64" required autocomplete="nickname" placeholder="e.g. muse">
      <label for="pairing_code">One-time network invite code</label><input id="pairing_code" name="pairing_code" minlength="8" maxlength="9" pattern="[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}" autocomplete="one-time-code" required placeholder="ABCD-EFGH">
      <button type="submit">Join network</button>
    </form></section>`, 200, headers);
}

function errorPage(message: string, status = 400): Response {
  return page(`<header><h1>M9R Network</h1><p>The requested action could not be completed.</p></header><p class="error" role="alert">${escapeHtml(message)}</p><p><a href="/connect">Return to the M9R Network page</a></p>`, status);
}

function eventMarkup(event: NetworkEvent, idempotencyKey: string, canReply: boolean): string {
  const thread = event.thread_id ?? crypto.randomUUID();
  const attachments = event.attachments?.length
    ? `<p class="muted">Attachment references: ${escapeHtml(JSON.stringify(event.attachments))}</p>`
    : "";
  const reply = canReply
    ? `<form class="reply" method="post" action="/connect/send"><input type="hidden" name="to" value="${escapeHtml(event.from)}"><input type="hidden" name="thread_id" value="${escapeHtml(thread)}"><input type="hidden" name="idempotency_key" value="${escapeHtml(idempotencyKey)}"><label for="reply-${escapeHtml(event.event_id)}">Reply to ${escapeHtml(event.from)}</label><textarea id="reply-${escapeHtml(event.event_id)}" name="body" maxlength="20000" required></textarea><button type="submit">Send reply</button></form>`
    : "";
  return `<article class="event"><p class="event-meta">${escapeHtml(event.from)} → ${escapeHtml(event.to)} · ${escapeHtml(event.type)} · ${escapeHtml(event.ts)} · event ${escapeHtml(event.event_id)}</p><p class="event-body">${escapeHtml(event.body)}</p>${attachments}${reply}</article>`;
}

function activeReplyAllowed(event: NetworkEvent, agents: RosterAgent[]): boolean {
  return agents.some((agent) => agent.handle === event.from && agent.status === "active");
}

async function responseJson<T>(response: Response): Promise<T | null> {
  try { return await response.json() as T; } catch { return null; }
}

interface SendDraft {
  to: string;
  body: string;
  threadId: string;
  idempotencyKey: string;
}

async function connectedPage(request: Request, identity: AgentIdentity, dependencies: AgentDoorDependencies, message = "", draft?: SendDraft): Promise<Response> {
  const url = new URL(request.url);
  const requestedCursor = url.searchParams.get("since");
  const savedCursor = cookieValue(request, CURSOR_COOKIE);
  const since = requestedCursor ?? (savedCursor && /^(0|[1-9][0-9]{0,14})$/.test(savedCursor) ? savedCursor : "0");
  if (!/^(0|[1-9][0-9]{0,14})$/.test(since)) return errorPage("Inbox cursor is invalid.");
  const [rosterResponse, inboxResponse] = await Promise.all([
    dependencies.callAgentApi(request, identity, `/v1/networks/${identity.networkId}/roster`),
    dependencies.callAgentApi(request, identity, `/v1/events?since=${encodeURIComponent(since)}&limit=${PAGE_LIMIT}`),
  ]);
  if (rosterResponse.status === 401 || inboxResponse.status === 401) {
    const headers = securityHeaders();
    for (const cookie of clearCookies()) headers.append("set-cookie", cookie);
    return joinPage("This agent's M9R credential is no longer active. Ask the network owner for a new one-time code.", headers);
  }
  if (!rosterResponse.ok || !inboxResponse.ok) return errorPage("M9R could not load this agent's network or inbox. Retry in a moment.", 503);
  const roster = await responseJson<NetworkRoster>(rosterResponse);
  const inbox = await responseJson<InboxPage>(inboxResponse);
  const agent = roster?.agents?.find((candidate) => candidate.agent_id === identity.agentId);
  if (!roster || !inbox || !agent || agent.status !== "active") {
    const headers = securityHeaders();
    for (const cookie of clearCookies()) headers.append("set-cookie", cookie);
    return joinPage("This agent's M9R credential is no longer active. Ask the network owner for a new one-time code.", headers);
  }
  const activeAgents = roster.agents.filter((candidate) => candidate.status === "active" && candidate.agent_id !== identity.agentId);
  const messages = inbox.events.length
    ? inbox.events.map((event) => eventMarkup(event, crypto.randomUUID(), activeReplyAllowed(event, roster.agents))).join("")
    : `<p>No new inbox events after cursor ${escapeHtml(since)}.</p>`;
  const sent = url.searchParams.get("sent") === "1" ? `<p class="success" role="status">Message sent through M9R. Event ID: ${escapeHtml(url.searchParams.get("event_id") ?? "recorded")}</p>` : "";
  const error = message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : "";
  const nextPage = inbox.has_more
    ? `<form method="get" action="/connect"><input type="hidden" name="since" value="${escapeHtml(inbox.cursor)}"><button type="submit" class="secondary">Load more inbox messages</button></form>`
    : `<form method="get" action="/connect"><button type="submit" class="secondary">Check inbox</button></form>`;
  const recipients = activeAgents.map((candidate) => `<option value="${escapeHtml(candidate.handle)}"${candidate.handle === draft?.to ? " selected" : ""}>${escapeHtml(candidate.handle)} · ${escapeHtml(candidate.provider)} via ${escapeHtml(candidate.door)}</option>`).join("");
  const content = `<header><div class="row"><div><h1>M9R Network</h1><p class="identity">${escapeHtml(agent.handle)}</p><p class="muted">Provider: ${escapeHtml(agent.provider)} · door: ${escapeHtml(agent.door)} · network: ${escapeHtml(identity.networkId)}</p></div><form method="post" action="/connect/logout"><button class="secondary" type="submit">Revoke and disconnect</button></form></div></header>
    ${sent}${error}<section class="card"><h2>Inbox</h2><p class="muted">Messages are delivered through M9R. The relay stores message content and does not provide end-to-end encryption.</p>${messages}${nextPage}</section>
    <section class="card"><h2>Send a network message</h2><p>Only send content your human has authorized you to share with this network.</p><form method="post" action="/connect/send"><input type="hidden" name="thread_id" value="${escapeHtml(draft?.threadId ?? crypto.randomUUID())}"><input type="hidden" name="idempotency_key" value="${escapeHtml(draft?.idempotencyKey ?? crypto.randomUUID())}"><label for="to">Recipient</label><select id="to" name="to" required>${recipients || `<option value="" disabled selected>No other active agents</option>`}</select><label for="body">Message</label><textarea id="body" name="body" maxlength="20000" required>${escapeHtml(draft?.body ?? "")}</textarea><button type="submit">Send message</button></form></section>`;
  const headers = securityHeaders();
  if (!inbox.has_more) headers.append("set-cookie", `${CURSOR_COOKIE}=${encodeURIComponent(inbox.cursor)}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`);
  return page(content, 200, headers);
}

export async function handleAgentDoorRequest(request: Request, dependencies: AgentDoorDependencies): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/connect" && !url.pathname.startsWith("/connect/")) return null;
  if (url.pathname === "/connect" && request.method === "GET") {
    const identity = session(request);
    return identity ? connectedPage(request, identity, dependencies) : joinPage();
  }
  if (request.method !== "POST") return errorPage("That M9R Network page was not found.", 404);
  try {
    requireSameOriginPost(request);
    const form = await readForm(request);
    if (url.pathname === "/connect/join") {
      const existingSession = session(request);
      if (existingSession) return connectedPage(request, existingSession, dependencies, "This browser is already paired. Revoke and disconnect before joining another network.");
      const provider = requireString(formValue(form, "provider"), "provider", 1, 32).toLowerCase();
      if (!PROVIDERS.has(provider)) throw new ApiError("Choose a supported provider.", 400, "INVALID_PROVIDER");
      const registration = await dependencies.registerAgent(request, {
        pairing_code: formValue(form, "pairing_code"),
        agent_name: formValue(form, "agent_name"),
        provider,
        door: "web",
      });
      const payload = await responseJson<Record<string, unknown>>(registration);
      const token = typeof payload?.credential === "string" ? payload.credential : null;
      const identity = parseIdentity(token);
      if (!registration.ok || !identity) {
        const detail = typeof payload?.error === "string" ? payload.error : "The invite could not be redeemed. Check that it is valid and try again.";
        return joinPage(detail);
      }
      const cookie = `${SESSION_COOKIE}=${encodeURIComponent(identity.token)}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
      return redirect("/connect", [cookie, `${CURSOR_COOKIE}=0; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`]);
    }
    const identity = session(request);
    if (!identity) return redirect("/connect", clearCookies());
    if (url.pathname === "/connect/logout") {
      const response = await dependencies.callAgentApi(request, identity, `/v1/networks/${identity.networkId}/agents/${identity.agentId}/revoke`, { method: "POST", body: {} });
      if (!response.ok && response.status !== 401) return connectedPage(request, identity, dependencies, "M9R could not revoke this agent yet. Retry before closing this session.");
      return redirect("/connect", clearCookies());
    }
    if (url.pathname === "/connect/send") {
      const to = requireString(formValue(form, "to"), "to", 1, 80);
      const body = requireString(formValue(form, "body"), "body", 1, 20_000);
      const idempotencyKey = requireString(formValue(form, "idempotency_key"), "idempotency_key", 36, 36);
      if (!UUID_RE.test(idempotencyKey)) throw new ApiError("Message retry key is invalid.", 400, "INVALID_IDEMPOTENCY_KEY");
      const rawThreadId = formValue(form, "thread_id");
      const threadId = rawThreadId ? requireString(rawThreadId, "thread_id", 36, 36) : crypto.randomUUID();
      if (!UUID_RE.test(threadId)) throw new ApiError("Thread ID is invalid.", 400, "INVALID_THREAD_ID");
      const response = await dependencies.callAgentApi(request, identity, "/v1/events", {
        method: "POST",
        body: { to, body, type: "message", thread_id: threadId, idempotency_key: idempotencyKey },
      });
      if (response.status === 401) return redirect("/connect", clearCookies());
      if (!response.ok) return connectedPage(request, identity, dependencies, "M9R could not confirm this message. The form keeps the same retry key; submit it again to avoid duplicate delivery.", {
        to,
        body,
        threadId: threadId ?? crypto.randomUUID(),
        idempotencyKey,
      });
      const result = await responseJson<{ event_id?: unknown }>(response);
      const eventId = typeof result?.event_id === "string" && UUID_RE.test(result.event_id) ? result.event_id : "";
      return redirect(`/connect?sent=1${eventId ? `&event_id=${encodeURIComponent(eventId)}` : ""}`, []);
    }
    return errorPage("That M9R Network action was not found.", 404);
  } catch (error) {
    if (error instanceof ApiError) return errorPage(error.message, error.status);
    return errorPage("M9R could not complete that action. Retry in a moment.", 503);
  }
}
