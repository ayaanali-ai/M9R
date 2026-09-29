import assert from "node:assert/strict";
import test from "node:test";
import { auditSerializedBytes, createWebAuthority, MAX_AUDIT_ENTRIES, MAX_AUDIT_SERIALIZED_BYTES, verifyAudit } from "@/lib/native/web-authority-core";
import { createWebBroker, validateRequest, type WebRequest } from "@/lib/native/web-broker-core";

function harness(options: { loopGuard?: { repeat: number; budget: number; windowMs: number }; connected?: boolean; timeoutMs?: number; claimTtlMs?: number; approvalEnabled?: boolean; approvalTimeoutMs?: number; roomMode?: "watch" | "ask" | "hands-off" } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const notices: Array<Record<string, unknown>> = [];
  let clock = 1_000;
  let n = 0;
  let auditId = 0;
  const authority = options.approvalEnabled ? createWebAuthority({ ownerId: "alice", now: () => clock, newId: () => `audit${++auditId}` }) : undefined;
  const broker = createWebBroker({
    send: (message) => {
      if (options.connected === false) return false;
      const entry = message as Record<string, unknown>;
      (entry.type === "notice" ? notices : sent).push(entry);
      return true;
    },
    now: () => clock,
    timeoutMs: options.timeoutMs ?? 200,
    claimTtlMs: options.claimTtlMs ?? 8_000,
    approvalTimeoutMs: options.approvalTimeoutMs,
    loopGuard: options.loopGuard,
    authority,
    roomMode: options.roomMode ? () => options.roomMode! : undefined,
    newId: () => `c${++n}`,
  });
  return { broker, sent, notices, advance: (ms: number) => (clock += ms) };
}

function req(agent: string, action: WebRequest["action"], extra: Partial<WebRequest> = {}): WebRequest {
  return { agent, provider: agent, sessionId: `${agent}-s`, action, ...extra };
}

test("a command goes to the extension with a presence label taken from the real command, and the answer comes back", async () => {
  const { broker, sent } = harness();
  const pending = broker.submit(req("claude", "click", { selector: "#save-button", tab: "shared" }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, "click");
  assert.deepEqual(sent[0].presence, {
    id: "c1", agent: "claude", provider: "claude", sessionId: "claude-s", owner: "you", action: "clicking #save-button", message: "clicking #save-button",
    claimed: true, claimMs: 8_000, target: { selector: "#save-button" }, claimScope: { kind: "tab", key: "*" },
  });
  broker.onExtensionMessage({ type: "result", id: "c1", ok: true, data: { clicked: true } });
  assert.deepEqual(await pending, { ok: true, data: { clicked: true } });
});

test("an agent can omit tab after opening its only named tab", async () => {
  const { broker, sent } = harness();
  const opened = broker.submit(req("claude", "open", { url: "https://example.com/", tab: "research" }));
  broker.onExtensionMessage({ type: "result", id: "c1", ok: true, origin: "https://example.com", url: "https://example.com/" });
  assert.equal((await opened).ok, true);
  const read = broker.submit(req("claude", "read", { selector: "h1" }));
  assert.equal(sent[1].tab, "research");
  broker.onExtensionMessage({ type: "result", id: "c2", ok: true, data: "Example Domain", origin: "https://example.com", url: "https://example.com/" });
  assert.deepEqual(await read, { ok: true, data: "Example Domain" });
});

test("an agent with no tab of its own works on the one page the room already has open", async () => {
  const { broker, sent } = harness();
  const opened = broker.submit(req("claude", "open", { url: "https://example.com/", tab: "research" }));
  broker.onExtensionMessage({ type: "result", id: "c1", ok: true, origin: "https://example.com", url: "https://example.com/" });
  assert.equal((await opened).ok, true);
  const read = broker.submit(req("codex", "read", { selector: "h1" }));
  assert.equal(sent[1].tab, "research");
  broker.onExtensionMessage({ type: "result", id: "c2", ok: true, data: "Example Domain", origin: "https://example.com", url: "https://example.com/" });
  assert.equal((await read).ok, true);
});

test("room modes: watch lets page-level actions through and holds what leaves the page; ask holds both; hands-off holds only money and secrets", async () => {
  for (const [mode, dragHeld, postHeld, buyHeld] of [["watch", false, true, true], ["ask", true, true, true], ["hands-off", false, false, true]] as const) {
    const h = harness({ approvalEnabled: true, roomMode: mode });
    const opened = h.broker.submit(req("claude", "open", { url: "https://example.com/", tab: "t" }));
    h.broker.onExtensionMessage({ type: "result", id: "c1", ok: true, origin: "https://example.com", url: "https://example.com/" });
    await opened;
    for (const [action, held] of [["click_at", dragHeld], ["post", postHeld], ["buy", buyHeld]] as const) {
      const before = h.broker.pendingApprovals().length;
      const sentBefore = h.sent.length;
      void h.broker.submit(req("claude", action as never, (action === "click_at" ? { tab: "t", args: { x: 5, y: 5 } } : { tab: "t", selector: "#x" }) as never));
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(h.broker.pendingApprovals().length - before, held ? 1 : 0, `${mode}: ${action} held=${held}`);
      assert.equal(h.sent.length - sentBefore, held ? 0 : 1, `${mode}: ${action} reaches the browser only when not held`);
    }
    // adopt (whose tab an agent works in) always asks, in every mode including hands-off, where everything else is auto-allowed.
    const before = h.broker.pendingApprovals().length;
    const sentBefore = h.sent.length;
    void h.broker.submit(req("claude", "adopt", { tab: "t" }));
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(h.broker.pendingApprovals().length - before, 1, `${mode}: adopt is always held`);
    assert.equal(h.sent.length - sentBefore, 0, `${mode}: adopt never reaches the browser unapproved`);
    h.broker.stopAll("test cleanup");
  }
});

test("an omitted tab is refused when the agent has more than one open named tab", async () => {
  const { broker, sent } = harness();
  const first = broker.submit(req("claude", "open", { url: "https://example.com/", tab: "research" }));
  broker.onExtensionMessage({ type: "result", id: "c1", ok: true, origin: "https://example.com", url: "https://example.com/" });
  await first;
  const second = broker.submit(req("claude", "open", { url: "https://example.org/", tab: "docs" }));
  broker.onExtensionMessage({ type: "result", id: "c2", ok: true, origin: "https://example.org", url: "https://example.org/" });
  await second;

  const ambiguous = await broker.submit(req("claude", "read", { selector: "h1" }));
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error ?? "", /multiple tabs.*specify tab/i);
  assert.equal(sent.length, 2, "an ambiguous command must not reach the extension");
});

