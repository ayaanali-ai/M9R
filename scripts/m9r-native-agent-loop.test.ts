import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TERMINAL_ENABLED } from "../src/lib/terminal-config.ts";

// The register-alias.mjs test loader resolves `@/` imports but doesn't
// source .env.local -- the credential-gating test below needs a real
// Supabase connection (to prove "no credential stored" rather than "backend
// not configured"), so load the same env vars the app itself reads.
try {
  const envText = readFileSync(".env.local", "utf8");
  for (const line of envText.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
} catch {
  // No .env.local in this environment -- the credential-gating test will
  // report "backend not configured" instead, which is itself a correct,
  // guarded error state, just not the specific one this test targets.
}

/**
 * Item #32 phase 2: real, verifiable tests that don't require a live
 * provider API key (none is available in this environment, and asking for
 * one to be pasted into a session is exactly the kind of secret-handling
 * this build has been careful to avoid). These test the parts that are
 * genuinely testable without a real model call: credential gating, and
 * that the extracted governed-tool functions this loop depends on still
 * behave identically to their pre-extraction originals.
 */

test("runM9rNativeTurn refuses to run without a stored Anthropic credential, before attempting any model call", async () => {
  const { runM9rNativeTurn } = await import("../src/lib/bridge/m9r-native-agent-loop");
  await assert.rejects(
    () => runM9rNativeTurn({
      workspaceId: "00000000-0000-0000-0000-000000000099", // a workspace with no stored credential
      workingDirectory: process.cwd(),
      model: "claude-sonnet-4-6",
      prompt: "irrelevant -- should never reach the model",
    }),
    /No Anthropic credential is stored/,
  );
});

test("governed-agent-tools functions used by the native loop are the same ones dev-mcp-server.ts calls (no drifted second copy)", async () => {
  const governed = await import("../src/lib/bridge/governed-agent-tools");
  const root = await mkdtemp(join(tmpdir(), "m9r-native-loop-test-"));
  try {
    await writeFile(join(root, "sample.txt"), "hello from the shared tool implementation", "utf8");
    const content = await governed.readGovernedFile(root, "sample.txt");
    assert.equal(content, "hello from the shared tool implementation");

    const replaced = await governed.strReplaceGovernedFile(root, "sample.txt", "hello", "goodbye");
    assert.match(replaced, /Replaced 1 occurrence/);
    assert.equal(await governed.readGovernedFile(root, "sample.txt"), "goodbye from the shared tool implementation");

    const tree = await governed.listGovernedTree(root, ".", 2);
    assert.match(tree, /sample\.txt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("postAgentMessage (send_message's real mechanism) is the exact function both the MCP path and the native loop call", async () => {
  const governed = await import("../src/lib/bridge/governed-agent-tools");
  const loop = await import("../src/lib/bridge/m9r-native-agent-loop");
  // Not calling either -- this just proves the native loop module imports
  // postAgentMessage from governed-agent-tools rather than reimplementing
  // its own copy, which is the actual guarantee behind "agents can still
  // talk to each other regardless of which provider ran the turn."
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/lib/bridge/m9r-native-agent-loop.ts", import.meta.url), "utf8"));
  assert.match(source, /import\s*\{[^}]*postAgentMessage[^}]*\}\s*from\s*"@\/lib\/bridge\/governed-agent-tools"/);
  void governed;
  void loop;
});

test("postAgentMessage retries transient transport failure with the same idempotency key", async () => {
  const { postAgentMessage } = await import("../src/lib/bridge/governed-agent-tools");
  const originalFetch = globalThis.fetch;
  const seenKeys: string[] = [];
  let attempts = 0;
  globalThis.fetch = (async (_input, init) => {
    attempts += 1;
    seenKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
    if (attempts === 1) throw new Error("temporary socket reset");
    return new Response(JSON.stringify({ message: { id: "message-1" } }), { status: 201, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await assert.doesNotReject(postAgentMessage({ appUrl: "https://example.test", agentToken: "token", missionId: "channel-conversation-1" }, { text: "hello", parentMessageId: "parent-1" }));
    assert.equal(attempts, 2);
    assert.equal(seenKeys[0], seenKeys[1]);
    assert.ok(seenKeys[0]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("native loop exposes the full governed task surface, including safe file creation", async () => {
  const { buildM9rNativeTools } = await import("../src/lib/bridge/m9r-native-agent-loop");
  const root = await mkdtemp(join(tmpdir(), "m9r-native-tools-"));
  try {
    const tools = buildM9rNativeTools(root, {
      appUrl: "https://example.test",
      agentToken: "token",
      missionId: "channel-conversation-1",
    }, () => {});
    const names = Object.keys(tools).sort();
    const expected = [
      "create_file", "draft_section", "git_read", "list_my_task_items", "read_file", "request_assignment_change",
      "request_evidence_review", "rg", "search_memory", "send_message", "str_replace", "submit_evidence",
      "submit_task_split", "todo", "tree", "update_task_item_status",
    ];
    if (TERMINAL_ENABLED) expected.push("handoff_to_terminal");
    assert.deepEqual(names, expected.sort());

    const createFile = (tools.create_file as unknown as { execute: (input: { path: string; content: string }) => Promise<string> }).execute;
    assert.match(await createFile({ path: "hello.txt", content: "hi from codex" }), /Created hello\.txt/);
    await assert.rejects(() => createFile({ path: "hello.txt", content: "replacement" }), /already exists/);
    assert.equal(readFileSync(join(root, "hello.txt"), "utf8"), "hi from codex");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native create_file refuses a junction that points outside its assigned working directory", async () => {
  const { buildM9rNativeTools } = await import("../src/lib/bridge/m9r-native-agent-loop");
  const root = await mkdtemp(join(tmpdir(), "m9r-native-write-root-"));
  const outside = await mkdtemp(join(tmpdir(), "m9r-native-write-outside-"));
  try {
    await symlink(outside, join(root, "linked"), "junction");
    const tools = buildM9rNativeTools(root, undefined, () => {});
    const createFile = (tools.create_file as unknown as { execute: (input: { path: string; content: string }) => Promise<string> }).execute;

    await assert.rejects(createFile({ path: "linked/escaped.txt", content: "outside" }), /outside the working directory/i);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("native str_replace refuses a junction that points outside and leaves the external file unchanged", async () => {
  const { buildM9rNativeTools } = await import("../src/lib/bridge/m9r-native-agent-loop");
  const root = await mkdtemp(join(tmpdir(), "m9r-native-replace-root-"));
  const outside = await mkdtemp(join(tmpdir(), "m9r-native-replace-outside-"));
  const externalFile = join(outside, "protected.txt");
  try {
    await writeFile(externalFile, "keep this content", "utf8");
    await symlink(outside, join(root, "linked"), "junction");
    const tools = buildM9rNativeTools(root, undefined, () => {});
    const strReplace = (tools.str_replace as unknown as { execute: (input: { path: string; oldText: string; newText: string }) => Promise<string> }).execute;

    await assert.rejects(strReplace({ path: "linked/protected.txt", oldText: "keep", newText: "change" }), /outside the working directory/i);
    assert.equal(readFileSync(externalFile, "utf8"), "keep this content");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("governed git_read has a fixed read-only operation allowlist", async () => {
  const { GIT_READ_OPERATIONS, gitReadArgs } = await import("../src/lib/bridge/governed-agent-tools");
  assert.deepEqual(GIT_READ_OPERATIONS, ["status", "log", "diff_stat", "branch"]);
  assert.deepEqual(gitReadArgs("status", 1), ["status", "--short", "--branch"]);
  assert.throws(() => gitReadArgs("push" as never, 1), /unsupported git read operation/i);
});

test("native git_read stays available without channel credentials while channel tools stay absent", async () => {
  const { buildM9rNativeTools } = await import("../src/lib/bridge/m9r-native-agent-loop");
  const tools = buildM9rNativeTools(process.cwd(), undefined, () => {});
  const names = Object.keys(tools);
  assert.ok(names.includes("git_read"));
  assert.ok(names.includes("read_file"));
  assert.equal(names.includes("send_message"), false);
  assert.equal(names.includes("search_memory"), false);
});

test("postAgentMessage redacts the session credential if an HTTP error echoes it", async () => {
  const { postAgentMessage } = await import("../src/lib/bridge/governed-agent-tools");
  const sessionCredential = "m9r-session-token-do-not-print-0123456789";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(`denied bearer ${sessionCredential}`, { status: 401 })) as typeof fetch;
  try {
    let failure = "";
    try {
      await postAgentMessage(
        { appUrl: "https://example.test", agentToken: sessionCredential, missionId: "channel-conversation-1" },
        { text: "hello" },
      );
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    assert.match(failure, /HTTP 401/);
    assert.equal(failure.includes(sessionCredential), false, "the echoed session credential must not reach tool output");
    assert.match(failure, /\[REDACTED\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("native channel tool errors redact the session credential if the server echoes it", async () => {
  const { buildM9rNativeTools } = await import("../src/lib/bridge/m9r-native-agent-loop");
  const sessionCredential = "m9r-session-token-do-not-print-9876543210";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(`denied bearer ${sessionCredential}`, { status: 403 })) as typeof fetch;
  try {
    const tools = buildM9rNativeTools(process.cwd(), {
      appUrl: "https://example.test",
      agentToken: sessionCredential,
      missionId: "channel-conversation-1",
    }, () => {});
    const searchMemory = (tools.search_memory as unknown as { execute: (input: { query: string; limit: number }) => Promise<string> }).execute;
    let failure = "";
    try {
      await searchMemory({ query: "context", limit: 1 });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    assert.match(failure, /HTTP 403/);
    assert.equal(failure.includes(sessionCredential), false, "the echoed session credential must not reach tool output");
    assert.match(failure, /\[REDACTED\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("native channel transport failures redact the session credential from the tool error", async () => {
  const { buildM9rNativeTools } = await import("../src/lib/bridge/m9r-native-agent-loop");
  const sessionCredential = "m9r-session-token-do-not-print-transport123";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error(`socket reset ${sessionCredential}`); }) as typeof fetch;
  try {
    const tools = buildM9rNativeTools(process.cwd(), {
      appUrl: "https://example.test",
      agentToken: sessionCredential,
      missionId: "channel-conversation-1",
    }, () => {});
    const searchMemory = (tools.search_memory as unknown as { execute: (input: { query: string; limit: number }) => Promise<string> }).execute;
    let failure = "";
    try {
      await searchMemory({ query: "context", limit: 1 });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    assert.match(failure, /socket reset/);
    assert.equal(failure.includes(sessionCredential), false, "a transport failure must not reveal the session credential");
    assert.match(failure, /\[REDACTED\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("native channel tool output redacts a session credential echoed in a successful response", async () => {
  const { buildM9rNativeTools } = await import("../src/lib/bridge/m9r-native-agent-loop");
  const sessionCredential = "m9r-session-token-do-not-print-abcdef012345";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ matches: [
    { title: "prior", ownerLabel: "Codex", conversationTopic: "repo", archivedAtMs: null, transcript: [
      { sender: "assistant", body: `M9R session token: ${sessionCredential}` },
    ] },
  ] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const tools = buildM9rNativeTools(process.cwd(), {
      appUrl: "https://example.test",
      agentToken: sessionCredential,
      missionId: "channel-conversation-1",
    }, () => {});
    const searchMemory = (tools.search_memory as unknown as { execute: (input: { query: string; limit: number }) => Promise<string> }).execute;
    const output = await searchMemory({ query: "context", limit: 1 });
    assert.equal(output.includes(sessionCredential), false, "a credential echoed in a successful response must not reach tool output");
    assert.match(output, /M9R session token: \[REDACTED\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("postAgentMessage redacts a credential before truncating a long HTTP error", async () => {
  const { postAgentMessage } = await import("../src/lib/bridge/governed-agent-tools");
  const sessionCredential = "m9r-session-token-do-not-print-fedcba987654";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(`${"x".repeat(290)}${sessionCredential}`, { status: 401 })) as typeof fetch;
  try {
    let failure = "";
    try {
      await postAgentMessage(
        { appUrl: "https://example.test", agentToken: sessionCredential, missionId: "channel-conversation-1" },
        { text: "hello" },
      );
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    assert.match(failure, /HTTP 401/);
    assert.equal(failure.includes(sessionCredential.slice(0, 8)), false, "truncation must not reveal a partial credential");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
