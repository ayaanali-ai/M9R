import assert from "node:assert/strict";
import test from "node:test";
import { fromFeed, fromUiState, providerOf } from "../pill/src/shells/convert";
import { createExtensionTransport } from "../pill/src/shells/extension";
import { createDesktopTransport } from "../pill/src/shells/desktop";
import { createFrameHost } from "../pill/src/shells/frame-host";
import { State } from "../pill/src/core/state";

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
  assert.deepEqual(snap.agents.map((a) => [a.handle, a.provider, a.state]), [["claude", "claude", "working"], ["codex", "codex", "waiting"], ["weird", "agent", "unknown"]]);
  assert.deepEqual(snap.agents[0].activity, ["Opened example.com", "Found three plans.", "Reading the pricing table"], "start markers are dropped, the live line is last");
  assert.deepEqual(snap.agents[1].activity, ["Clicked Buy"]);
  assert.deepEqual(snap.approvals, [{ id: "p1", agent: "codex", title: "post", detail: "Click “Post” on the composer  ·  x.com" }]);
  assert.deepEqual(snap.thread.map((m) => [m.id, m.from]), [["3", "claude"], ["5", "m9r"]]);
});

test("a live model catalog in ui-state reaches State.models through fromUiState, so the settings picker has data to render", () => {
  const snap = fromUiState({
    agents: [{ id: "claude", provider: "claude-code", state: "working" }],
    models: {
      agents: [{
        handle: "claude",
        provider: "claude",
        availability: "available",
        models: [{ id: "opus", label: "Opus", efforts: [{ id: "high", label: "High" }] }],
        currentModel: "opus",
        currentEffort: "high",
        selectedModel: "opus",
        selectedEffort: "high",
        status: "working",
      }],
    },
  });
  assert.ok(snap.models, "fromUiState must carry a live model catalog onto the snapshot");
  assert.deepEqual(snap.models?.agents.map((a) => [a.handle, a.availability, a.models.length]), [["claude", "available", 1]]);

  const applied = State.apply({ agents: [], approvals: [], thread: [], models: snap.models });
  assert.deepEqual(applied, { newApprovals: [], newReplies: [] });
  assert.equal(State.models?.agents[0]?.handle, "claude", "State.models is what the settings view reads to build the picker rows");
  assert.equal(State.models?.agents[0]?.models[0]?.id, "opus");
});

test("the owner's own message echoed by the thread is one owner bubble, never an agent reply or a new-reply alert", () => {
  State.apply({ agents: [], approvals: [], thread: [{ id: "seed-1", from: "codex", text: "ready" }] });
  State.chatHistory.push({ id: 900_001, role: "user", content: "@codex play the video" });
  const { newReplies } = State.apply({ agents: [], approvals: [], thread: [
    { id: "seed-1", from: "codex", text: "ready" },
    { id: "echo-1", from: "you", text: "@codex play the video" },
    { id: "reply-1", from: "codex", text: "Opening YouTube" },
  ] });
  const mine = State.chatHistory.filter((entry) => entry.content.includes("play the video"));
  assert.equal(mine.length, 1, "no second copy of the owner's message");
  assert.equal(mine[0].role, "user");
  assert.equal(mine[0].content, "@codex play the video", "no 'you:' prefix");
  assert.deepEqual(newReplies.map((message) => message.id), ["reply-1"], "only the agent's reply counts as new");
});

test("an explicit empty model catalog clears State.models, but a gap that omits it does not", () => {
  State.apply({ agents: [], approvals: [], thread: [], models: { agents: [{ handle: "claude", provider: "claude", availability: "available", models: [], currentModel: null, currentEffort: null, status: "working" }] } });
  assert.ok(State.models);
  // A tick that omits "models" entirely is a gap in that snapshot, not a real
  // "no agents" report -- it must not flash the picker empty.
  State.apply({ agents: [], approvals: [], thread: [] });
  assert.ok(State.models);
  // An explicit empty catalog is a real report and must still clear it.
  State.apply({ agents: [], approvals: [], thread: [], models: { agents: [] } });
  assert.deepEqual(State.models, { agents: [] });
});

test("malformed ui-state degrades to an empty snapshot instead of throwing", () => {
  const emptyCollaboration = {
    agents: [],
    featuredAgentIds: [],
    activeCount: 0,
    overflowCount: 0,
    headline: "No agents connected",
  };
  assert.deepEqual(fromUiState({}), { agents: [], collaboration: emptyCollaboration, approvals: [], thread: [] });
  assert.deepEqual(fromUiState({ agents: null, thread: "x", approvals: 3 } as never), { agents: [], collaboration: emptyCollaboration, approvals: [], thread: [] });
});