test("a closed named tab is removed so a remaining unique tab is selected", async () => {
  const { broker, sent } = harness();
  for (const [id, name, url] of [["c1", "research", "https://example.com/"], ["c2", "docs", "https://example.org/"]] as const) {
    const opened = broker.submit(req("claude", "open", { url, tab: name }));
    broker.onExtensionMessage({ type: "result", id, ok: true, origin: new URL(url).origin, url });
    assert.equal((await opened).ok, true);
  }
  broker.onExtensionMessage({ type: "tab-closed", tab: "docs" });

  const read = broker.submit(req("claude", "read", { selector: "h1" }));
  assert.equal(sent[2].tab, "research");
  broker.onExtensionMessage({ type: "result", id: "c3", ok: true, data: "still open" });
  assert.deepEqual(await read, { ok: true, data: "still open" });
});

test("typed text never appears in the presence label", async () => {
  const { broker, sent } = harness();
  void broker.submit(req("codex", "type", { selector: "#email", text: "secret@example.com" }));
  assert.equal((sent[0].presence as { action: string }).action, "typing in #email");
  assert.ok(!JSON.stringify(sent[0].presence).includes("secret@example.com"));
});

test("M9R messages appear at the sender's last page target with a bounded preview", async () => {
  const { broker, notices } = harness();
  const opened = broker.submit(req("claude", "open", { url: "https://example.com/", tab: "research" }));
  broker.onExtensionMessage({ type: "result", id: "c1", ok: true, origin: "https://example.com", url: "https://example.com/" });
  await opened;
  const read = broker.submit(req("claude", "read", { selector: "#answer", tab: "research" }));
  broker.onExtensionMessage({ type: "result", id: "c2", ok: true, origin: "https://example.com", url: "https://example.com/" });
  await read;

  const published = broker.notifyAgentMessage({
    agent: "claude", provider: "claude", sessionId: "claude-s", to: "codex", messageId: "m1",
    text: "Found the exact 12+ rate and the supporting source.".repeat(3),
  });
  assert.equal(published, true);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].type, "notice");
  assert.equal(notices[0].tab, "research");
  const presence = notices[0].presence as Record<string, unknown>;
  assert.equal(presence.messageKind, "agent_message");
  assert.equal(presence.to, "codex");
  assert.equal(presence.target && (presence.target as { selector: string }).selector, "#answer");
  assert.ok(Array.from(String(presence.message)).length <= 80);
  assert.equal(broker.notifyAgentMessage({ agent: "claude", provider: "claude", sessionId: "claude-s", to: "codex", messageId: "m1", text: "duplicate" }), false);
  assert.equal(notices.length, 1, "a retried M9R message must not create another bubble");
});

test("per-session hide-message preference omits agent message text from page notices", () => {
  const { broker, notices } = harness();
  void broker.submit(req("claude", "open", { url: "https://example.com/", tab: "research" }));
  broker.onExtensionMessage({ type: "result", id: "c1", ok: true, origin: "https://example.com", url: "https://example.com/" });
  assert.equal(broker.setMessageTextVisibility("claude-s", false), true);
  assert.equal(broker.notifyAgentMessage({ agent: "claude", provider: "claude", sessionId: "claude-s", to: "codex", messageId: "m2", text: "private message preview" }), true);
  const presence = notices[0].presence as Record<string, unknown>;
  assert.equal(presence.showMessageText, false);
  assert.doesNotMatch(JSON.stringify(notices[0]), /private message preview/);
});

test("owner stop-all cancels broker waits and refuses later web actions", async () => {
  const { broker, sent } = harness({ timeoutMs: 60_000 });
  const action = broker.submit(req("claude", "read", { selector: "h1", tab: "research" }));
  assert.equal(sent.length, 1);
  assert.equal(broker.stopAll("you"), true);
  assert.equal(broker.stopAll("you"), true, "the kill switch is idempotent");
  assert.equal((await action).ok, false);
  assert.equal(broker.feedSnapshot().stop.state, "stopped");
  const next = await broker.submit(req("claude", "read", { selector: "h1", tab: "research" }));
  assert.equal(next.ok, false);
  assert.match(next.error ?? "", /stopped by the owner/);
  assert.equal(sent.filter((message) => message.type === "command").length, 1);
  assert.equal(sent.filter((message) => message.type === "stop-all").length, 1);
});

