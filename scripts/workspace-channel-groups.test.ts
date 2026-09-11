import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILT_IN_CHANNEL_ORDER,
  channelGroupForConversation,
  isDiagnosticConversation,
} from "@/lib/workspace-channel-groups";

test("built-in channels are identified and ordered as core rooms", () => {
  assert.deepEqual(BUILT_IN_CHANNEL_ORDER, ["general", "agents", "activity"]);
  assert.equal(channelGroupForConversation({ channel_slug: "general", channel_kind: "channel", topic: "General" }), "core");
  assert.equal(channelGroupForConversation({ channelSlug: "activity", channelKind: "channel", topic: "Activity" }), "core");
});

test("slugged human channels stay workspace-visible even when their name resembles a test", () => {
  assert.equal(isDiagnosticConversation({ channel_slug: "routing-plan", channel_kind: "channel", topic: "Routing plan" }), false);
  assert.equal(channelGroupForConversation({ channel_slug: "routing-plan", channel_kind: "channel", topic: "Routing plan" }), "workspace");
});

test("un-slugged test and routing conversations are diagnostics, not core rooms", () => {
  assert.equal(isDiagnosticConversation({ channel_kind: "channel", topic: "ROUTING-ISOLATION-20260813" }), true);
  assert.equal(channelGroupForConversation({ channel_kind: "channel", topic: "A2A test: read-only git check from codex" }), "diagnostic");
  assert.equal(channelGroupForConversation({ channel_kind: "channel", topic: "Review implementation handoff" }), "agent");
});

test("direct messages remain separate from channel groups", () => {
  assert.equal(channelGroupForConversation({ channel_kind: "dm", channel_slug: "dm-connection", topic: "Codex" }), "direct");
});
