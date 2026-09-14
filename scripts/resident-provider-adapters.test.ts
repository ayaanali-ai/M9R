import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

import {
  buildClaudeCodeLaunchSpec,
  buildCodexLaunchSpec,
  buildGenericJsonStdioLaunchSpec,
  compileBoundedWorkPacket,
  executeProviderLaunch,
  parseClaudeCodeResult,
  parseCodexResult,
  parseGenericJsonResult,
  resolveProviderModel,
  runProviderProcess,
} from "@/lib/resident-provider-adapters";
import {
  evaluatePacketExperiment,
  parseProviderResultEnvelope,
  resolveContextReferences,
} from "@/lib/agent-context-broker";

const grant = {
  grantId: "grant-provider-123",
  repositoryRoot: process.cwd(),
  task: "Inspect the resident adapter and return a concise finding.",
  allowedPaths: ["src/lib/resident-provider-adapters.ts"],
  prohibitedPaths: [".env*", ".oathlock/local.json"],
  maxDurationMs: 30_000,
  executionMode: "read_only" as const,
};

test("compiles a minimal agent-native work packet without weakening task context", () => {
  const packet = compileBoundedWorkPacket({
    ...grant,
    acceptanceCriteria: [
      "Identify unsafe provider launch behavior.",
      "Cite the exact file path for every finding.",
      "Identify unsafe provider launch behavior.",
    ],
    contextRefs: [
      "diff://run-123/current",
      "rule://workspace/resident-safety",
      "diff://run-123/current",
    ],
    maxContextFetches: 4,
  });

  assert.equal(packet.protocolVersion, "oathlock.work-packet.v1");
  assert.equal(packet.providerIdentity, "codex");
  assert.equal(packet.task, grant.task);
  assert.deepEqual(packet.acceptanceCriteria, [
    "Identify unsafe provider launch behavior.",
    "Cite the exact file path for every finding.",
  ]);
  assert.deepEqual(packet.contextRefs, [
    "diff://run-123/current",
    "rule://workspace/resident-safety",
  ]);
  assert.equal(packet.contextPolicy.mode, "on_demand");
  assert.equal(packet.contextPolicy.maxFetches, 4);
  assert.equal(packet.returnSchema, "oathlock.provider-result.v1");
  assert.equal("transcript" in packet, false);
});

test("work packets reject unsafe or unbounded context instead of silently degrading the helper", () => {
  assert.throws(() => compileBoundedWorkPacket({
    ...grant,
    acceptanceCriteria: ["Review the change."],
    contextRefs: ["https://example.com/untrusted-context"],
    maxContextFetches: 4,
  }), /context reference/i);

  assert.throws(() => compileBoundedWorkPacket({
    ...grant,
    acceptanceCriteria: ["Review the change."],
    contextRefs: ["diff://run-123/current"],
    maxContextFetches: 101,
  }), /context fetch/i);
});

test("provider prompts require structured needs-context rather than guessing", () => {
  const spec = buildCodexLaunchSpec({
    ...grant,
    acceptanceCriteria: ["Return evidence-backed findings."],
    contextRefs: ["diff://run-123/current"],
    maxContextFetches: 3,
  });

  assert.match(spec.stdin, /oathlock\.work-packet\.v1/);
  assert.match(spec.stdin, /needs_context/);
  assert.match(spec.stdin, /diff:\/\/run-123\/current/);
  assert.doesNotMatch(spec.stdin, /full transcript/i);
});

test("resident context broker resolves only authorized references within byte and fetch budgets", async () => {
  const reads: string[] = [];
  const result = await resolveContextReferences({
    refs: ["file://src/lib/resident-provider-adapters.ts", "diff://run-123/current"],
    allowedPaths: ["src/lib"],
    prohibitedPaths: ["src/lib/secrets"],
    maxFetches: 2,
    maxTotalBytes: 1_000,
  }, {
    readRepositoryFile: async (path) => { reads.push(path); return "export const safe = true;"; },
    readCurrentDiff: async (runId) => { reads.push(`diff:${runId}`); return "diff --git a/a.ts b/a.ts"; },
    readRetainedContext: async () => null,
  });

  assert.equal(result.status, "resolved");
  assert.deepEqual(reads, ["src/lib/resident-provider-adapters.ts", "diff:run-123"]);
  assert.equal(result.items.length, 2);
  assert.equal(result.fetchesUsed, 2);
  assert.ok(result.totalBytes > 0);
});