test("with no extension connected the command fails at once instead of hanging", async () => {
  const { broker } = harness({ connected: false });
  const result = await broker.submit(req("claude", "read", { selector: "#pricing" }));
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /no browser extension/);
});

test("a tab-scoped click still blocks a second agent while reads remain allowed", async () => {
  const { broker, sent, notices } = harness();
  void broker.submit(req("claude", "click", { selector: "#a", tab: "shared" }));
  const blocked = await broker.submit(req("codex", "type", { selector: "#b", text: "secret-value", tab: "shared" }));
  assert.equal(blocked.ok, false);
  assert.match(blocked.error ?? "", /in use by @claude/);
  assert.equal(sent.length, 1, "the refused command must never reach the browser");
  assert.equal(notices.length, 1, "the page is told the guardrail fired");
  const presence = notices[0].presence as Record<string, unknown>;
  assert.equal(notices[0].tab, "shared");
  assert.equal(presence.blocked, true);
  assert.equal(presence.agent, "codex");
  assert.match(String(presence.message), /blocked: @claude has this tab/);
  assert.ok(!JSON.stringify(notices[0]).includes("secret-value"), "a notice never carries the refused request's text");

  void broker.submit(req("codex", "read", { selector: "#b", tab: "shared" }));
  assert.equal(sent.length, 2, "reading a claimed tab is allowed");
});

test("typing claims only its field so agents can type in different fields concurrently", async () => {
  const { broker, sent, notices } = harness();
  void broker.submit(req("claude", "type", { selector: "#email", text: "a", tab: "shared" }));
  void broker.submit(req("codex", "type", { selector: "#name", text: "b", tab: "shared" }));
  assert.equal(sent.length, 2);
  assert.equal(notices.length, 0);
  const blocked = await broker.submit(req("gemini", "type", { selector: "#email", text: "c", tab: "shared" }));
  assert.equal(blocked.ok, false);
  assert.match(blocked.error ?? "", /field/);
  assert.equal(sent.length, 2);
});

test("a form claim conflicts with fields in that form but not another form", async () => {
  const { broker, sent } = harness();
  void broker.submit(req("claude", "click", { selector: "#save", tab: "shared", claimScope: { kind: "form", key: "#profile" } } as never));
  const blocked = await broker.submit(req("codex", "type", { selector: "#email", text: "a", tab: "shared", formSelector: "#profile" } as never));
  assert.equal(blocked.ok, false);
  assert.match(blocked.error ?? "", /form/);
  assert.equal(sent.length, 1);
  const independent = broker.submit(req("gemini", "type", { selector: "#search", text: "x", tab: "shared", formSelector: "#search-form" } as never));
  assert.equal(sent.length, 2);
  broker.onExtensionMessage({ type: "result", id: sent[1].id, ok: true, data: { typed: 1 } });
  assert.deepEqual(await independent, { ok: true, data: { typed: 1 } });
});

test("a claimant can explicitly share its field claim with a named agent", async () => {
  const { broker, sent, notices } = harness();
  void broker.submit(req("claude", "type", { selector: "#email", text: "a", tab: "shared", shareWith: ["codex"] } as never));
  const shared = broker.submit(req("codex", "type", { selector: "#email", text: "b", tab: "shared" } as never));
  assert.equal(sent.length, 2);
  assert.equal(notices.length, 0);
  broker.onExtensionMessage({ type: "result", id: sent[1].id, ok: true, data: { typed: 1 } });
  assert.deepEqual(await shared, { ok: true, data: { typed: 1 } });
});

test("opening or clicking a submit control claims the whole tab", async () => {
  const { broker, sent } = harness({ approvalEnabled: true });
  void broker.submit(req("claude", "open", { url: "https://example.com", tab: "shared" }));
  const afterOpen = await broker.submit(req("codex", "type", { selector: "#email", text: "x", tab: "shared" }));
  assert.equal(afterOpen.ok, false);
  broker.onExtensionMessage({ type: "result", id: "c1", ok: true });
  const submit = broker.submit(req("gemini", "click", { selector: "button[type=submit]", tab: "checkout" }));
  const approval = broker.pendingApprovals()[0];
  assert.equal(approval.action, "click");
  assert.equal(sent.length, 1, "risky submit-like click is held before browser dispatch");
  assert.equal(broker.decideApproval(approval.id, "approve"), true);
  const afterSubmit = await broker.submit(req("codex", "type", { selector: "#card", text: "x", tab: "checkout" }));
  assert.equal(afterSubmit.ok, false);
  assert.equal(sent.length, 2);
  broker.onExtensionMessage({ type: "result", id: sent[1].id, ok: true, data: { clicked: true } });
  const submitted = await submit;
  assert.equal(submitted.ok, true);
  assert.deepEqual(submitted.data, { clicked: true });
});

