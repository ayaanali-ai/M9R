import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../extensions/browser/src/presence-logic.js", import.meta.url), "utf8");

function logic() {
  const window: Record<string, unknown> = {};
  runInNewContext(source, { window, Date });
  return window.M9RPresenceLogic as {
    formatPresenceMessage: (value: unknown, now: number) => Record<string, unknown> | null;
    providerPresentation: (provider: string) => { label: string; glyph: string; color: string; asset: string | null; known: boolean };
    createPresenceFeed: () => {
      add: (value: unknown, now: number) => Record<string, unknown> | null;
      list: (now: number) => Array<Record<string, unknown>>;
    };
  };
}

test("a blocked notice keeps its flag and is not mistaken for a claim", () => {
  const formatted = logic().formatPresenceMessage({ id: "n1", agent: "codex", provider: "codex", message: "blocked: @claude has this tab", blocked: true, claimed: false }, 100);
  assert.equal(formatted?.blocked, true);
  assert.equal(formatted?.claimed, false);
  assert.equal(logic().formatPresenceMessage({ id: "n2", agent: "codex", message: "reading #a" }, 100)?.blocked, false);
});

test("presence formatting only displays safe summaries and ignores typed or page values", () => {
  const formatted = logic().formatPresenceMessage({
    id: "evt-1", agent: "claude", provider: "Claude-Code", message: "typing in #email\n",
    claimed: true, claimMs: 1200, target: { selector: "#email" },
    text: "private form value", value: "private form value", pageText: "private page text",
  }, 100);
  assert.equal(formatted?.message, "typing in #email");
  assert.equal(formatted?.provider, "Claude-Code");
  assert.equal(formatted?.claimed, true);
  assert.equal((formatted?.target as { selector: string }).selector, "#email");
  assert.equal("text" in (formatted ?? {}), false);
  assert.equal("value" in (formatted ?? {}), false);
  assert.equal("pageText" in (formatted ?? {}), false);
});

test("presence feed deduplicates event IDs, caps recent activity, and fades after four seconds", () => {
  const feed = logic().createPresenceFeed();
  assert.ok(feed.add({ id: "evt-1", agent: "a", message: "reading" }, 100));
  assert.equal(feed.add({ id: "evt-1", agent: "a", message: "reading" }, 101), null);
  for (let i = 2; i <= 14; i++) feed.add({ id: `evt-${i}`, agent: "a", message: `step ${i}` }, 100);
  assert.equal(feed.list(100).length, 12);
  assert.equal(feed.list(4100).length, 0);
});

test("provider badges normalize known launch slugs and keep unknown providers neutral", () => {
  const presence = logic();
  const presentation = (provider: string) => JSON.parse(JSON.stringify(presence.providerPresentation(provider)));
  assert.deepEqual(presentation("claude-code"), { label: "Claude", glyph: "C", color: "#c96442", asset: "assets/providers/claude.svg", known: true });
  assert.deepEqual(presentation("codex-cli"), { label: "Codex", glyph: "X", color: "#0f9d7a", asset: "assets/providers/codex.svg", known: true });
  assert.deepEqual(presentation("opencode"), { label: "OpenCode", glyph: "O", color: "#6a5acd", asset: "assets/providers/opencode.svg", known: true });
  assert.deepEqual(presentation("mystery-engine"), { label: "Mystery-engine", glyph: "M", color: "#6b7280", asset: null, known: false });
});
