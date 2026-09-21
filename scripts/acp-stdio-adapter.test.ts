import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  mapAcpSessionUpdate,
  mapAcpUsageEvent,
  workspaceRelativeAcpPath,
  devMcpServerDescriptor,
  codexAcpServerEnv,
  openCodeConfigContent,
  matchesDenyPattern,
  commandTouchesDeniedPath,
  responseForPermission,
  shouldResetPermissionMode,
} from "@/lib/bridge/acp-stdio-adapter";

test("Codex ACP uses an explicit CODEX_PATH before every platform fallback", () => {
  assert.deepEqual(
    codexAcpServerEnv({ CODEX_PATH: "C:/custom/codex.cmd", APPDATA: "C:/Users/test/AppData/Roaming" }, "win32", () => true),
    { CODEX_PATH: "C:/custom/codex.cmd" },
  );
});

test("Codex ACP uses the installed Windows CLI shim so it shares the user's login", () => {
  const expected = "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd";
  assert.deepEqual(
    codexAcpServerEnv({ APPDATA: "C:\\Users\\test\\AppData\\Roaming" }, "win32", (path) => path === expected),
    { CODEX_PATH: expected },
  );
});

test("Codex ACP leaves its bundled fallback intact when no installed CLI is available", () => {
  assert.deepEqual(codexAcpServerEnv({}, "linux", () => false), {});
  assert.deepEqual(codexAcpServerEnv({ APPDATA: "C:\\Users\\test\\AppData\\Roaming" }, "win32", () => false), {});
});

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prior: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) prior[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("devMcpServerDescriptor is empty when the feature flag is off (default)", () => {
  withEnv({ MISSION_DEV_MCP_TOOLS_ENABLED: undefined }, () => {
    assert.deepEqual(devMcpServerDescriptor("/repo", "channel-abc"), []);
  });
});

test("devMcpServerDescriptor threads OATHLOCK_APP_URL/OATHLOCK_AGENT_TOKEN (bridge-wide) and the per-call missionId into the dev-mcp subprocess's own env -- this is what makes send_message work at all", () => {
  withEnv({ MISSION_DEV_MCP_TOOLS_ENABLED: "true", OATHLOCK_APP_URL: "https://oathlock.example", OATHLOCK_AGENT_TOKEN: "agent-tok-123" }, () => {
    const servers = devMcpServerDescriptor("/repo", "channel-abc-123");
    assert.equal(servers.length, 1);
    const server = servers[0] as { name: string; env?: Array<{ name: string; value: string }> };
    assert.equal(server.name, "oathlock-dev-tools");
    const env = Object.fromEntries((server.env ?? []).map((entry) => [entry.name, entry.value]));
    assert.equal(env.OATHLOCK_APP_URL, "https://oathlock.example");
    assert.equal(env.OATHLOCK_AGENT_TOKEN, "agent-tok-123");
    assert.equal(env.OATHLOCK_MISSION_ID, "channel-abc-123");
  });
});

test("devMcpServerDescriptor a second call with a different missionId (a different session) carries its own missionId, not a stale one", () => {
  withEnv({ MISSION_DEV_MCP_TOOLS_ENABLED: "true", OATHLOCK_APP_URL: "https://oathlock.example", OATHLOCK_AGENT_TOKEN: "tok" }, () => {
    const first = devMcpServerDescriptor("/repo", "channel-aaa")[0] as { env?: Array<{ name: string; value: string }> };
    const second = devMcpServerDescriptor("/repo", "channel-bbb")[0] as { env?: Array<{ name: string; value: string }> };
    const missionIdOf = (server: { env?: Array<{ name: string; value: string }> }) => server.env?.find((entry) => entry.name === "OATHLOCK_MISSION_ID")?.value;
    assert.equal(missionIdOf(first), "channel-aaa");
    assert.equal(missionIdOf(second), "channel-bbb");
  });
});

test("devMcpServerDescriptor omits an env entry rather than sending an empty value when app URL/token aren't set on this process", () => {
  withEnv({ MISSION_DEV_MCP_TOOLS_ENABLED: "true", OATHLOCK_APP_URL: undefined, OATHLOCK_AGENT_TOKEN: undefined }, () => {
    const server = devMcpServerDescriptor("/repo", "channel-abc")[0] as { env?: Array<{ name: string; value: string }> };
    const names = (server.env ?? []).map((entry) => entry.name);
    assert.equal(names.includes("OATHLOCK_APP_URL"), false);
    assert.equal(names.includes("OATHLOCK_AGENT_TOKEN"), false);
    assert.equal(names.includes("OATHLOCK_MISSION_ID"), true);
  });
});

test("OpenCode receives the governed MCP server through inline config without embedding the bearer token", () => {
  withEnv({ MISSION_DEV_MCP_TOOLS_ENABLED: "true", OATHLOCK_APP_URL: "https://oathlock.example", OATHLOCK_AGENT_TOKEN: "secret-token" }, () => {
    const raw = openCodeConfigContent("C:/repo", "channel-opencode");
    assert.ok(raw);
    assert.doesNotMatch(raw, /secret-token/);
    const config = JSON.parse(raw) as { mcp?: Record<string, { type?: string; command?: string[]; environment?: Record<string, string> }> };
    const server = config.mcp?.["oathlock-dev-tools"];
    assert.equal(server?.type, "local");
    assert.equal(server?.environment?.OATHLOCK_APP_URL, "{env:OATHLOCK_APP_URL}");
    assert.equal(server?.environment?.OATHLOCK_AGENT_TOKEN, "{env:OATHLOCK_AGENT_TOKEN}");
    assert.equal(server?.environment?.OATHLOCK_MISSION_ID, "channel-opencode");
    assert.ok(server?.command?.some((part) => part.includes("dev-mcp-server")));
  });
});

test("OpenCode permission config is emitted even when the dev-tools MCP feature flag is off", () => {
  withEnv({ MISSION_DEV_MCP_TOOLS_ENABLED: undefined }, () => {
    const raw = openCodeConfigContent("/repo", "channel-off");
    const config = JSON.parse(raw ?? "{}") as { permission?: Record<string, unknown>; mcp?: unknown };
    assert.deepEqual(config.permission, { edit: "ask", write: "ask", bash: "ask" });
    assert.equal(config.mcp, undefined);
  });
});

test("OpenCode MCP injection preserves a valid operator inline config", () => {
  withEnv({ MISSION_DEV_MCP_TOOLS_ENABLED: "true", OATHLOCK_APP_URL: "https://oathlock.example", OATHLOCK_AGENT_TOKEN: "tok" }, () => {
    const raw = openCodeConfigContent("C:/repo", "channel-opencode", JSON.stringify({ model: "provider/model", mcp: { existing: { type: "local", enabled: false } } }));
    const config = JSON.parse(raw ?? "{}") as { model?: string; mcp?: Record<string, unknown> };
    assert.equal(config.model, "provider/model");
    assert.ok(config.mcp?.existing);
    assert.ok(config.mcp?.["oathlock-dev-tools"]);
  });
});

test("ACP read tool updates become provider-observed file activity", () => {
  const event = mapAcpSessionUpdate({
    sessionId: "session-1",
    occurredAt: "2026-08-01T17:30:00.000Z",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      kind: "read",
      status: "in_progress",
      title: "Read src/app.tsx",
      locations: [{ path: "src/app.tsx" }],
      rawInput: { path: "src/app.tsx" },
    },
  });

  assert.deepEqual(event, {
    type: "provider.activity",
    sessionId: "session-1",
    occurredAt: "2026-08-01T17:30:00.000Z",
    payload: {
      type: "provider.activity",
      activityKind: "file.read",
      status: "started",
      summary: "Read src/app.tsx",
      filePath: "src/app.tsx",
      command: null,
      testName: null,
      testPassed: null,
      testFailed: null,
      testSkipped: null,
      reviewTarget: null,
      gitRef: null,
      oldText: null,
      newText: null,
      diffPatch: null,
      additions: null,
      deletions: null,
    },
  });
});