test("agents in their own tabs never conflict, and a claim ends after its ttl", async () => {
  const { broker, sent, advance } = harness({ claimTtlMs: 5_000 });
  void broker.submit(req("claude", "click", { selector: "#a" }));
  void broker.submit(req("codex", "click", { selector: "#a" }));
  assert.equal(sent.length, 2, "default tabs are per agent");

  void broker.submit(req("claude", "click", { selector: "#a", tab: "shared" }));
  advance(5_001);
  void broker.submit(req("codex", "click", { selector: "#b", tab: "shared" }));
  assert.equal(sent.length, 4, "an expired claim no longer blocks");
});

test("the claim holder keeps working and renews the claim", async () => {
  const { broker, sent, advance } = harness({ claimTtlMs: 5_000 });
  void broker.submit(req("claude", "click", { selector: "#a", tab: "shared" }));
  advance(4_000);
  void broker.submit(req("claude", "click", { selector: "#b", tab: "shared" }));
  advance(4_000);
  const blocked = await broker.submit(req("codex", "click", { selector: "#c", tab: "shared" }));
  assert.equal(blocked.ok, false, "the second click renewed the claim, so it is still held 8s after the first");
  assert.equal(sent.length, 2);
});

test("a command that gets no answer times out", async () => {
  const { broker } = harness({ timeoutMs: 20 });
  const result = await broker.submit(req("claude", "read"));
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /timed out/);
});

test("when the extension disconnects, waiting commands fail immediately", async () => {
  const { broker } = harness({ timeoutMs: 5_000 });
  const pending = broker.submit(req("claude", "read"));
  broker.onExtensionClosed();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /disconnected/);
});

test("long read results are cut, and results for unknown ids are ignored", async () => {
  const { broker } = harness();
  const pending = broker.submit(req("claude", "read"));
  broker.onExtensionMessage({ type: "result", id: "nope", ok: true, data: "ignored" });
  broker.onExtensionMessage({ type: "result", id: "c1", ok: true, data: "x".repeat(10_000) });
  const result = await pending;
  assert.equal((result.data as string).length, 4_000);
});

test("validation rejects non-http urls, missing selectors, bad tab names and oversized input", () => {
  assert.match(validateRequest(req("a", "open", { url: "javascript:alert(1)" })) ?? "", /http/);
  assert.match(validateRequest(req("a", "open", { url: "file:///c:/secrets.txt" })) ?? "", /http/);
  assert.match(validateRequest(req("a", "open", { url: "not a url" })) ?? "", /valid url/);
  assert.equal(validateRequest(req("a", "open", { url: "https://example.com/x" })), null);
  assert.match(validateRequest(req("a", "click")) ?? "", /selector/);
  assert.match(validateRequest(req("a", "click", { selector: "#a", tab: "../x" })) ?? "", /tab/);
  assert.match(validateRequest(req("a", "type", { selector: "#a" })) ?? "", /text/);
  assert.match(validateRequest(req("a", "type", { selector: "#a", text: "x".repeat(6_000) })) ?? "", /too long/);
  assert.match(validateRequest({ ...req("a", "read"), action: "delete" as never }) ?? "", /unknown action/);
});


function crossHarness(options: { withAuthority?: boolean } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const clock = 1_000;
  let n = 0;
  const authority = createWebAuthority({ ownerId: "alice", now: () => clock, newId: () => `a${++n}` });
  const broker = createWebBroker({
    send: (message) => {
      sent.push(message as Record<string, unknown>);
      return true;
    },
    ownerId: "alice",
    authority: options.withAuthority === false ? undefined : authority,
    now: () => clock,
    timeoutMs: 200,
    newId: () => `c${sent.length + 1}`,
  });
  const grant = (actions: Array<"open" | "read" | "click" | "type">, origin = "https://shop.example") => {
    const requested = authority.requestGrant({ grantee: { owner: "bob", agent: "claude" }, origin, actions });
    assert.ok(requested.ok);
    const approved = authority.approve(requested.request.id);
    assert.ok(approved.ok);
    return approved.grant;
  };
  const reply = (extra: Record<string, unknown>) => {
    const id = sent[sent.length - 1].id;
    broker.onExtensionMessage({ type: "result", id, ok: true, ...extra });
  };
  return { broker, authority, sent, grant, reply };
}

const guest = (action: WebRequest["action"], extra: Partial<WebRequest> = {}): WebRequest => ({
  agent: "claude",
  provider: "claude-code",
  sessionId: "s",
  owner: "bob",
  action,
  ...extra,
});

test("a guest agent is refused before anything reaches the browser when nothing was granted", async () => {
  const { broker, sent } = crossHarness();
  const result = await broker.submit(guest("open", { url: "https://shop.example/cart" }));
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /no grant/);
  assert.equal(sent.length, 0);
});

test("cross-owner actions are refused outright when the browser has no authority configured", async () => {
  const { broker, sent } = crossHarness({ withAuthority: false });
  const result = await broker.submit(guest("open", { url: "https://shop.example/" }));
  assert.match(result.error ?? "", /not enabled/);
  assert.equal(sent.length, 0);
});

