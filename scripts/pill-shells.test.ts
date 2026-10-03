import assert from "node:assert/strict";
import test from "node:test";
import { fromFeed, fromUiState, providerOf } from "../pill/src/shells/convert";
import { createExtensionTransport } from "../pill/src/shells/extension";
import { createDesktopTransport } from "../pill/src/shells/desktop";
import { createFrameHost } from "../pill/src/shells/frame-host";

test("provider detection covers handles, provider ids and unknown agents", () => {
  assert.equal(providerOf("claude"), "claude");
  assert.equal(providerOf("claude-code"), "claude");
  assert.equal(providerOf("openai"), "codex");
  assert.equal(providerOf("@opencode"), "opencode");
  assert.equal(providerOf("grokbot"), "agent");
  assert.equal(providerOf(undefined), "agent");
});

test("browser ui-state becomes a snapshot: agents with their recent actions, approvals, and replies", () => {
  const snap = fromUiState({
    agents: [
      { id: "claude", provider: "claude-code", state: "working", doing: "Reading the pricing table" },
      { id: "codex", provider: "codex", state: "waiting", doing: "" },
      { id: "weird", provider: "x", state: "not-a-state" },
    ],
    thread: [
      { id: "1", kind: "do", agent: "claude", text: "Opened example.com", phase: "start" },
      { id: "2", kind: "do", agent: "claude", text: "Opened example.com", phase: "done" },
      { id: "3", kind: "say", agent: "claude", text: "Found three plans." },
      { id: "4", kind: "do", agent: "codex", text: "Clicked Buy" },
      { id: "5", kind: "system", agent: "", text: "Room started" },
    ],
    approvals: [{ id: "p1", agent: "codex", provider: "codex", text: "Click “Post” on the composer", site: "x.com", action: "post" }],
  });
  assert.deepEqual(snap.agents.map((a) => [a.handle, a.provider, a.state]), [["claude", "claude", "working"], ["codex", "codex", "waiting"], ["weird", "agent", "idle"]]);
  assert.deepEqual(snap.agents[0].activity, ["Opened example.com", "Found three plans.", "Reading the pricing table"], "start markers are dropped, the live line is last");
  assert.deepEqual(snap.agents[1].activity, ["Clicked Buy"]);
  assert.deepEqual(snap.approvals, [{ id: "p1", agent: "codex", title: "post", detail: "Click “Post” on the composer  ·  x.com" }]);
  assert.deepEqual(snap.thread.map((m) => [m.id, m.from]), [["3", "claude"], ["5", "m9r"]]);
});

test("malformed ui-state degrades to an empty snapshot instead of throwing", () => {
  assert.deepEqual(fromUiState({}), { agents: [], approvals: [], thread: [] });
  assert.deepEqual(fromUiState({ agents: null, thread: "x", approvals: 3 } as never), { agents: [], approvals: [], thread: [] });
});

test("the desktop feed becomes a snapshot: states, queued asks as activity, approvals and answers", () => {
  const snap = fromFeed({
    agents: [{ handle: "claude", state: "open_working" }, { handle: "codex", state: "open_idle" }, { handle: "opencode", state: "offline" }],
    inProgress: [{ taskId: "T5", from: "claude", to: "codex", goal: "review the diff", state: "working" }],
    needsYou: [
      { kind: "approval", taskId: "T6", from: "claude", to: "opencode", goal: "read secrets.txt", protected: true },
      { kind: "answer", taskId: "T7", from: "codex", summary: "Diff looks fine." },
      { kind: "push_failed", taskId: "T8", from: "claude", to: "codex", reason: "no live session" },
    ],
    web: [{ at: "2026-10-02T19:00:00Z", agent: "claude", kind: "action", text: "Opened x.com" }, { at: "2026-10-02T18:59:00Z", agent: "claude", kind: "worker", text: "run ended" }],
  });
  assert.deepEqual(snap.agents.map((a) => [a.handle, a.state]), [["claude", "working"], ["codex", "working"], ["opencode", "stopped"]], "an agent with a working task counts as working");
  assert.deepEqual(snap.agents[0].activity, ["Opened x.com"], "worker lines are not activity");
  assert.deepEqual(snap.agents[1].activity, ["@claude asked: review the diff"]);
  assert.deepEqual(snap.approvals, [{ id: "T6", agent: "opencode", title: "@claude asks @opencode", detail: "read secrets.txt" }]);
  assert.deepEqual(snap.thread.map((m) => m.id), ["answer-T7", "failed-T8"]);
});