test("ACP file edit updates carry real diff content when the provider's own update includes it, and relativize an absolute path against the repo root", () => {
  const event = mapAcpSessionUpdate({
    sessionId: "session-1",
    occurredAt: "2026-08-01T17:30:00.000Z",
    repositoryRoot: "C:\\RunLeak\\runleak",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-2",
      kind: "edit",
      status: "completed",
      title: "Write app.md",
      locations: [{ path: "C:\\RunLeak\\runleak\\app.md" }],
      rawInput: { filePath: "C:\\RunLeak\\runleak\\app.md", content: "hello world" },
      content: [{ path: "C:\\RunLeak\\runleak\\app.md", oldText: "hello", newText: "hello world", type: "diff" }],
    },
  });

  assert.equal((event?.payload as { filePath?: string })?.filePath, "app.md");
  assert.equal((event?.payload as { oldText?: string })?.oldText, "hello");
  assert.equal((event?.payload as { newText?: string })?.newText, "hello world");
});

test("matchesDenyPattern: a bare pattern matches an exact path, a globstar matches an entire subtree, and neither over-matches", () => {
  // Exact filename, anywhere it's asked about literally.
  assert.equal(matchesDenyPattern(".env", ".env"), true);
  assert.equal(matchesDenyPattern(".env.example", ".env"), false);
  // "*" is single-segment: matches within one directory, not across "/".
  assert.equal(matchesDenyPattern("secrets/key.pem", "secrets/*.pem"), true);
  assert.equal(matchesDenyPattern("secrets/nested/key.pem", "secrets/*.pem"), false);
  // "**" is the deliberate any-depth escape hatch.
  assert.equal(matchesDenyPattern("secrets/nested/deep/key.pem", "secrets/**"), true);
  assert.equal(matchesDenyPattern("secrets/key.pem", "secrets/**"), true);
  assert.equal(matchesDenyPattern("not-secrets/key.pem", "secrets/**"), false);
  // Case-insensitive, matching this codebase's own path normalization.
  assert.equal(matchesDenyPattern("SECRETS/KEY.PEM", "secrets/**"), true);
  // Empty inputs never match anything, including each other.
  assert.equal(matchesDenyPattern("", "secrets/**"), false);
  assert.equal(matchesDenyPattern("secrets/key.pem", ""), false);
});