test("with a grant the guest works in its own namespaced tab, pinned to the granted site", async () => {
  const { broker, sent, grant, reply } = crossHarness();
  grant(["open", "read", "click"]);

  const opened = broker.submit(guest("open", { url: "https://shop.example/cart" }));
  assert.equal(sent[0].tab, "bob/claude", "a guest never lands in a tab named like the host's own");
  assert.equal(sent[0].expectOrigin, "https://shop.example");
  assert.deepEqual(sent[0].presence, {
    id: "c1", agent: "claude@bob", provider: "claude-code", sessionId: "s", owner: "bob", action: "opening shop.example", message: "opening shop.example",
    claimed: true, claimMs: 8_000, target: undefined, claimScope: { kind: "tab", key: "*" },
  });
  reply({ data: { url: "https://shop.example/cart" }, origin: "https://shop.example" });
  assert.equal((await opened).ok, true);

  const clicked = broker.submit(guest("click", { selector: "#checkout" }));
  const pendingApproval = broker.pendingApprovals()[0];
  assert.equal(pendingApproval.risk, "money");
  assert.equal(broker.decideApproval(pendingApproval.id, "approve"), true);
  assert.equal(sent[1].expectOrigin, "https://shop.example");
  reply({ data: { clicked: true }, origin: "https://shop.example" });
  assert.equal((await clicked).ok, true);
});

test("a guest cannot act before the page has been opened and checked, or type when only click was granted", async () => {
  const { broker, sent, grant, reply } = crossHarness();
  grant(["open", "click"]);
  assert.match((await broker.submit(guest("click", { selector: "#x" }))).error ?? "", /open the page first/);

  const opened = broker.submit(guest("open", { url: "https://shop.example/" }));
  reply({ origin: "https://shop.example" });
  await opened;
  const typed = await broker.submit(guest("type", { selector: "#email", text: "a" }));
  assert.match(typed.error ?? "", /does not allow type/);
  assert.equal(sent.length, 1);
});

test("a grant for one site does not open another, and a redirect the extension reports moves the tab out of scope", async () => {
  const { broker, sent, grant, reply } = crossHarness();
  grant(["open", "read", "click"]);
  assert.match((await broker.submit(guest("open", { url: "https://other.example/" }))).error ?? "", /no grant covers https:\/\/other.example/);
  assert.equal(sent.length, 0);

  const opened = broker.submit(guest("open", { url: "https://shop.example/" }));
  reply({ origin: "https://shop.example" });
  await opened;
  const read = broker.submit(guest("read", { selector: "#a" }));
  reply({ data: "x", origin: "https://elsewhere.example" });
  await read;
  assert.match((await broker.submit(guest("click", { selector: "#b" }))).error ?? "", /no grant covers https:\/\/elsewhere.example/);
});

test("a path grant rejects another path and refuses an open that redirects outside its prefix", async () => {
  const { broker, sent, grant, reply } = crossHarness();
  grant(["open", "read"], "https://shop.example/cart");
  const outside = await broker.submit(guest("open", { url: "https://shop.example/account" }));
  assert.equal(outside.ok, false);
  assert.match(outside.error ?? "", /does not cover path \/account/);
  assert.equal(sent.length, 0);

  const opening = broker.submit(guest("open", { url: "https://shop.example/cart" }));
  assert.equal(sent[0].expectPathPrefix, "/cart");
  reply({ origin: "https://shop.example", url: "https://shop.example/account" });
  const redirected = await opening;
  assert.equal(redirected.ok, false);
  assert.match(redirected.error ?? "", /outside the granted path/);
  assert.match((await broker.submit(guest("read", { selector: "#account" }))).error ?? "", /does not cover path \/account/);
});

test("a path grant covers its descendants without matching a similarly prefixed sibling", async () => {
  const { broker, sent, grant, reply } = crossHarness();
  grant(["open", "read"], "https://shop.example/cart");
  const opening = broker.submit(guest("open", { url: "https://shop.example/cart/items" }));
  assert.equal(sent[0].expectPathPrefix, "/cart");
  reply({ origin: "https://shop.example", url: "https://shop.example/cart/items" });
  assert.equal((await opening).ok, true);
  assert.match((await broker.submit(guest("open", { url: "https://shop.example/cartoon" }))).error ?? "", /does not cover path/);
});

test("revoking a grant stops the next command at once", async () => {
  const { broker, authority, grant, reply } = crossHarness();
  const g = grant(["open", "read"]);
  const opened = broker.submit(guest("open", { url: "https://shop.example/" }));
  reply({ origin: "https://shop.example" });
  await opened;
  authority.revoke(g.id);
  assert.match((await broker.submit(guest("read", { selector: "#a" }))).error ?? "", /revoked/);
});

test("the host's own agent and a guest with the same name never share a claim", async () => {
  const { broker, sent, grant } = crossHarness();
  grant(["open"]);
  void broker.submit({ agent: "claude", provider: "claude-code", sessionId: "h", action: "click", selector: "#mine" });
  void broker.submit(guest("open", { url: "https://shop.example/" }));
  assert.equal(sent.length, 2, "different tabs, different claimants, no conflict");
  assert.equal(sent[0].tab, "claude");
  assert.equal(sent[1].tab, "bob/claude");
});

test("the host's own requests never need a grant, and the log records what the guest tried", async () => {
  const { broker, authority, sent, grant } = crossHarness();
  void broker.submit({ agent: "claude", provider: "claude-code", sessionId: "h", owner: "alice", action: "open", url: "https://anywhere.example/" });
  assert.equal(sent.length, 1);

  grant(["read"]);
  await broker.submit(guest("open", { url: "https://shop.example/" }));
  const audit = authority.audit();
  assert.ok(audit.some((entry) => entry.kind === "action.refused" && entry.action === "open"));
  assert.deepEqual(verifyAudit(audit), { ok: true });
});

