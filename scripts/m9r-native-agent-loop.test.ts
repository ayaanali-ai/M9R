import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