test("commandTouchesDeniedPath: closes the live-caught shell-command bypass -- a denied path named plainly in a shell command is caught, not just in a structured edit tool call", () => {
  // The exact live-caught bypass: a naive shell write to a denied path.
  assert.equal(commandTouchesDeniedPath('echo "should not be allowed" > diagnostic-denied-test.md', ["diagnostic-denied-*.md"]), "diagnostic-denied-*.md");
  assert.equal(commandTouchesDeniedPath("Set-Content -Path diagnostic-denied-test.md -Value hi", ["diagnostic-denied-*.md"]), "diagnostic-denied-*.md");
  assert.equal(commandTouchesDeniedPath("cat secrets/key.pem", ["secrets/**"]), "secrets/**");
  // A command that never names the denied path at all is not flagged.
  assert.equal(commandTouchesDeniedPath("echo hello > safe.md", ["diagnostic-denied-*.md"]), null);
  // No patterns configured -- no restriction, matching the opt-in default.
  assert.equal(commandTouchesDeniedPath("cat secrets/key.pem", []), null);
  // Empty command never matches anything.
  assert.equal(commandTouchesDeniedPath("", ["secrets/**"]), null);
});

test("ACP execute updates become bounded command activity", () => {
  const event = mapAcpSessionUpdate({
    sessionId: "session-1",
    occurredAt: "2026-08-01T17:30:01.000Z",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-2",
      kind: "execute",
      status: "completed",
      title: "Run npm test",
      rawInput: { command: "npm test" },
    },
  });

  assert.equal(event?.payload.activityKind, "command.completed");
  assert.equal(event?.payload.status, "succeeded");
  assert.equal(event?.payload.command, "npm test");
});

test("ACP activity drops machine-absolute paths before the Mission feed", () => {
  assert.equal(workspaceRelativeAcpPath("C:/Users/private/project/src/app.tsx"), null);
  assert.equal(workspaceRelativeAcpPath("/Users/private/project/src/app.tsx"), null);
  assert.equal(workspaceRelativeAcpPath("src/app.tsx"), "src/app.tsx");
});

test("generic ACP messages do not become unsupported work claims", () => {
  assert.equal(mapAcpSessionUpdate({
    sessionId: "session-1",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I am reviewing files" } },
  }), null);
});