test("authority audit retention stays bounded and remains verifiable from its persisted chain anchor", () => {
  const authority = createWebAuthority({ ownerId: "alice" });
  for (let i = 0; i < MAX_AUDIT_ENTRIES + 25; i += 1) {
    authority.recordActionDecision("action.requested", "bob/codex", { action: "click", origin: "https://example.test", detail: `action-${i}` });
  }

  const snapshot = authority.snapshot();
  assert.equal(snapshot.version, 2);
  assert.ok(snapshot.audit.length <= MAX_AUDIT_ENTRIES);
  assert.ok(auditSerializedBytes(snapshot.audit) <= MAX_AUDIT_SERIALIZED_BYTES);
  assert.equal(snapshot.auditAnchor.sequence, MAX_AUDIT_ENTRIES + 25 - snapshot.audit.length);
  assert.equal(snapshot.audit[0].seq, snapshot.auditAnchor.sequence);
  assert.deepEqual(verifyAudit(snapshot.audit, snapshot.auditAnchor), { ok: true });
  const alteredWindow = snapshot.audit.map((entry) => ({ ...entry }));
  alteredWindow[10].detail = "edited-after-write";
  assert.deepEqual(verifyAudit(alteredWindow, snapshot.auditAnchor), { ok: false, brokenAt: 10 });

  const restored = createWebAuthority({ ownerId: "alice" });
  restored.restore(snapshot);
  const previousSequence = snapshot.audit.at(-1)!.seq;
  restored.recordActionDecision("action.approved", "alice", { action: "click" });
  const next = restored.snapshot();
  assert.equal(next.audit.at(-1)?.seq, previousSequence + 1, "restoring a bounded window must not restart the global sequence");
  assert.deepEqual(verifyAudit(next.audit, next.auditAnchor), { ok: true });
});

test("opening a page in a tab another agent is using goes to a new tab instead of failing, and says so", async () => {
  const { broker, sent } = harness();
  const first = broker.submit(req("claude", "open", { url: "https://example.com/", tab: "shared" }));
  broker.onExtensionMessage({ type: "result", id: "c1", ok: true, origin: "https://example.com", url: "https://example.com/" });
  await first;
  const second = broker.submit(req("codex", "open", { url: "https://example.org/", tab: "shared" }));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].tab, "shared-codex");
  broker.onExtensionMessage({ type: "result", id: "c2", ok: true, origin: "https://example.org", url: "https://example.org/" });
  const response = await second;
  assert.equal(response.ok, true);
  const data = (response as { data: { tab: string; note: string } }).data;
  assert.equal(data.tab, "shared-codex");
  assert.match(data.note, /@claude is using tab "shared"/);
});

test("the loop guard refuses the third identical state-changing action in a row and reads never count", async () => {
  const { broker, sent } = harness({ loopGuard: { repeat: 3, budget: 100, windowMs: 60_000 } });
  for (let i = 1; i <= 2; i += 1) {
    const pending = broker.submit(req("claude", "click", { selector: "#next", tab: "t" }));
    broker.onExtensionMessage({ type: "result", id: `c${i}`, ok: true, data: { clicked: true } });
    await pending;
  }
  const third = await broker.submit(req("claude", "click", { selector: "#next", tab: "t" }));
  assert.equal(third.ok, false);
  assert.match((third as { error: string }).error, /exact click 3 times in a row/);
  assert.equal(sent.length, 2);
  for (let i = 0; i < 4; i += 1) {
    const pending = broker.submit(req("claude", "read", { selector: "#next", tab: "t" }));
    broker.onExtensionMessage({ type: "result", id: `c${3 + i}`, ok: true, data: "x" });
    assert.equal((await pending).ok, true);
  }
});

test("the loop guard enforces an action budget per window", async () => {
  const { broker, advance } = harness({ loopGuard: { repeat: 99, budget: 3, windowMs: 60_000 } });
  for (let i = 1; i <= 3; i += 1) {
    const pending = broker.submit(req("claude", "click", { selector: `#b${i}`, tab: "t" }));
    broker.onExtensionMessage({ type: "result", id: `c${i}`, ok: true, data: {} });
    await pending;
    advance(9_000);
  }
  const over = await broker.submit(req("claude", "click", { selector: "#b4", tab: "t" }));
  assert.equal(over.ok, false);
  assert.match((over as { error: string }).error, /budget reached/);
  advance(120_000);
  const later = broker.submit(req("claude", "click", { selector: "#b5", tab: "t" }));
  broker.onExtensionMessage({ type: "result", id: "c4", ok: true, data: {} });
  assert.equal((await later).ok, true);
});

