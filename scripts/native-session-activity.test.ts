import assert from "node:assert/strict";
import test from "node:test";
import { buildFeed, type FeedInput, type SessionProbe } from "../src/lib/native/feed-core";
import { claudeTranscriptPath, lastClaudeActivity, lastCodexActivity } from "../src/lib/native/session-activity-core";

const claudeLine = (content: unknown[]) => JSON.stringify({ type: "assistant", message: { role: "assistant", content } });
const codexLine = (payload: Record<string, unknown>) => JSON.stringify({ type: "response_item", payload });

test("the last Claude Code step becomes a plain phrase with only a verb and a short target", () => {
  const tail = (content: unknown[]) => ["{cut off first line", claudeLine([{ type: "text", text: "earlier words" }]), claudeLine(content)].join("\n");
  assert.equal(lastClaudeActivity(tail([{ type: "tool_use", name: "Read", input: { file_path: "C:\\RunLeak\\runleak\\src\\lib\\native\\feed-core.ts" } }])), "Reading feed-core.ts");
  assert.equal(lastClaudeActivity(tail([{ type: "tool_use", name: "Edit", input: { file_path: "/a/b/page.tsx", old_string: "SECRET BODY", new_string: "x" } }])), "Editing page.tsx");
  assert.equal(lastClaudeActivity(tail([{ type: "tool_use", name: "Bash", input: { command: "npm run build" } }])), "Running npm run build");
  assert.equal(lastClaudeActivity(tail([{ type: "tool_use", name: "PowerShell", input: { command: "$bin = \"$env:USERPROFILE\\.m9r\\bin\"; Rename-Item ...", description: "Swap the broker program" } }])), "Swap the broker program", "the tool's own short description wins over raw command text");
  assert.equal(lastClaudeActivity(tail([{ type: "tool_use", name: "Grep", input: { pattern: "projectRoomId" } }])), "Searching for projectRoomId");
  assert.equal(lastClaudeActivity(tail([{ type: "tool_use", name: "mcp__m9r__m9r_web_open", input: {} }])), "Using m9r_web_open");
  assert.equal(lastClaudeActivity(tail([{ type: "text", text: "Here is the answer" }])), "Writing a reply");
  assert.equal(lastClaudeActivity(tail([{ type: "thinking", thinking: "..." }])), "Thinking");
  assert.equal(lastClaudeActivity("nothing recognisable here"), null);
  assert.ok(!(lastClaudeActivity(tail([{ type: "tool_use", name: "Edit", input: { file_path: "/a/page.tsx", old_string: "SECRET BODY" } }])) ?? "").includes("SECRET"), "file contents are never shown");
});

test("a new turn with no tool call yet shows nothing, never the previous turn's last step repeated", () => {
  const priorTurn = claudeLine([{ type: "tool_use", name: "Bash", input: { command: "npm run build" } }]);
  const newUserTurn = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "do the next thing" }] } });
  assert.equal(lastClaudeActivity([priorTurn, newUserTurn].join("\n")), null, "the old turn's Bash step must not bleed into the new, as-yet-toolless turn");
  // Once the new turn itself uses a tool, that (not the old one) is what shows.
  const newTool = claudeLine([{ type: "tool_use", name: "Read", input: { file_path: "/a/new.ts" } }]);
  assert.equal(lastClaudeActivity([priorTurn, newUserTurn, newTool].join("\n")), "Reading new.ts");
});

test("the last Codex step is read from its rollout lines, shell wrappers are trimmed off", () => {
  assert.equal(lastCodexActivity(["{cut", codexLine({ type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["powershell.exe", "-Command", "npm test"] }) })].join("\n")), "Running npm test");
  assert.equal(lastCodexActivity(codexLine({ type: "local_shell_call", action: { command: ["git", "status"] } })), "Running git status");
  assert.equal(lastCodexActivity(codexLine({ type: "function_call", name: "apply_patch", arguments: "*** Begin Patch" })), "Editing files");
  assert.equal(lastCodexActivity(codexLine({ type: "reasoning" })), "Thinking");
  assert.equal(lastCodexActivity(codexLine({ type: "message", role: "assistant" })), "Writing a reply");
  assert.equal(lastCodexActivity(codexLine({ type: "message", role: "user" })), null);
});

test("a new Codex turn with no tool call yet shows nothing, never the previous turn's last step repeated", () => {
  const priorTurn = codexLine({ type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["npm", "run", "build"] }) });
  const newUserTurn = codexLine({ type: "message", role: "user" });
  assert.equal(lastCodexActivity([priorTurn, newUserTurn].join("\n")), null, "the old turn's shell step must not bleed into the new, as-yet-toolless turn");
  const newTool = codexLine({ type: "local_shell_call", action: { command: ["git", "status"] } });
  assert.equal(lastCodexActivity([priorTurn, newUserTurn, newTool].join("\n")), "Running git status");
});

test("Claude's transcript folder is the working folder with symbols turned into dashes", () => {
  assert.equal(claudeTranscriptPath("C:\\Users\\kaina", "C:\\RunLeak\\runleak", "abc"), "C:\\Users\\kaina/.claude/projects/C--RunLeak-runleak/abc.jsonl");
});

const NOW = new Date("2026-10-03T12:00:00Z");
const feedInput = (probes: Record<string, SessionProbe>): FeedInput => ({
  now: NOW,
  endpoints: [{ handle: "claude", provider: "claude-code", lastSeenAt: "2026-10-03T11:59:00Z" }],
  sessions: [{ handle: "claude", provider: "claude-code", sessionId: "s1", cwd: "C:/p", firstSeenAt: "2026-10-03T11:00:00Z", lastSeenAt: "2026-10-03T11:59:00Z" }],
  tasks: [], events: [], probes, pendingIds: new Set(),
});

test("the feed carries what an open working session is doing, redacted, and nothing for an idle one", () => {
  const working = buildFeed(feedInput({ s1: { live: "live", turn: "working", doing: "Running curl -H 'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwx' https://x.test" } }), null).agents.find((a) => a.handle === "claude")!;
  assert.equal(working.state, "open_working");
  assert.match(working.doing ?? "", /^Running curl/);
  assert.ok(!(working.doing ?? "").includes("sk-ant-api03"), "secrets are redacted before the feed is written");
  const idle = buildFeed(feedInput({ s1: { live: "live", turn: "idle", doing: "Reading old.ts" } }), null).agents.find((a) => a.handle === "claude")!;
  assert.equal(idle.doing, null);
});