test("the desktop feed keeps provider activity separate from queued asks, approvals and answers", () => {
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
  assert.deepEqual(snap.agents.map((a) => [a.handle, a.state]), [["claude", "working"], ["codex", "idle"], ["opencode", "stopped"]], "a waiting assignment does not claim the provider is working");
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

test("extension transport reports broker state and ignores stale snapshots while offline", () => {
  const got: unknown[] = [];
  let onMessage: (m: unknown) => void = () => {};
  let onDisconnect: () => void = () => {};
  const transport = createExtensionTransport({
    id: "ext",
    connect: () => ({ onMessage: { addListener: (fn) => { onMessage = fn; } }, onDisconnect: { addListener: (fn) => { onDisconnect = fn; } } }),
    sendMessage: async () => ({ ok: true }),
  });
  const stop = transport.subscribe((s) => got.push(s));
  assert.equal((got.at(-1) as { connection?: string }).connection, "connecting");
  onMessage({ type: "m9r-broker", connected: true });
  assert.equal((got.at(-1) as { connection?: string }).connection, "connecting");
  onMessage(null);
  onMessage({ type: "ui-state", agents: [{ id: "claude", provider: "claude", state: "idle" }], thread: [], approvals: [] });
  assert.equal((got.at(-1) as { connection?: string }).connection, "connected");
  assert.equal((got.at(-1) as { agents: unknown[] }).agents.length, 1);
  onMessage({ type: "m9r-broker", connected: false });
  assert.equal((got.at(-1) as { connection?: string }).connection, "disconnected");
  onMessage({ type: "ui-state", agents: [{ id: "claude", provider: "claude", state: "working" }], thread: [], approvals: [] });
  assert.equal((got.at(-1) as { connection?: string }).connection, "disconnected", "late state cannot restore stale working status");
  onDisconnect();
  assert.equal((got.at(-1) as { connection?: string }).connection, "disconnected");
  stop?.();
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
  const replies: unknown[] = [];
  const port = { start() {}, close() {}, postMessage(message: unknown) { replies.push(message); }, set onmessage(fn: (m: unknown) => void) { onmessage = fn; } };
  deliver({ m9r: "host-port", nonce }, parent, [port]);
  onmessage!({ data: { m9r: "host", nonce, kind: "open-message" } });
  onmessage!({ data: { m9r: "host", nonce: "c".repeat(32), kind: "open-message" } });
  onmessage!({ data: { m9r: "host", nonce, kind: "health-ping", probeId: "probe-1" } });
  assert.deepEqual(commands, ["open-message"], "only commands carrying this frame's nonce are honoured");
  assert.deepEqual(replies, [{ m9r: "frame", nonce, kind: "health-pong", probeId: "probe-1" }], "a live frame acknowledges its private-port health probe");
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

test("the desktop transport persists settings through the overlay commands and reads them back, so sound/auto-close survive a restart", async () => {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const stored: Record<string, unknown> = {};
  const transport = createDesktopTransport(async (command, args) => {
    calls.push([command, args]);
    if (command === "save_settings") { Object.assign(stored, args); return ""; }
    if (command === "load_settings") return { soundEnabled: stored.soundEnabled ?? null, soundVolume: stored.soundVolume ?? null, autoCloseInterval: stored.autoCloseInterval ?? null };
    return "";
  });
  transport.saveSettings!({ soundEnabled: true, soundVolume: 0.5, autoCloseInterval: 30 });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls, [["save_settings", { soundEnabled: true, soundVolume: 0.5, autoCloseInterval: 30 }]]);
  const loaded = await transport.loadSettings!();
  assert.deepEqual(loaded, { soundEnabled: true, soundVolume: 0.5, autoCloseInterval: 30 }, "a fresh pill process reads back exactly what the last one saved");
});

test("the desktop transport's loadSettings leaves unset fields out instead of inventing zero/false, and swallows a host that cannot persist yet", async () => {
  const neverSaved = createDesktopTransport(async (command) => (command === "load_settings" ? { soundEnabled: null, soundVolume: null, autoCloseInterval: null } : ""));
  assert.deepEqual(await neverSaved.loadSettings!(), {}, "first run / no file yet: no field is guessed");
  const brokenHost = createDesktopTransport(async (command) => { if (command === "load_settings") throw new Error("no app config dir"); return ""; });
  assert.equal(await brokenHost.loadSettings!(), undefined, "a host that cannot read settings back must not throw into boot");
});

test("desktop dictation uses the WebView permission flow and opens Windows settings only after denial", () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const recognizer = class {} as unknown as new () => import("../pill/src/core/speech").RecognitionLike;
  const calls: string[] = [];
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { SpeechRecognition: recognizer } });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language: "en-US" } });
    const transport = createDesktopTransport(async (command) => { calls.push(command); return ""; });
    assert.equal(transport.capabilities?.dictation, true);
    const speech = transport.createDictationEnvironment!();
    assert.equal(speech.Recognition, recognizer);
    assert.equal(speech.micIsOn, undefined, "the desktop lets the WebView request permission on the Ctrl+Alt+M press");
    speech.openMicSetup();
    assert.deepEqual(calls, ["open_microphone_settings"]);
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else Reflect.deleteProperty(globalThis, "window");
    if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator); else Reflect.deleteProperty(globalThis, "navigator");
  }
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

test("the desktop pill shows what a working terminal agent is doing, and never an empty ticker while it works", () => {
  const snap = fromFeed({
    agents: [{ handle: "claude", state: "open_working", doing: "Reading feed-core.ts" }, { handle: "codex", state: "open_working" }, { handle: "opencode", state: "open_idle" }],
  });
  assert.deepEqual(snap.agents.find((a) => a.handle === "claude")?.activity, ["Reading feed-core.ts"]);
  assert.deepEqual(snap.agents.find((a) => a.handle === "codex")?.activity, ["Working on a turn"]);
  assert.deepEqual(snap.agents.find((a) => a.handle === "opencode")?.activity, []);
});
