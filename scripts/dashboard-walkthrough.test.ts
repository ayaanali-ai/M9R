import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("dashboard ships a persistent, re-openable production onboarding tour", () => {
  assert.equal(existsSync(resolve(root, "src/components/product/DashboardOnboarding.tsx")), true);
  const shell = read("src/components/product/ProductShell.tsx");
  const tour = read("src/components/product/DashboardOnboarding.tsx");
  const help = read("src/app/dashboard/help/page.tsx");
  assert.match(shell, /DashboardOnboarding/);
  assert.match(shell, /onboardingCompleted/);
  // The always-visible top-bar link is gone (explicit user direction) --
  // the entry point now lives on the Help page instead, still pointing at
  // the same ?tour=1 param DashboardOnboarding reads to auto-open.
  assert.match(help, /Start product tour/);
  assert.match(help, /\/dashboard\/help\?tour=1/);
  assert.match(tour, /\/api\/walkthrough/);
  assert.match(tour, /oathlock_walkthrough_completed/);
  assert.match(tour, /Back/);
  assert.match(tour, /Next/);
  assert.match(tour, /aria-label="Close product tour"/);
  assert.match(tour, /persistAndClose/);
  assert.doesNotMatch(tour, /aria-modal="true"|onboarding-scrim/);
  assert.doesNotMatch(tour, /setInterval|400/);
});

test("tour auto-start is limited to post-rollout accounts and survives deployments", () => {
  const layout = read("src/app/dashboard/layout.tsx");
  const route = read("src/app/api/walkthrough/route.ts");
  assert.match(layout, /ONBOARDING_ROLLOUT_AT/);
  assert.match(layout, /user\.created_at/);
  assert.match(route, /walkthrough_completed:\s*true/);
  assert.match(route, /walkthrough_completed_at/);
});

test("onboarding explains the actual product without creating fake activity", () => {
  const tour = read("src/components/product/DashboardOnboarding.tsx");
  assert.match(tour, /Watchfloor|shared chat workspace/);
  assert.match(tour, /npx m9r-cli init/);
  assert.match(tour, /Rules|Approval Center/);
  // Efficiency was cut from the product (0 of 349 production runs ever had
  // token or cost data -- the page could never render a real number) and
  // dropped from the tour along with it.
  assert.doesNotMatch(tour, /Efficiency/);
  assert.doesNotMatch(tour, /create run|seed|synthetic/i);
});

test("reviewer demo remains separately seeded and read-only", () => {
  const page = read("src/app/dashboard/agents/page.tsx");
  const demo = read("src/components/product/ReviewerDemoWorkspace.tsx");
  assert.match(page, /isReviewerDemoAppMetadata/);
  assert.match(demo, /Seeded\/redacted evidence/);
  assert.match(demo, /No production record is changed/);
});
