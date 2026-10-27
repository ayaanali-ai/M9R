import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeManagedProviderProfile,
  selectManagedProviderProfile,
  validateManagedProviderTask,
  type ManagedProviderTask,
} from "@/lib/native/managed-provider-contract";

test("normalizes a provider connection profile and gives equivalent paths one identity", () => {
  const first = normalizeManagedProviderProfile({
    handle: "@Claude",
    provider: "Claude-Code",
    cwd: "C:\\Work\\Project\\",
    model: "opus",
    effort: "high",
  });
  const second = normalizeManagedProviderProfile({
    handle: "claude",
    provider: "claude-code",
    cwd: "c:/work/project",
    model: "opus",
    effort: "high",
  });

  assert.deepEqual(first, second);
  assert.equal(first.handle, "claude");
  assert.equal(first.provider, "claude-code");
  assert.equal(first.cwd, "c:/work/project");
  assert.match(first.connectionId, /^m9r:claude:claude-code:/);
});
test("rejects ambiguous or unsafe connection identity fields", () => {
  assert.throws(() => normalizeManagedProviderProfile({ handle: "all", provider: "codex", cwd: "C:/Work" }), /handle/);
  assert.throws(() => normalizeManagedProviderProfile({ handle: "claude", provider: "", cwd: "C:/Work" }), /provider/);
  assert.throws(() => normalizeManagedProviderProfile({ handle: "claude", provider: "claude-code", cwd: "relative/project" }), /absolute/);
  assert.throws(() => normalizeManagedProviderProfile({ handle: "claude", provider: "claude-code", cwd: "C:/" }), /root/);
});

test("accepts a task only when its provider, connection, folder, and generation agree", () => {
  const profile = normalizeManagedProviderProfile({ handle: "codex", provider: "codex", cwd: "C:/Work/Project" });
  const task: ManagedProviderTask = {
    taskId: "T-contract-1",
    connectionId: profile.connectionId,
    handle: profile.handle,
    provider: profile.provider,
    cwd: profile.cwd,
    generation: 7,
    prompt: "read-only task",
  };

  assert.deepEqual(validateManagedProviderTask(task, profile, 7), { ok: true });
  assert.equal(validateManagedProviderTask({ ...task, cwd: "C:/Other" }, profile, 7).ok, false);
  assert.equal(validateManagedProviderTask({ ...task, provider: "claude-code" }, profile, 7).ok, false);
  assert.equal(validateManagedProviderTask({ ...task, generation: 6 }, profile, 7).ok, false);
  assert.equal(validateManagedProviderTask({ ...task, connectionId: "m9r:other" }, profile, 7).ok, false);
});

test("selects a managed connection by exact provider and folder, never by process order", () => {
  const claudeOther = normalizeManagedProviderProfile({ handle: "claude", provider: "claude-code", cwd: "C:/Other" });
  const claudeSelected = normalizeManagedProviderProfile({ handle: "claude", provider: "claude-code", cwd: "C:/Project" });
  const codexSameFolder = normalizeManagedProviderProfile({ handle: "codex", provider: "codex", cwd: "C:/Project" });

  const selected = selectManagedProviderProfile([claudeOther, claudeSelected, codexSameFolder], {
    provider: "CLAUDE-CODE",
    cwd: "c:\\project\\",
  });
  assert.deepEqual(selected, { kind: "selected", profile: claudeSelected });

  assert.equal(selectManagedProviderProfile([claudeOther, claudeSelected], { provider: "opencode", cwd: "C:/Project" }).kind, "none");
});

test("requires an explicit connection ID when two logical connections share provider and folder", () => {
  const first = normalizeManagedProviderProfile({ handle: "claude", provider: "claude-code", cwd: "C:/Project", connectionId: "claude-project-a" });
  const second = normalizeManagedProviderProfile({ handle: "claude", provider: "claude-code", cwd: "C:/Project", connectionId: "claude-project-b" });
  const profiles = [first, second];

  assert.equal(selectManagedProviderProfile(profiles, { provider: "claude-code", cwd: "C:/Project" }).kind, "ambiguous");
  assert.deepEqual(selectManagedProviderProfile(profiles, { provider: "claude-code", cwd: "C:/Project", connectionId: "claude-project-b" }), {
    kind: "selected",
    profile: second,
  });
});