test("every reply carries what teammates did since the agent's last action, and tabs lists the whole room", async () => {
  const { broker, sent } = harness();
  const a = broker.submit(req("claude", "open", { url: "https://example.com/", tab: "a" }));
  broker.onExtensionMessage({ type: "result", id: "c1", ok: true, origin: "https://example.com", url: "https://example.com/" });
  assert.equal((await a).room, undefined);
  const b = broker.submit(req("codex", "open", { url: "https://example.org/", tab: "b" }));
  broker.onExtensionMessage({ type: "result", id: "c2", ok: true, origin: "https://example.org", url: "https://example.org/" });
  const codexReply = await b;
  assert.equal(codexReply.ok, true);
  assert.match((codexReply.room ?? []).join(" "), /@claude: .*\[tab a\]/);
  const read = broker.submit(req("claude", "read", { tab: "a", selector: "h1" }));
  broker.onExtensionMessage({ type: "result", id: "c3", ok: true, data: "Example" });
  assert.match(((await read).room ?? []).join(" "), /@codex: .*\[tab b\]/);
  const list = await broker.submit(req("claude", "tabs"));
  assert.equal(list.ok, true);
  const tabsData = list.data as Array<{ tab: string; lastBy?: string; mine: boolean }>;
  assert.deepEqual(tabsData.map((tab) => [tab.tab, tab.mine]).sort(), [["a", true], ["b", false]]);
  assert.equal(sent.length, 3, "listing tabs never reaches the extension");
});

test("opening the page a teammate already has open in the shared tab joins it without reloading", async () => {
  const { broker, sent, notices } = harness();
  const first = broker.submit(req("claude", "open", { url: "https://example.com/doc", tab: "room" }));
  broker.onExtensionMessage({ type: "result", id: "c1", ok: true, origin: "https://example.com", url: "https://example.com/doc" });
  await first;
  const before = sent.length;
  const joined = await broker.submit(req("codex", "open", { url: "https://example.com/doc/", tab: "room" }));
  assert.equal(joined.ok, true);
  assert.equal(sent.length, before, "no command reaches the browser, so nothing reloads under the teammate");
  assert.match(String((joined.data as { note: string }).note), /already open/);
  assert.ok(notices.some((n) => (n.presence as { agent: string }).agent === "codex"), "the joiner still gets a cursor on the page");
  const elsewhere = broker.submit(req("codex", "open", { url: "https://example.org/", tab: "room" }));
  assert.equal(sent.length, before + 1, "a different page is still a real navigation (into a new tab if a teammate is on it)");
  broker.onExtensionMessage({ type: "result", id: "c2", ok: true, origin: "https://example.org", url: "https://example.org/" });
  await elsewhere;
});

test("opening a search URL is refused, and the refusal tells the agent to use the page's own search box", async () => {
  const { broker, sent } = harness();
  const refused = await broker.submit(req("codex", "open", { url: "https://x.com/search?q=openai&src=typed_query", tab: "shared" }));
  assert.equal(refused.ok, false);
  assert.match(String((refused as { error?: string }).error), /search box/);
  assert.equal(sent.length, 0, "nothing reaches the browser");
  for (const url of ["https://www.google.com/search?q=cats", "https://example.com/?s=hello", "https://site.test/find?query=abc", "https://site.test/x?Search=y"]) {
    assert.equal((await broker.submit(req("codex", "open", { url, tab: "shared" }))).ok, false, url);
  }
});

test("ordinary pages, including paths that contain the word search, still open", async () => {
  const { broker, sent } = harness();
  const opened = broker.submit(req("codex", "open", { url: "https://x.com/", tab: "shared" }));
  assert.equal(sent.length, 1);
  broker.onExtensionMessage({ type: "result", id: "c1", ok: true, origin: "https://x.com", url: "https://x.com/" });
  assert.equal((await opened).ok, true);
  const pathOnly = broker.submit(req("codex", "open", { url: "http://127.0.0.1:1/search/spec", tab: "other" }));
  assert.equal(sent.length, 2);
  broker.onExtensionMessage({ type: "result", id: "c2", ok: true, origin: "http://127.0.0.1:1", url: "http://127.0.0.1:1/search/spec" });
  assert.equal((await pathOnly).ok, true);
});

test("repeated snapshots are observation, not a loop", async () => {
  const { broker } = harness({ loopGuard: { repeat: 3, budget: 50, windowMs: 60_000 } });
  for (let i = 1; i <= 5; i += 1) {
    const pending = broker.submit(req("codex", "snapshot", { tab: "shared" }));
    broker.onExtensionMessage({ type: "result", id: `c${i}`, ok: true, data: { elements: [] } });
    const result = await pending;
    assert.notEqual((result as { error?: string }).error?.includes("exact"), true, `snapshot ${i} must not be refused as a loop`);
  }
});

test("a page of a site that is already open cannot be opened by URL unless the owner typed that URL", async () => {
  const { broker } = harness();
  const first = broker.submit(req("codex", "open", { url: "https://x.com/", tab: "shared" }));
  broker.onExtensionMessage({ type: "result", id: "c1", ok: true, origin: "https://x.com", url: "https://x.com/" });
  assert.equal((await first).ok, true, "the first visit to a site may open any page");

  const jump = await broker.submit(req("codex", "open", { url: "https://x.com/illscience", tab: "shared" }));
  assert.equal(jump.ok, false);
  assert.match(String((jump as { error?: string }).error), /already open/);
  const sideTab = await broker.submit(req("codex", "open", { url: "https://x.com/illscience", tab: "other" }));
  assert.equal(sideTab.ok, false, "a different tab name does not bypass the rule");

  broker.noteOwnerUrls?.("please open https://x.com/illscience/status/1 for me");
  const typed = broker.submit(req("codex", "open", { url: "https://x.com/illscience/status/1", tab: "shared" }));
  broker.onExtensionMessage({ type: "result", id: "c2", ok: true, origin: "https://x.com", url: "https://x.com/illscience/status/1" });
  assert.equal((await typed).ok, true, "a URL the owner typed opens directly");

  const other = broker.submit(req("codex", "open", { url: "https://example.org/", tab: "third" }));
  broker.onExtensionMessage({ type: "result", id: "c3", ok: true, origin: "https://example.org", url: "https://example.org/" });
  assert.equal((await other).ok, true, "a different site is a first visit");

  const back = broker.submit(req("codex", "open", { url: "https://x.com/", tab: "shared" }));
  broker.onExtensionMessage({ type: "result", id: "c4", ok: true, origin: "https://x.com", url: "https://x.com/" });
  assert.equal((await back).ok, true, "a page the room already visited can be reopened");
});

