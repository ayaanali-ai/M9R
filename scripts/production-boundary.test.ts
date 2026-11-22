import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(".");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("the shipped desktop runtime has one broker-owned provider entrypoint", () => {
  const broker = read("scripts/m9r-web-broker.ts");
  assert.match(broker, /createManagedProviderOwner/);
  assert.doesNotMatch(broker, /createWebLiveSessions/);
  assert.match(broker, /legacy browser-extension[\s\S]*intentionally not enabled/);
});

test("the canonical desktop pill cannot fall back to legacy feed or session-link commands", () => {
  const desktop = read("pill/src/shells/desktop.ts");
  const tauri = read("overlay/src-tauri/src/main.rs");
  assert.doesNotMatch(desktop, /read_feed|list_sessions|link_sessions/);
  assert.doesNotMatch(tauri.match(/generate_handler!\[[\s\S]*?\]/)?.[0] ?? "", /read_feed|list_sessions|link_sessions|\bdecide\b/);
  assert.match(desktop, /read_pill_state/);
  assert.match(desktop, /pill_decide/);
});

test("the installer refuses the retired provider-hook transport", () => {
  const installer = read("scripts/install-m9r.ps1");
  const builder = read("scripts/build-engine.mjs");
  assert.match(installer, /legacy browser-extension\/provider-hook transport is retired/i);
  assert.match(builder, /legacy provider hook path has been removed/i);
});

test("the standalone engine and candidate builds regenerate one selected CLI input before packaging", () => {
  const packageJson = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  const engineBuilder = read("scripts/build-engine.mjs");
  const candidateBuilder = read("scripts/build-candidate.mjs");
  const promoter = read("scripts/promote-runtime-candidate.mjs");
  const cliBuildIndex = engineBuilder.indexOf('join(root, "scripts", "build-cli.mjs")');
  const cliOutputCheckIndex = engineBuilder.indexOf('if (!existsSync(join(cliOutput, "m9r.js"))');

  assert.equal(packageJson.scripts["build:engine"], "node ./scripts/build-engine.mjs");
  assert.ok(cliBuildIndex >= 0 && cliBuildIndex < cliOutputCheckIndex,
    "the engine builder must regenerate its selected CLI output before checking and packaging it");
  assert.match(candidateBuilder, /M9R_CLI_OUTPUT_DIR:\s*cliOutput/);
  assert.match(candidateBuilder, /M9R_ENGINE_OUTPUT_DIR:\s*runtimeOutput/);
  assert.doesNotMatch(candidateBuilder, /runNodeScript\("build-cli\.mjs"/,
    "candidate builds must use the engine builder's CLI path instead of a parallel prebuild path");
  assert.match(promoter, /receipt\.sourceDirty\s*!==\s*false/,
    "dirty working-tree candidates cannot become the accepted runtime");
});
