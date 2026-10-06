import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";
import { COMMANDS, SIGNUP_URL, SOURCE_URL } from "../src/lib/marketing-content.ts";

test("documented CLI commands use a package binary and implemented top-level command", () => {
  const pkg = JSON.parse(readFileSync("cli/package.json", "utf8"));
  const core = readFileSync("src/lib/oathlock-cli-core.ts", "utf8");
  const entry = readFileSync("scripts/m9r-cli.ts", "utf8");
  for (const item of COMMANDS) {
    const [runner, binary, command] = item.command.split(" ");
    assert.equal(runner, "npx");
    assert.ok(pkg.bin[binary], `${binary} must be installed by the package`);
    const handled = core.includes(`case "${command}":`) || (command === "web" && entry.includes('argv[0] === "web"'));
    assert.ok(handled, `${command} must have a CLI handler`);
  }
});

test("public setup commands are all supported CLI steps", () => {
  for (const command of COMMANDS) {
    assert.equal(command.preview, false);
  }
  assert.equal(new Set(COMMANDS.map((command) => command.id)).size, COMMANDS.length);
});

test("homepage and docs share the same guide rather than independent command copies", () => {
  for (const path of ["src/components/world/WorldHome.tsx", "src/app/docs/get-started/page.tsx", "src/app/how-it-works/page.tsx"]) {
    assert.match(readFileSync(path, "utf8"), /<Guide\s*\/>/);
  }
});

test("marketing signup and invitations retain the existing account flow", () => {
  assert.equal(SIGNUP_URL, "/auth?mode=signup");
  assert.match(readFileSync("src/app/auth/page.tsx", "utf8"), /initialMode=\{modeParam === "signup" \? "signup" : "login"\}/);
  const home = readFileSync("src/app/page.tsx", "utf8");
  assert.match(home, /encodeURIComponent\(token\)/);
  const invitation = readFileSync("src/components/world/InviteDialog.tsx", "utf8");
  assert.match(invitation, /<M9RAuthTerminal/);
  assert.match(invitation, /initialMode="signup"/);
  assert.match(invitation, /next=\{next\}/);
  assert.match(invitation, /autoOpen/);
});

test("new public destinations resolve to actual pages", () => {
  for (const route of ["how-it-works", "pricing", "docs/get-started", "faq", "open-core", "cookies"]) {
    assert.ok(existsSync(`src/app/${route}/page.tsx`));
  }
  assert.equal(SOURCE_URL, "https://github.com/ayaanali-ai/M9R");
});

test("license summary matches repository parameters", () => {
  const license = readFileSync("LICENSE", "utf8");
  assert.match(license, /Change Date:\s+2029-09-04/);
  assert.match(license, /Change License:\s+GNU General Public License, Version 2.0 or any later version/);
});