test("resident context broker refuses traversal, prohibited files, and oversized payloads", async () => {
  const deps = {
    readRepositoryFile: async () => "x".repeat(200),
    readCurrentDiff: async () => "diff",
    readRetainedContext: async () => null,
  };
  await assert.rejects(() => resolveContextReferences({
    refs: ["file://../.env"], allowedPaths: ["src"], prohibitedPaths: [".env"], maxFetches: 1, maxTotalBytes: 1_000,
  }, deps), /context reference/i);
  await assert.rejects(() => resolveContextReferences({
    refs: ["file://src/lib/secrets/token.ts"], allowedPaths: ["src/lib"], prohibitedPaths: ["src/lib/secrets"], maxFetches: 1, maxTotalBytes: 1_000,
  }, deps), /prohibited/i);
  await assert.rejects(() => resolveContextReferences({
    refs: ["file://src/large.ts"], allowedPaths: ["src"], prohibitedPaths: [], maxFetches: 1, maxTotalBytes: 100,
  }, deps), /byte budget/i);
});

test("structured helper results expose needs-context without accepting hidden transcript output", () => {
  const parsed = parseProviderResultEnvelope(JSON.stringify({
    status: "needs_context",
    summary: "Cannot verify the decision without its retained record.",
    requested_context_refs: ["decision://run-123/auth-strategy"],
    findings: [], evidence_refs: [], verification: [], failures: [], limitations: ["Decision record unavailable."],
  }));
  assert.equal(parsed.status, "needs_context");
  assert.deepEqual(parsed.requestedContextRefs, ["decision://run-123/auth-strategy"]);
  assert.throws(() => parseProviderResultEnvelope(JSON.stringify({
    status: "completed", summary: "done", transcript: "private reasoning",
    findings: [], evidence_refs: [], verification: [], failures: [], limitations: [],
  })), /transcript/i);
});

test("packet experiment gate refuses savings when quality declines or usage is unreported", () => {
  assert.deepEqual(evaluatePacketExperiment({
    legacy: { totalTokens: 10_000, qualityScore: 0.95, adopted: true, reworkRequired: false },
    packet: { totalTokens: 5_000, qualityScore: 0.90, adopted: true, reworkRequired: false },
  }), { decision: "hold", reason: "quality_regressed", tokenSavingsRatio: 0.5, qualityRatio: 0.9474 });

  assert.equal(evaluatePacketExperiment({
    legacy: { totalTokens: null, qualityScore: 0.95, adopted: true, reworkRequired: false },
    packet: { totalTokens: 5_000, qualityScore: 0.95, adopted: true, reworkRequired: false },
  }).reason, "usage_unreported");

  assert.equal(evaluatePacketExperiment({
    legacy: { totalTokens: 10_000, qualityScore: 0.95, adopted: true, reworkRequired: false },
    packet: { totalTokens: 6_000, qualityScore: 0.96, adopted: true, reworkRequired: false },
  }).decision, "enable_packet");
});

test("Codex launch uses stdin, JSONL, an ephemeral session, and a bounded sandbox", () => {
  const spec = buildCodexLaunchSpec(grant);
  const commandOffset = process.platform === "win32" && process.env.APPDATA ? 1 : 0;
  assert.equal(spec.executable, commandOffset ? process.execPath : "codex");
  assert.equal(spec.args[commandOffset], "exec");
  assert.ok(spec.args.includes("--ignore-user-config"));
  assert.ok(spec.args.includes("mcp_servers={}"));
  assert.ok(spec.args.includes("--json"));
  assert.ok(spec.args.includes("--ephemeral"));
  assert.ok(spec.args.includes("read-only"));
  assert.equal(spec.args.at(-1), "-");
  assert.doesNotMatch(spec.args.join(" "), /Inspect the resident adapter/);
  assert.match(spec.stdin, /grant-provider-123/);
  assert.match(spec.stdin, /\.oathlock\/local\.json/);
  assert.equal(spec.shell, false);
});