test("ACP usage updates retain context telemetry instead of dropping Claude's used/size payload", () => {
  const event = mapAcpUsageEvent({
    sessionId: "session-1",
    occurredAt: "2026-08-09T20:00:00.000Z",
    usageBasis: "context_window",
    usage: { used: 4_200, size: 200_000, cost: { amount: 0.03, currency: "USD" } },
  });

  assert.deepEqual(event?.payload, {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    contextUsedTokens: 4_200,
    contextWindowTokens: 200_000,
    costUsd: 0.03,
    usageBasis: "context_window",
  });
});

test("ACP prompt response usage is retained as exact per-turn token telemetry", () => {
  const event = mapAcpUsageEvent({
    sessionId: "session-1",
    occurredAt: "2026-08-09T20:00:01.000Z",
    usageBasis: "prompt_turn",
    usage: { inputTokens: 1_200, outputTokens: 800, totalTokens: 2_000 },
  });

  assert.deepEqual(event?.payload, {
    inputTokens: 1_200,
    outputTokens: 800,
    totalTokens: 2_000,
    contextUsedTokens: null,
    contextWindowTokens: null,
    costUsd: null,
    usageBasis: "prompt_turn",
  });
});

test("a failed prompt's provider.failed reason includes the provider subprocess's own stderr, not just the generic ACP wrapper error", () => {
  // Regression test for a real, live-observed gap: codex-acp's own JSON-RPC
  // error surfaced to the user as an opaque "Internal error" with nothing
  // else to go on -- even though this adapter was already tailing the
  // subprocess's real stderr into state.stderrTail (used by the process-exit
  // path just above this) and simply never included it in the prompt
  // rejection's own failure reason. The real cause (a stack trace, an API
  // error from the model backend, etc.) is usually sitting right there in
  // stderr and was being silently discarded on this specific path only.
  const src = readFileSync(new URL("../src/lib/bridge/acp-stdio-adapter.ts", import.meta.url), "utf8");
  const promptStart = src.indexOf("async *prompt(input:");
  assert.ok(promptStart > -1, "prompt() not found");
  const promptEnd = src.indexOf("\n  async ", promptStart + 1);
  const promptBody = src.slice(promptStart, promptEnd);
  assert.match(promptBody, /state\.stderrTail/, "the catch handler must read the already-tailed provider stderr");
  assert.match(promptBody, /provider stderr:/, "the failure reason must label and include the stderr snippet, not silently append it");
});

test("a failed prompt's reason reads the JSON-RPC error's own .data field, not just its generic .message", () => {
  // Regression test for a real, live-observed gap: Codex reported a genuine,
  // actionable failure -- a usage-limit message naming the exact reset date
  // -- as the thrown RequestError's own `.data` field (jsonrpc.js's
  // RequestError has code/message/data), and the human only ever saw the
  // generic top-level `.message` ("Internal error"). Confirmed live by
  // reading Codex's own session rollout log for the exact failing turn.
  const src = readFileSync(new URL("../src/lib/bridge/acp-stdio-adapter.ts", import.meta.url), "utf8");
  const promptStart = src.indexOf("async *prompt(input:");
  const promptEnd = src.indexOf("\n  async ", promptStart + 1);
  const promptBody = src.slice(promptStart, promptEnd);
  assert.match(promptBody, /"data" in error/, "the catch handler must check for a .data field on the thrown error");
  assert.match(promptBody, /dataRecord\.message/, "an object .data with its own .message field (the shape Codex sends) must be read out");
});

test("approving a permission selects allow_once, never a listed allow_always", () => {
  const params = { options: [
    { optionId: "always", name: "Always allow", kind: "allow_always" },
    { optionId: "once", name: "Allow once", kind: "allow_once" },
    { optionId: "no", name: "Reject", kind: "reject_once" },
  ] } as never;
  assert.deepEqual(responseForPermission(params, true), { outcome: { outcome: "selected", optionId: "once" } });
});

test("approving with no allow_once option cancels instead of guessing", () => {
  const params = { options: [{ optionId: "always", name: "Always allow", kind: "allow_always" }] } as never;
  assert.deepEqual(responseForPermission(params, true), { outcome: { outcome: "cancelled" } });
  assert.deepEqual(responseForPermission(params, false), { outcome: { outcome: "cancelled" } });
});

test("only bypassPermissions is reset to default; the user's other modes are respected", () => {
  assert.equal(shouldResetPermissionMode("bypassPermissions"), true);
  for (const mode of ["default", "acceptEdits", "plan", undefined]) assert.equal(shouldResetPermissionMode(mode), false);
});
