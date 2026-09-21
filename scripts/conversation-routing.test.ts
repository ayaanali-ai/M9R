import test from "node:test";
import assert from "node:assert/strict";

import {
  agentAvailabilityUnknownNoticeBody,
  explicitlyMentionedAgentKinds,
  isAgentAvailabilityNoticeBody,
  unavailableAgentNoticeBody,
  unavailableExplicitAgentKinds,
} from "../src/lib/conversation-routing.ts";

test("explicit provider aliases resolve to one canonical agent kind", () => {
  assert.deepEqual(
    explicitlyMentionedAgentKinds("@Claude and @codex compare these", []),
    ["claude-code", "codex"],
  );
});

test("offline detection distinguishes missing and stale runtimes", () => {
  const now = Date.parse("2026-09-09T20:00:00.000Z");
  assert.deepEqual(
    unavailableExplicitAgentKinds("@codex @claude say hi", [
      { agent_kind: "codex", status: "active", last_seen_at: "2026-09-09T19:50:00.000Z" },
    ], now),
    [
      { kind: "codex", state: "offline" },
      { kind: "claude-code", state: "not_connected" },
    ],
  );
});

test("recently seen providers do not produce a false offline warning", () => {
  const now = Date.parse("2026-09-09T20:00:00.000Z");
  assert.deepEqual(
    unavailableExplicitAgentKinds("@opencode say hi", [
      { agent_kind: "opencode", status: "active", last_seen_at: "2026-09-09T19:59:30.000Z" },
    ], now),
    [],
  );
});

test("an active provider missing from the channel is reported as unroutable", () => {
  const now = Date.parse("2026-09-09T20:00:00.000Z");
  const unavailable = unavailableExplicitAgentKinds("@codex please take this", [
    { agent_kind: "codex", status: "active", last_seen_at: "2026-09-09T19:59:30.000Z", is_channel_member: false },
  ], now);
  assert.deepEqual(unavailable, [{ kind: "codex", state: "not_in_channel" }]);
  assert.match(unavailableAgentNoticeBody(unavailable), /Codex is not a member of this channel/);
});

test("availability notices are identifiable and never become an agent wake signal", () => {
  assert.equal(isAgentAvailabilityNoticeBody(unavailableAgentNoticeBody([{ kind: "codex", state: "offline" }])), true);
  assert.equal(isAgentAvailabilityNoticeBody(agentAvailabilityUnknownNoticeBody()), true);
  assert.equal(isAgentAvailabilityNoticeBody("This channel is paused until a human posts."), false);
});

test("availability does not depend on connection row order when a provider has several connections", () => {
  const now = Date.now();
  const fresh = { agent_kind: "codex", status: "active", last_seen_at: new Date(now - 5_000).toISOString(), is_channel_member: true };
  const stale = { agent_kind: "codex", status: "active", last_seen_at: new Date(now - 10 * 60_000).toISOString(), is_channel_member: true };
  const outsider = { agent_kind: "codex", status: "active", last_seen_at: new Date(now - 5_000).toISOString(), is_channel_member: false };
  for (const rows of [[fresh, stale], [stale, fresh], [outsider, fresh, stale], [stale, outsider, fresh]]) {
    assert.deepEqual(unavailableExplicitAgentKinds("@codex hi", rows, now), []);
  }
  assert.deepEqual(unavailableExplicitAgentKinds("@codex hi", [outsider, stale], now), [{ kind: "codex", state: "offline" }]);
  assert.deepEqual(unavailableExplicitAgentKinds("@codex hi", [outsider], now), [{ kind: "codex", state: "not_in_channel" }]);
});
