import test from "node:test";
import assert from "node:assert/strict";

import { explicitlyMentionedAgentKinds, unavailableExplicitAgentKinds } from "../src/lib/conversation-routing.ts";

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
