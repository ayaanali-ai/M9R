import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalStore } from "@/lib/native/local-store";
import { handleHookEvent } from "@/lib/native/hook-handler";
import { createMemoryLog } from "@/lib/native/memory-log";

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), "m9r-memory-injection-"));
  return { root, store: createLocalStore(root), done: () => rmSync(root, { recursive: true, force: true }) };
}

const ctxOf = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const hookSpecificOutput = (value as { hookSpecificOutput?: unknown }).hookSpecificOutput;
  if (!hookSpecificOutput || typeof hookSpecificOutput !== "object") return undefined;
  const additionalContext = (hookSpecificOutput as { additionalContext?: unknown }).additionalContext;
  return typeof additionalContext === "string" ? additionalContext : undefined;
};

test("SessionStart auto-injects shared global memory and this agent's own persona memory, but not another persona's", async () => {
  const { root, store, done } = tempStore();
  try {
    const log = createMemoryLog(root);
    log.add("User prefers terse commit messages.", "global", "codex");
    log.add("Deploys always go to staging first.", "global");
    log.add("Deep in the pill redesign this week.", "persona:claude", "claude");
    log.add("Unrelated note for a different agent entirely.", "persona:codex", "codex");
    // add() persists asynchronously (so a capture call never waits on disk); the injection
    // path below reads a fresh instance off disk, so it must wait for those writes to land.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const out = handleHookEvent({ hook_event_name: "SessionStart", session_id: "s1", cwd: "/repo" }, { provider: "claude-code", store });
    const text = ctxOf(out) ?? "";
    assert.match(text, /User prefers terse commit messages/);
    assert.match(text, /Deploys always go to staging first/);
    assert.match(text, /Deep in the pill redesign this week/);
    assert.match(text, /@codex/, "author attribution is surfaced");
    assert.doesNotMatch(text, /Unrelated note for a different agent/, "a different agent's persona scope is not injected");
  } finally {
    done();
  }
});

test("SessionStart adds nothing memory-shaped when there is no memory yet", () => {
  const { store, done } = tempStore();
  try {
    const out = handleHookEvent({ hook_event_name: "SessionStart", session_id: "s1", cwd: "/repo" }, { provider: "claude-code", store });
    assert.doesNotMatch(ctxOf(out) ?? "", /shared memory/);
  } finally {
    done();
  }
});

test("the injected slice is a real bounded merge, not the whole file: a persona-scoped test override limits what's shown", () => {
  const { store, done } = tempStore();
  try {
    const out = handleHookEvent(
      { hook_event_name: "SessionStart", session_id: "s1", cwd: "/repo" },
      { provider: "claude-code", store, memorySlice: () => [{ id: "x1", text: "Injected via explicit override.", scope: "global", createdAt: new Date().toISOString() }] },
    );
    assert.match(ctxOf(out) ?? "", /Injected via explicit override/);
  } finally {
    done();
  }
});