test("extension transport sends the exact commands the service worker validates, and surfaces refusals", async () => {
  const sent: unknown[] = [];
  let reply: { ok?: boolean; error?: string } | undefined = { ok: true };
  const transport = createExtensionTransport({
    id: "ext",
    connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }),
    sendMessage: async (m) => { sent.push(m); return reply; },
  });
  await transport.send("@claude hello");
  await transport.decide("p1", "allow");
  await transport.decide("p2", "deny");
  await transport.decide("p3", "allow_day");
  assert.deepEqual(sent, [
    { type: "m9r-pill-cmd", command: { type: "ui-command", text: "@claude hello" } },
    { type: "m9r-pill-cmd", command: { type: "ui-approve", id: "p1" } },
    { type: "m9r-pill-cmd", command: { type: "ui-deny", id: "p2" } },
    { type: "m9r-pill-cmd", command: { type: "ui-approve", id: "p3" } },
  ]);
  assert.equal(transport.capabilities?.allowForADay, false, "the in-page bridge cannot honour 'allow for a day', so the button is hidden");
  reply = { ok: false, error: "the local M9R broker is not connected" };
  await assert.rejects(transport.send("x"), /broker is not connected/);
  reply = undefined;
  await assert.rejects(transport.send("x"), /not connected/);
});

test("extension transport delivers only ui-state messages from the port, converted", () => {
  const got: unknown[] = [];
  let onMessage: (m: unknown) => void = () => {};
  const transport = createExtensionTransport({
    id: "ext",
    connect: () => ({ onMessage: { addListener: (fn) => { onMessage = fn; } }, onDisconnect: { addListener() {} } }),
    sendMessage: async () => ({ ok: true }),
  });
  transport.subscribe((s) => got.push(s));
  onMessage({ type: "m9r-broker", connected: true });
  onMessage(null);
  onMessage({ type: "ui-state", agents: [{ id: "claude", provider: "claude", state: "idle" }], thread: [], approvals: [] });
  assert.equal(got.length, 1);
  assert.equal((got[0] as { agents: unknown[] }).agents.length, 1);
});

test("desktop transport maps decisions and typed messages onto the overlay's commands", async () => {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const feed = JSON.stringify({ agents: [], needsYou: [{ kind: "approval", taskId: "T6", from: "claude", to: "codex", goal: "g" }] });
  const transport = createDesktopTransport(async (command, args) => { calls.push([command, args]); return command === "read_feed" ? feed : command === "send_message" ? "ok-reply" : ""; });
  const stop = transport.subscribe(() => {});
  await new Promise((r) => setTimeout(r, 20));
  await transport.decide("T6", "allow_day");
  await transport.decide("T6", "allow");
  await transport.decide("T6", "deny");
  const decides = calls.filter(([c]) => c === "decide").map(([, a]) => a);
  assert.deepEqual(decides, [
    { taskId: "T6", action: "allow_day", from: "claude", to: "codex" },
    { taskId: "T6", action: "approve", from: "claude", to: "codex" },
    { taskId: "T6", action: "deny", from: "claude", to: "codex" },
  ]);
  assert.equal(await transport.send("@claude look at x"), "ok-reply");
  const sent = calls.find(([c]) => c === "send_message");
  assert.deepEqual(sent?.[1], { text: "@claude look at x" });
  assert.equal(transport.capabilities?.allowForADay, true);
  if (typeof stop === "function") stop();
});

test("an undeliverable message offers a session link only when the feed says it is linkable, and the desktop transport links through the overlay commands", async () => {
  const snap = fromFeed({
    needsYou: [
      { kind: "push_failed", taskId: "T8", from: "claude", fromSession: "s-1", to: "codex", reason: "no live session", linkable: true },
      { kind: "push_failed", taskId: "T9", from: "claude", to: "codex", reason: "off" },
    ],
  });
  assert.deepEqual(snap.thread[0].link, { taskId: "T8", from: "claude", fromSession: "s-1", to: "codex" });
  assert.equal(snap.thread[1].link, undefined);

  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const transport = createDesktopTransport(async (command, args) => {
    calls.push([command, args]);
    return command === "list_sessions" ? JSON.stringify([{ sessionId: "abc", cwd: "C:/x", lastSeenAt: "2026-10-02T19:00:00Z" }, { nope: 1 }]) : "";
  });
  assert.equal(transport.capabilities?.linkSessions, true);
  assert.deepEqual(await transport.listSessions!("codex"), [{ sessionId: "abc", cwd: "C:/x", lastSeenAt: "2026-10-02T19:00:00Z" }]);
  await transport.linkSession!({ taskId: "T8", from: "claude", fromSession: "s-1", to: "codex" }, "abc");
  assert.deepEqual(calls.at(-1), ["link_sessions", { fromHandle: "claude", fromSession: "s-1", toHandle: "codex", toSession: "abc" }]);
  await assert.rejects(transport.linkSession!({ taskId: "T9", from: "claude", to: "codex" }, "abc"), /no session to link/);
});