test("Codex resident launch keeps project instructions enabled while isolating user config", () => {
  const spec = buildCodexLaunchSpec(grant);
  const projectDocIndex = spec.args.indexOf("project_doc_max_bytes=32768");
  assert.ok(projectDocIndex > -1, "resident Codex must receive a bounded project-doc budget");
  assert.equal(spec.args[projectDocIndex - 1], "-c");
  assert.ok(!spec.args.some((arg) => arg === "project_doc_max_bytes=0"), "zero disables AGENTS.md loading");
  assert.ok(spec.args.includes("--ignore-user-config"), "user config isolation must not disable project instructions");
});

test("Windows Codex launch avoids the non-executable npm cmd shim without enabling a shell", () => {
  const spec = buildCodexLaunchSpec(grant);
  assert.equal(spec.shell, false);
  if (process.platform === "win32" && process.env.APPDATA) {
    assert.equal(spec.executable, process.execPath);
    assert.match(spec.args[0], /@openai[\\/]codex[\\/]bin[\\/]codex\.js$/);
  }
});

test("Claude Code launch is noninteractive, structured, read-only, and does not bypass permissions", () => {
  const spec = buildClaudeCodeLaunchSpec(grant);
  assert.equal(spec.executable, "claude");
  assert.ok(spec.args.includes("--print"));
  assert.ok(spec.args.includes("stream-json"));
  assert.ok(spec.args.includes("--verbose"), "Claude requires --verbose with --print stream-json");
  assert.ok(spec.args.includes("--no-session-persistence"));
  assert.ok(spec.args.includes("--disable-slash-commands"));
  assert.ok(spec.args.includes("--safe-mode"), "delegated Claude must not inherit project CLAUDE.md or AGENTS.md identity");
  assert.ok(spec.args.includes("--system-prompt"));
  assert.ok(spec.args.includes("--json-schema"));
  const schema = JSON.parse(spec.args[spec.args.indexOf("--json-schema") + 1]) as { properties: { summary: { maxLength: number } } };
  assert.ok(schema.properties.summary.maxLength <= 600);
  assert.match(spec.stdin, /Delegated provider identity: Claude/);
  assert.match(spec.stdin, /Do not run the repository's normal M9R automatic workflow/);
  assert.match(spec.stdin, /do not .*produce an M9R Evidence Draft/i);
  assert.doesNotMatch(spec.stdin, /prepare .*M9R Evidence Draft/i);
  assert.ok(spec.args.includes("Read,Grep,Glob"));
  assert.ok(!spec.args.includes("--dangerously-skip-permissions"));
  assert.doesNotMatch(spec.args.join(" "), /Inspect the resident adapter/);
  assert.equal(spec.shell, false);
});

test("Codex delegated launches retain bounded project instructions and Codex identity", () => {
  const spec = buildCodexLaunchSpec(grant);
  assert.ok(spec.args.includes("project_doc_max_bytes=32768"));
  assert.ok(!spec.args.includes("project_doc_max_bytes=0"));
  assert.match(spec.stdin, /Delegated provider identity: Codex/);
  assert.match(spec.stdin, /Do not run the repository's normal M9R automatic workflow/);
});

test("provider model tiers use stable Claude aliases and let Codex keep its authenticated default model", () => {
  assert.equal(resolveProviderModel("claude-code", "economy", {}), "haiku");
  assert.equal(resolveProviderModel("claude-code", "balanced", {}), "sonnet");
  assert.equal(resolveProviderModel("claude-code", "frontier", {}), "opus");
  assert.equal(resolveProviderModel("codex", "economy", { OATHLOCK_CODEX_MODEL_ECONOMY: "codex-economy" }), "codex-economy");
  assert.equal(resolveProviderModel("codex", "economy", {}), null);
  const defaultCodex = buildCodexLaunchSpec({ ...grant, modelTier: "economy", requestedModel: undefined });
  assert.ok(!defaultCodex.args.includes("--model"));
  assert.ok(defaultCodex.args.includes('model_reasoning_effort="low"'));
});

test("resident launch specs pass the explicitly resolved model to the provider CLI", () => {
  const codex = buildCodexLaunchSpec({ ...grant, modelTier: "economy", requestedModel: "codex-economy" });
  const claude = buildClaudeCodeLaunchSpec({ ...grant, modelTier: "balanced", requestedModel: "sonnet" });
  assert.deepEqual(codex.args.slice(codex.args.indexOf("--model"), codex.args.indexOf("--model") + 2), ["--model", "codex-economy"]);
  assert.deepEqual(claude.args.slice(claude.args.indexOf("--model"), claude.args.indexOf("--model") + 2), ["--model", "sonnet"]);
});

test("write mode remains repository-sandboxed and never enables dangerous bypass flags", () => {
  const codex = buildCodexLaunchSpec({ ...grant, executionMode: "workspace_write" });
  assert.ok(codex.args.includes("workspace-write"));
  assert.ok(!codex.args.includes("--dangerously-bypass-approvals-and-sandbox"));

  const claude = buildClaudeCodeLaunchSpec({ ...grant, executionMode: "workspace_write" });
  assert.ok(claude.args.includes("acceptEdits"));
  assert.ok(claude.args.includes("Read,Edit,Write,Grep,Glob"));
  assert.ok(!claude.args.some((arg) => /Bash/.test(arg)));
});

test("provider parsers return retained result text without trusting claimed lifecycle state", () => {
  const codex = parseCodexResult([
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Codex finding" } }),
  ].join("\n"));
  assert.equal(codex.resultText, "Codex finding");
  assert.equal(codex.sessionId, "thread-1");

  const claude = parseClaudeCodeResult([
    JSON.stringify({ type: "system", session_id: "session-1" }),
    JSON.stringify({ type: "result", result: "Claude finding", is_error: false }),
  ].join("\n"));
  assert.equal(claude.resultText, "Claude finding");
  assert.equal(claude.sessionId, "session-1");
});

test("provider parsers extract usage/cost when the CLI's own JSON events report it", () => {
  const codex = parseCodexResult([
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Codex finding" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 120, output_tokens: 40 } }),
  ].join("\n"));
  assert.deepEqual(codex.usage, { inputTokens: 120, outputTokens: 40, totalTokens: 160, costUsd: null });

  const claude = parseClaudeCodeResult([
    JSON.stringify({ type: "system", session_id: "session-1" }),
    JSON.stringify({ type: "result", result: "Claude finding", is_error: false, usage: { input_tokens: 300, output_tokens: 90 }, total_cost_usd: 0.0234 }),
  ].join("\n"));
  assert.deepEqual(claude.usage, { inputTokens: 300, outputTokens: 90, totalTokens: 390, costUsd: 0.0234 });
});

test("provider parsers report usage as null (not zero) when the CLI never reported it", () => {
  const codex = parseCodexResult(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }));
  assert.equal(codex.usage, null);
});