test("m9r_web_do can include press and scroll steps (the batch claim flag is accepted by the power validator)", async () => {
  const { broker, sent } = harness();
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  void broker.submitBatch({
    agent: "codex", provider: "codex", sessionId: "codex-s", tab: "research",
    steps: [{ action: "open", url: "https://example.test/" }, { action: "press", args: { key: "Enter" } }, { action: "scroll", args: { to: "bottom" } }],
  });
  broker.onExtensionMessage({ type: "result", id: "c1", ok: true, origin: "https://example.test", url: "https://example.test/" });
  await flush();
  assert.equal(sent[1]?.action, "press", "the press step reaches the browser instead of failing validation");
  broker.onExtensionMessage({ type: "result", id: "c2", ok: true, data: { pressed: true }, origin: "https://example.test", url: "https://example.test/" });
  await flush();
  assert.equal(sent[2]?.action, "scroll");
});

test("m9r_web_do runs ordered steps under one tab claim, returns state after each action, and stops at the first failure", async () => {
  const { broker, sent } = harness();
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const batch = broker.submitBatch({
    agent: "codex", provider: "codex", sessionId: "codex-s", tab: "research", includePageState: true,
    steps: [
      { action: "open", url: "https://example.test/" },
      { action: "click", selector: "button.preview" },
      { action: "type", selector: "@m9r-ref:e2", text: "query" },
    ],
  });
  assert.equal(sent[0]?.action, "open");
  broker.onExtensionMessage({ type: "result", id: "c1", ok: true, origin: "https://example.test", url: "https://example.test/" });
  await flush();
  assert.equal(sent[1]?.action, "snapshot");
  broker.onExtensionMessage({ type: "result", id: "c2", ok: true, data: "URL: https://example.test/\nTitle: Example\nText:\nBefore\nControls (act by ref):\ne1 [button] \"Preview\"" });
  await flush();
  assert.equal(sent[2]?.action, "click");
  broker.onExtensionMessage({ type: "result", id: "c3", ok: true, data: { clicked: true }, origin: "https://example.test", url: "https://example.test/" });
  await flush();
  assert.equal(sent[3]?.action, "snapshot");
  broker.onExtensionMessage({ type: "result", id: "c4", ok: true, data: "URL: https://example.test/\nTitle: Example\nText:\nAfter\nControls (act by ref):\ne1 [button] \"Preview\"" });
  await flush();
  assert.equal(sent[4]?.action, "type");
  broker.onExtensionMessage({ type: "result", id: "c5", ok: false, error: "the snapshot ref or selector is stale" });
  await flush();
  const result = await batch;
  assert.equal(result.ok, false);
  assert.equal(result.failedAt, 2);
  assert.equal(result.steps.length, 3);
  assert.deepEqual(result.steps[0]?.response.pageState, { url: "https://example.test/", title: "Example", topControls: [{ ref: "e1", role: "button", name: "Preview", position: 1 }] });
  assert.equal(sent.length, 5, "the failed step must not dispatch a later step");
});

test("m9r_web_do parses the structured snapshot returned by the browser extension", async () => {
  const { broker, sent } = harness({ roomMode: "hands-off" });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const opened = broker.submit(req("codex", "open", { url: "https://example.test/products", tab: "research" }));
  broker.onExtensionMessage({ type: "result", id: "c1", ok: true, origin: "https://example.test", url: "https://example.test/products" });
  assert.equal((await opened).ok, true);

  const batch = broker.submitBatch({
    agent: "codex", provider: "codex", sessionId: "codex-s", tab: "research", includePageState: true,
    steps: [{ action: "click", selector: "a.product" }],
  });
  assert.equal(sent[1]?.action, "click");
  broker.onExtensionMessage({ type: "result", id: "c2", ok: true, data: { clicked: true }, origin: "https://example.test", url: "https://example.test/product/P-34" });
  await flush();
  assert.equal(sent[2]?.action, "snapshot");
  broker.onExtensionMessage({
    type: "result", id: "c3", ok: true,
    data: {
      url: "https://example.test/product/P-34", title: "Product P-34",
      text: "Product id: P-34\nCertification code: A7K2QM",
      elements: [{ ref: "e1", role: "link", name: "Back to products" }],
    },
  });
  const result = await batch;
  assert.equal(result.ok, true);
  assert.equal(result.steps[0]?.response.changedPart, "Product id: P-34\nCertification code: A7K2QM");
  assert.deepEqual(result.steps[0]?.response.pageState, {
    url: "https://example.test/product/P-34", title: "Product P-34",
    topControls: [{ ref: "e1", role: "link", name: "Back to products", position: 1 }],
  });
});