test("the page frame answers the host's hello, then reports exactly the island's size and folds to the wake strip", () => {
  const nonce = "a".repeat(32);
  const sent: unknown[] = [];
  const handlers: Array<(e: unknown) => void> = [];
  const parent = { postMessage: (m: unknown) => sent.push(m) };
  const win = { location: { href: `chrome-extension://x/pill-next/index.html?n=${nonce}` }, parent, addEventListener: (_t: string, fn: (e: unknown) => void) => handlers.push(fn) } as unknown as Window;
  const frame = createFrameHost({ subscribe() {}, async send() {}, async decide() {} }, win);
  const commands: string[] = [];
  frame.onHostCommand((k) => commands.push(k));
  const deliver = (data: unknown, source: unknown = parent, ports: unknown[] = []) => handlers.forEach((fn) => fn({ data, source, ports }));

  deliver({ m9r: "host-hello", nonce: "b".repeat(32) });
  assert.deepEqual(sent, [], "a hello with the wrong nonce is ignored");
  deliver({ m9r: "host-hello", nonce }, {});
  assert.deepEqual(sent, [], "a hello from another window is ignored");
  deliver({ m9r: "host-hello", nonce });
  assert.deepEqual(sent.map((m) => (m as { kind: string }).kind), ["ready", "size"]);

  sent.length = 0;
  frame.transport.setIslandRect!(0, 0, 288, 32);
  frame.transport.setIslandRect!(0, 0, 288, 32);
  assert.deepEqual(sent, [{ m9r: "frame", nonce, kind: "size", w: 288 + 32, h: 32 + 16 }], "unchanged sizes are not re-sent");
  sent.length = 0;
  frame.transport.setCollapsed!(true);
  assert.deepEqual(sent, [{ m9r: "frame", nonce, kind: "size", w: 240, h: 6 }]);

  let onmessage: ((m: unknown) => void) | null = null;
  const port = { start() {}, close() {}, set onmessage(fn: (m: unknown) => void) { onmessage = fn; } };
  deliver({ m9r: "host-port", nonce }, parent, [port]);
  onmessage!({ data: { m9r: "host", nonce, kind: "open-message" } });
  onmessage!({ data: { m9r: "host", nonce: "c".repeat(32), kind: "open-message" } });
  assert.deepEqual(commands, ["open-message"], "only commands carrying this frame's nonce are honoured");
});

test("the desktop transport forwards the island's window hooks to the overlay commands", async () => {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const transport = createDesktopTransport(async (command, args) => { calls.push([command, args]); if (command === "pill_set_rect") throw new Error("rejected"); return ""; });
  transport.setIslandRect!(216, 0, 288, 32);
  transport.setCollapsed!(true);
  transport.focusWindow!(true);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls, [
    ["pill_set_rect", { x: 216, y: 0, width: 288, height: 32 }],
    ["pill_set_collapsed", { collapsed: true }],
    ["pill_set_focus", { focused: true }],
  ], "a rejected rectangle does not throw into the UI");
});

test("the browser shell carries the desktop-pill flag, and the frame asks its page to step aside only when it changes", () => {
  assert.equal(fromUiState({ agents: [], desktopPill: true }).desktopPill, true);
  assert.equal("desktopPill" in fromUiState({ agents: [] }), false);
  const sent: unknown[] = [];
  const parent = { postMessage: (m: unknown) => sent.push(m) };
  const win = { location: { href: "chrome-extension://x/pill-next/index.html?n=" + "a".repeat(32) }, parent, addEventListener() {} } as unknown as Window;
  const frame = createFrameHost({ subscribe() {}, async send() {}, async decide() {} }, win);
  frame.transport.setSuppressed!(true);
  assert.deepEqual(sent, [{ m9r: "frame", nonce: "a".repeat(32), kind: "suppress", on: true }]);
});