test("generic resident providers use the explicit JSON stdio adapter contract", () => {
  const adapter = { provider: "gemini-cli", command: "gemini", args: ["--json"], shell: false, protocol: "oathlock-json-stdio" as const };
  const spec = buildGenericJsonStdioLaunchSpec(grant, adapter);
  assert.equal(spec.executable, "gemini");
  assert.deepEqual(spec.args, ["--json"]);
  assert.equal(spec.shell, false);
  assert.match(spec.stdin, /Delegated provider identity: Gemini CLI/);
  const parsed = parseGenericJsonResult(JSON.stringify({ status: "completed", summary: "generic result" }));
  assert.equal(parsed.providerReportedError, false);
  assert.match(parsed.resultText ?? "", /generic result/);
});

test("process runner writes the prompt through stdin and captures a real bounded process result", async () => {
  const program = "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({type:'result',result:s.trim(),is_error:false})+'\\n'))";
  const result = await runProviderProcess({
    executable: process.execPath,
    args: ["-e", program],
    cwd: process.cwd(),
    env: { NODE_ENV: "test", PATH: process.env.PATH },
    stdin: "fixture prompt",
    shell: false,
  }, 5_000);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout, /fixture prompt/);
  assert.equal(result.stdoutTruncated, false);
});

test("provider execution records launch, process acknowledgement, and result in causal order", async () => {
  const events: Array<{ event: string; sequence: number; resultText?: string }> = [];
  const outcome = await executeProviderLaunch({ provider: "codex", grant, firstSequence: 10 }, {
    recordEvent: async (event) => { events.push(event); },
    runProcess: async (_spec, _timeout, _signal, onSpawn) => {
      await onSpawn?.();
      return { exitCode: 0, timedOut: false, cancelled: false, stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "bounded result" } }), stderr: "", stdoutTruncated: false, stderrTruncated: false };
    },
  });
  assert.equal(outcome.status, "returned");
  assert.deepEqual(events.map((event) => [event.event, event.sequence]), [["launch", 10], ["acknowledge_process", 11], ["return_result", 12]]);
  assert.equal(events[2].resultText, "bounded result");
});

