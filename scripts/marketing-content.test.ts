import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";
import { COMMANDS, SIGNUP_URL, SOURCE_URL } from "../src/lib/marketing-content.ts";
import { FOUNDING_COHORT_SIZE, FOUNDING_MONTHLY_PRICE_USD, STANDARD_MONTHLY_PRICE_USD } from "../src/lib/stripe.ts";

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
  assert.match(readFileSync("src/components/world/WorldHome.tsx", "utf8"), /<Guide\s*\/>/);
  for (const path of ["src/app/docs/get-started/page.tsx", "src/app/how-it-works/page.tsx"]) {
    assert.match(readFileSync(path, "utf8"), /<ReferenceGuide\s*\/>/);
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

test("public pricing and terms describe the same current per-computer plan", () => {
  const pricing = readFileSync("src/components/reference/ReferencePricing.tsx", "utf8");
  const terms = readFileSync("src/app/terms/page.tsx", "utf8");
  assert.match(pricing, /per computer/);
  assert.match(terms, /priced per computer, not per seat/);
  assert.match(terms, /FOUNDING_COHORT_SIZE/);
  assert.match(terms, /FOUNDING_MONTHLY_PRICE_USD/);
  assert.match(terms, /STANDARD_MONTHLY_PRICE_USD/);
  assert.equal(FOUNDING_COHORT_SIZE, 500);
  assert.equal(FOUNDING_MONTHLY_PRICE_USD, 17);
  assert.equal(STANDARD_MONTHLY_PRICE_USD, 27);
  assert.doesNotMatch(terms, /Relationship Memory|Team costs|7-day free trial/);
});

test("the PWA manifest points to an existing current M9R asset", () => {
  const manifest = readFileSync("src/app/manifest.ts", "utf8");
  assert.match(manifest, /\/reference-innerwebs\/m9r-logo-transparent\.png/);
  assert.doesNotMatch(manifest, /oathlock-logo-transparent|OathLock/);
  assert.equal(existsSync("public/reference-innerwebs/m9r-logo-transparent.png"), true);
});

test("license summary matches repository parameters", () => {
  const license = readFileSync("LICENSE", "utf8");
  assert.match(license, /Change Date:\s+2029-09-04/);
  assert.match(license, /Change License:\s+GNU General Public License, Version 2.0 or any later version/);
});
