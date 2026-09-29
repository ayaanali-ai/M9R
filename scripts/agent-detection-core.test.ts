import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { detectInstalledAgents, parseAgentsFlag, DETECTABLE_AGENT_KINDS, buildAgentVersionProbeEnv } from "../src/lib/agent-detection-core.ts";

test("detectInstalledAgents reports only the binaries the probe actually finds, in a stable order", async () => {
  const found = await detectInstalledAgents(async (binary) => {
    if (binary === "codex") return "codex-cli 0.42.0\nsome extra line";
    if (binary === "opencode") return "1.9.1";
    return null; // claude not installed in this fake environment
  });

  assert.deepEqual(found.map((a) => a.kind), ["codex", "opencode"]);
  const codex = found.find((a) => a.kind === "codex")!;
  assert.equal(codex.label, "Codex");
  assert.equal(codex.binary, "codex");
  assert.equal(codex.versionLine, "codex-cli 0.42.0", "only the first line of --version output is kept");
});

test("detectInstalledAgents returns an empty list when nothing is found, never throws", async () => {
  const found = await detectInstalledAgents(async () => null);
  assert.deepEqual(found, []);
});

test("detectInstalledAgents covers every DETECTABLE_AGENT_KINDS entry", async () => {
  const seen = new Set<string>();
  const found = await detectInstalledAgents(async (binary) => {
    seen.add(binary);
    return `${binary} 1.0.0`;
  });
  assert.equal(found.length, DETECTABLE_AGENT_KINDS.length);
  for (const kind of DETECTABLE_AGENT_KINDS) {
    assert.ok(found.some((a) => a.kind === kind), `expected ${kind} to be probed and detected`);
  }
});

test("OpenCode version probes isolate its XDG state without changing the caller environment", () => {
  const base = {
    PATH: "C:/tools",
    XDG_CONFIG_HOME: "C:/private/opencode-config",
    XDG_DATA_HOME: "C:/private/opencode-data",
    XDG_CACHE_HOME: "C:/private/opencode-cache",
    XDG_STATE_HOME: "C:/private/opencode-state",
  };
  const isolated = buildAgentVersionProbeEnv("opencode", base, "C:/temp/m9r-probe");

  assert.deepEqual(isolated, {
    ...base,
    XDG_CONFIG_HOME: join("C:/temp/m9r-probe", "config"),
    XDG_DATA_HOME: join("C:/temp/m9r-probe", "data"),
    XDG_CACHE_HOME: join("C:/temp/m9r-probe", "cache"),
    XDG_STATE_HOME: join("C:/temp/m9r-probe", "state"),
  });
  assert.deepEqual(base, {
    PATH: "C:/tools",
    XDG_CONFIG_HOME: "C:/private/opencode-config",
    XDG_DATA_HOME: "C:/private/opencode-data",
    XDG_CACHE_HOME: "C:/private/opencode-cache",
    XDG_STATE_HOME: "C:/private/opencode-state",
  });
});

test("other agent probes preserve their existing environment", () => {
  const base = { PATH: "C:/tools", XDG_CONFIG_HOME: "C:/user/config" };
  assert.deepEqual(buildAgentVersionProbeEnv("codex", base, "C:/temp/m9r-probe"), base);
});

test("parseAgentsFlag splits, trims, lowercases, and drops blanks", () => {
  assert.deepEqual(parseAgentsFlag("claude-code, Codex ,, opencode"), ["claude-code", "codex", "opencode"]);
  assert.deepEqual(parseAgentsFlag(""), []);
  assert.deepEqual(parseAgentsFlag("  "), []);
});

test("parseAgentsFlag passes through an unknown provider slug unchanged, same as --agent-kind always has", () => {
  assert.deepEqual(parseAgentsFlag("gemini-cli"), ["gemini-cli"]);
});