test("workspace_write launch creates an isolated worktree and runs the process cwd from it, never the real repository", async () => {
  const createCalls: Array<{ repositoryRoot: string; grantId: unknown; baseRef: string }> = [];
  let sawCwd: string | undefined;
  const outcome = await executeProviderLaunch({ provider: "codex", grant: { ...grant, executionMode: "workspace_write" }, firstSequence: 1 }, {
    recordEvent: async () => {},
    createWorktree: async (input) => { createCalls.push(input); return { worktreeRoot: "/isolated/grant-provider-123", branch: "oathlock/grant-provider-123" }; },
    worktreeHead: async () => "a".repeat(40),
    runProcess: async (spec, _timeout, _signal, onSpawn) => {
      sawCwd = spec.cwd;
      await onSpawn?.();
      return { exitCode: 0, timedOut: false, cancelled: false, stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }), stderr: "", stdoutTruncated: false, stderrTruncated: false };
    },
  });
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].repositoryRoot, grant.repositoryRoot);
  assert.equal(createCalls[0].baseRef, "HEAD");
  // resolve()'d on Windows, so compare against the same resolution rather than the raw literal.
  assert.equal(sawCwd, resolve("/isolated/grant-provider-123"));
  assert.notEqual(sawCwd, grant.repositoryRoot);
  assert.deepEqual(outcome.worktree, { repositoryRoot: grant.repositoryRoot, worktreeRoot: "/isolated/grant-provider-123", branch: "oathlock/grant-provider-123", baseCommit: "a".repeat(40) });
});

test("read_only launch never creates a worktree", async () => {
  let createCalled = false;
  const outcome = await executeProviderLaunch({ provider: "codex", grant, firstSequence: 1 }, {
    recordEvent: async () => {},
    createWorktree: async () => { createCalled = true; return { worktreeRoot: "x", branch: "y" }; },
    runProcess: async (_spec, _timeout, _signal, onSpawn) => {
      await onSpawn?.();
      return { exitCode: 0, timedOut: false, cancelled: false, stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }), stderr: "", stdoutTruncated: false, stderrTruncated: false };
    },
  });
  assert.equal(createCalled, false);
  assert.equal(outcome.worktree, null);
});

test("workspace_write launch quarantines its worktree (never removes it outright) when the provider itself fails, and reports no worktree to the caller", async () => {
  const quarantined: string[] = [];
  let removedCalled = false;
  const outcome = await executeProviderLaunch({ provider: "codex", grant: { ...grant, executionMode: "workspace_write" }, firstSequence: 1 }, {
    recordEvent: async () => {},
    createWorktree: async () => ({ worktreeRoot: "/isolated/grant-provider-123", branch: "oathlock/grant-provider-123" }),
    worktreeHead: async () => "a".repeat(40),
    quarantineWorktree: async (_root, worktreeRoot) => { quarantined.push(worktreeRoot); return `${worktreeRoot}.quarantined`; },
    removeWorktree: async () => { removedCalled = true; },
    runProcess: async (_spec, _timeout, _signal, onSpawn) => {
      await onSpawn?.();
      return { exitCode: 1, timedOut: false, cancelled: false, stdout: "", stderr: "boom", stdoutTruncated: false, stderrTruncated: false };
    },
  });
  assert.equal(outcome.status, "provider_failed");
  assert.equal(outcome.worktree, null);
  assert.deepEqual(quarantined, ["/isolated/grant-provider-123"]);
  assert.equal(removedCalled, false);
});

