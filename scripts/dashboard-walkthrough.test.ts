import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("the product tour is retired: no overlay, no auto-start, no help page", () => {
  assert.equal(existsSync(resolve(root, "src/components/product/DashboardOnboarding.tsx")), false);
  const shell = read("src/components/product/ProductShell.tsx");
  const layout = read("src/app/dashboard/layout.tsx");
  const help = read("src/app/dashboard/help/page.tsx");
  assert.doesNotMatch(shell, /DashboardOnboarding|onboardingCompleted|onboardingAutoStart/);
  assert.doesNotMatch(layout, /ONBOARDING_ROLLOUT_AT|walkthrough_completed/);
  assert.match(help, /redirect\("\/dashboard\/agents"\)/);
});

test("the first-run card replaces the setup checklist and never shows for a connected workspace", () => {
  const page = read("src/app/dashboard/agents/page.tsx");
  const card = read("src/components/product/FirstRunCard.tsx");
  assert.match(page, /!agents\.some\(\(agent\) => agent\.registered\) && <FirstRunCard \/>/);
  assert.match(card, /Connect your first agent/);
  assert.doesNotMatch(card, /create run|seed|synthetic/i);
});

test("reviewer demo remains separately seeded and read-only", () => {
  const page = read("src/app/dashboard/agents/page.tsx");
  const demo = read("src/components/product/ReviewerDemoWorkspace.tsx");
  assert.match(page, /isReviewerDemoAppMetadata/);
  assert.match(demo, /Seeded\/redacted evidence/);
  assert.match(demo, /No production record is changed/);
});
