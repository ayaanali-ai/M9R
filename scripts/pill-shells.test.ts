import assert from "node:assert/strict";
import test from "node:test";
import { fromFeed, fromUiState, providerOf } from "../pill/src/shells/convert";
import { createExtensionTransport } from "../pill/src/shells/extension";
import { createDesktopTransport } from "../pill/src/shells/desktop";

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

test("desktop transport maps decisions onto the overlay's existing commands and refuses to fake sending", async () => {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const feed = JSON.stringify({ agents: [], needsYou: [{ kind: "approval", taskId: "T6", from: "claude", to: "codex", goal: "g" }] });
  const transport = createDesktopTransport(async (command, args) => { calls.push([command, args]); return command === "read_feed" ? feed : ""; });
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
  await assert.rejects(transport.send("hello"), /not connected yet/);
  assert.equal(transport.capabilities?.allowForADay, true);
  if (typeof stop === "function") stop();
});
