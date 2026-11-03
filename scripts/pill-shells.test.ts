import assert from "node:assert/strict";
import test from "node:test";
import { fromFeed, fromUiState, providerOf } from "../pill/src/shells/convert";
import { createDesktopTransport } from "../pill/src/shells/desktop";
import { DEFAULT_SETTINGS, State } from "../pill/src/core/state";

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
  assert.deepEqual(applied, { newApprovals: [], newReplies: [], newFinished: [] });
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
  assert.deepEqual(snap.thread.map((m) => m.id), ["answer-T7"], "delivery failures stay in task history, not live chat");
});

test("desktop transport maps decisions and typed messages onto the overlay's commands", async () => {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const uiState = JSON.stringify({ agents: [], thread: [], approvals: [{ id: "T6", agent: "codex", text: "g" }] });
  const transport = createDesktopTransport(async (command, args) => { calls.push([command, args]); return command === "read_pill_state" ? uiState : command === "send_message" ? "ok-reply" : ""; });
  const stop = transport.subscribe(() => {});
  await new Promise((r) => setTimeout(r, 20));
  await transport.decide("T6", "allow");
  await transport.decide("T6", "deny");
  const decides = calls.filter(([c]) => c === "pill_decide").map(([, a]) => a);
  assert.deepEqual(decides, [
    { approvalId: "T6", decision: "allow" },
    { approvalId: "T6", decision: "deny" },
  ]);
  await assert.rejects(transport.decide("T6", "allow_day"), /not available/);
  assert.equal(await transport.send("@claude look at x"), "ok-reply");
  const sent = calls.find(([c]) => c === "send_message");
  assert.deepEqual(sent?.[1], { text: "@claude look at x" });
  assert.equal(transport.capabilities?.allowForADay, false);
  if (typeof stop === "function") stop();
});

test("desktop transport reports broker loss and rehydrates after a stale state", async () => {
  const snapshots: Array<{ connection?: string; connectionOnly?: boolean }> = [];
  let reads = 0;
  const state = JSON.stringify({ agents: [], thread: [], approvals: [] });
  const transport = createDesktopTransport(async (command) => {
    if (command !== "read_pill_state") return "";
    reads += 1;
    return reads === 1 || reads >= 3 ? state : null;
  });
  const stop = transport.subscribe((snapshot) => snapshots.push(snapshot));
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  await new Promise((resolve) => setTimeout(resolve, 50));
  stop?.();
  assert.equal(snapshots[0]?.connection, "connected");
  assert.equal(snapshots.some((snapshot) => snapshot.connection === "disconnected" && snapshot.connectionOnly === true), true);
  assert.equal(snapshots.at(-1)?.connection, "connected");
});

test("undeliverable messages stay out of the live thread", () => {
  const snap = fromFeed({
    needsYou: [
      { kind: "push_failed", taskId: "T8", from: "claude", fromSession: "s-1", to: "codex", reason: "no live session", linkable: true },
      { kind: "push_failed", taskId: "T9", from: "claude", to: "codex", reason: "off" },
    ],
  });
  assert.deepEqual(snap.thread, [], "delivery diagnostics must not become composer bubbles");
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
  transport.saveSettings!({ ...DEFAULT_SETTINGS, soundEnabled: true, soundVolume: 0.5, autoCloseInterval: 30 });
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

test("desktop dictation uses the native Ctrl+Alt speech path and keeps settings as an explicit fallback", () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const calls: string[] = [];
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language: "en-US" } });
    const transport = createDesktopTransport(async (command) => { calls.push(command); return ""; });
    assert.equal(transport.capabilities?.dictation, true);
    const speech = transport.createDictationEnvironment!();
    assert.equal(speech.Recognition, null, "the desktop uses the native speech bridge instead of a browser recognition shim");
    speech.openMicSetup();
    assert.deepEqual(calls, ["open_microphone_settings"]);
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else Reflect.deleteProperty(globalThis, "window");
    if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator); else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("the desktop shell carries the desktop-pill flag", () => {
  assert.equal(fromUiState({ agents: [], desktopPill: true }).desktopPill, true);
  assert.equal("desktopPill" in fromUiState({ agents: [] }), false);
});

test("the desktop pill shows what a working terminal agent is doing, and never an empty ticker while it works", () => {
  const snap = fromFeed({
    agents: [{ handle: "claude", state: "open_working", doing: "Reading feed-core.ts" }, { handle: "codex", state: "open_working" }, { handle: "opencode", state: "open_idle" }],
  });
  assert.deepEqual(snap.agents.find((a) => a.handle === "claude")?.activity, ["Reading feed-core.ts"]);
  assert.deepEqual(snap.agents.find((a) => a.handle === "codex")?.activity, ["Working on a turn"]);
  assert.deepEqual(snap.agents.find((a) => a.handle === "opencode")?.activity, []);
});