test("workspace_write launch removes (not quarantines) its worktree on cancellation, since nothing worth inspecting ran", async () => {
  let removedRoot: string | null = null;
  let quarantineCalled = false;
  const controller = new AbortController();
  const outcome = await executeProviderLaunch({ provider: "codex", grant: { ...grant, executionMode: "workspace_write" }, firstSequence: 1, signal: controller.signal }, {
    recordEvent: async () => {},
    createWorktree: async () => ({ worktreeRoot: "/isolated/grant-provider-123", branch: "oathlock/grant-provider-123" }),
    worktreeHead: async () => "a".repeat(40),
    quarantineWorktree: async () => { quarantineCalled = true; return ""; },
    removeWorktree: async (_root, worktreeRoot) => { removedRoot = worktreeRoot; },
    runProcess: async () => ({ exitCode: null, timedOut: false, cancelled: true, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false }),
  });
  assert.equal(outcome.status, "cancelled");
  assert.equal(outcome.worktree, null);
  assert.equal(removedRoot, "/isolated/grant-provider-123");
  assert.equal(quarantineCalled, false);
});

test("provider return records the requested tier and model beside real reported usage", async () => {
  const events: Array<Record<string, unknown>> = [];
  await executeProviderLaunch({
    provider: "claude-code",
    grant: { ...grant, modelTier: "economy", requestedModel: "haiku" },
    firstSequence: 30,
  }, {
    recordEvent: async (event) => { events.push(event); },
    runProcess: async (_spec, _timeout, _signal, onSpawn) => {
      await onSpawn?.();
      return {
        exitCode: 0, timedOut: false, cancelled: false, stderr: "", stdoutTruncated: false, stderrTruncated: false,
        stdout: JSON.stringify({ type: "result", result: "bounded result", is_error: false, usage: { input_tokens: 10, output_tokens: 5 } }),
      };
    },
  });
  assert.equal(events[2].modelTier, "economy");
  assert.equal(events[2].requestedModel, "haiku");
  assert.deepEqual(events[2].usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: null });
});

test("provider execution rejects a result whose reported usage exceeds the hard grant ceiling", async () => {
  const events: Array<Record<string, unknown>> = [];
  const outcome = await executeProviderLaunch({
    provider: "claude-code",
    grant: { ...grant, maxEstimatedTokens: 100 },
    firstSequence: 40,
  }, {
    recordEvent: async (event) => { events.push(event); },
    runProcess: async (_spec, _timeout, _signal, onSpawn) => {
      await onSpawn?.();
      return {
        exitCode: 0, timedOut: false, cancelled: false, stderr: "", stdoutTruncated: false, stderrTruncated: false,
        stdout: JSON.stringify({ type: "result", result: "too expensive", is_error: false, usage: { input_tokens: 80, output_tokens: 40 } }),
      };
    },
  });
  assert.equal(outcome.status, "budget_exceeded");
  assert.equal(outcome.result, null);
  assert.deepEqual(events.map((event) => event.event), ["launch", "acknowledge_process", "fail_provider"]);
  assert.equal(events[2].failureCode, "token_budget_exceeded");
});

test("provider execution records launch failure without fabricating a working acknowledgement", async () => {
  const events: string[] = [];
  const outcome = await executeProviderLaunch({ provider: "claude-code", grant, firstSequence: 2 }, {
    recordEvent: async (event) => { events.push(event.event); },
    runProcess: async () => { throw new Error("spawn failed"); },
  });
  assert.equal(outcome.status, "launch_failed");
  assert.deepEqual(events, ["launch", "fail_launch"]);
});

test("a failure after process acknowledgement is retained as provider failure", async () => {
  const events: string[] = [];
  const outcome = await executeProviderLaunch({ provider: "codex", grant, firstSequence: 20 }, {
    recordEvent: async (event) => { events.push(event.event); },
    runProcess: async (_spec, _timeout, _signal, onSpawn) => {
      await onSpawn?.();
      throw new Error("process transport failed after spawn");
    },
  });
  assert.equal(outcome.status, "provider_failed");
  assert.deepEqual(events, ["launch", "acknowledge_process", "fail_provider"]);
});
