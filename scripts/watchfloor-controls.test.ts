import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { buildRunContract } from "../src/lib/run-contract-service.ts";
import { nextDashboardMode, normalizeDashboardMode } from "../src/lib/dashboard-mode.ts";

const root = process.cwd();
const WORKSPACE_PATH = "src/components/product/AgentWorkspaceClient.tsx";
// AgentWorkspaceClient.tsx was split into src/components/product/agent-workspace/*
// with the orchestrator left in the original file. `read(WORKSPACE_PATH)`
// transparently returns the concatenation of the orchestrator plus every
// split file, so assertions below keep checking the same source text
// regardless of which file it now lives in -- same multi-file-read pattern
// as scripts/workspace-rules.test.ts.
const WORKSPACE_SPLIT_FILES = [
  WORKSPACE_PATH,
  "src/components/product/agent-workspace/shared.tsx",
  "src/components/product/agent-workspace/strip-board.tsx",
  "src/components/product/agent-workspace/run-panels.tsx",
  "src/components/product/agent-workspace/preflight.tsx",
  "src/components/product/agent-workspace/approval-center.tsx",
  "src/components/product/agent-workspace/handoff.tsx",
];
const read = (path: string) =>
  path === WORKSPACE_PATH
    ? WORKSPACE_SPLIT_FILES.map((f) => readFileSync(resolve(root, f), "utf8")).join("\n")
    : readFileSync(resolve(root, path), "utf8");

test("Run Contract v1 describes a bounded permission mode without claiming enforcement", () => {
  const contract = buildRunContract({
    task: "Update the Approval Center layout",
    preflightStatus: "warned",
    preflightRisk: "medium",
    activeRuleCount: 3,
  });

  assert.equal(contract.permissionMode, "Guarded change");
  assert.match(contract.summary, /3 active rules/i);
  assert.match(contract.prompt, /Permission mode: Guarded change/);
  assert.match(contract.prompt, /This is a run contract, not an execution sandbox\./);
  assert.ok(!contract.prompt.includes("guaranteed"));
});

test("the Run Contract permission mode surfaces in the controlled handoff", () => {
  const workspace = read("src/components/product/AgentWorkspaceClient.tsx");
  assert.match(workspace, /Run Contract/);
  assert.match(workspace, /handoff\.runContract\.permissionMode/);
  assert.match(workspace, /Copy Run Contract prompt/);
});

test("the Watchfloor stays opinionated: no layout preferences, no bulk review", () => {
  const workspace = read("src/components/product/AgentWorkspaceClient.tsx");
  assert.ok(!/watchfloor-preferences|WATCHFLOOR_PREFERENCES|Arrange Watchfloor/.test(workspace), "layout preference chrome must stay removed");
  assert.ok(!/review-bulk|Approve all routine|isRoutineApproval/.test(workspace), "bulk review must stay removed — every review record is an individual human decision");
  assert.ok(!existsSync(resolve(root, "src/lib/watchfloor-preferences.ts")));
  assert.ok(!existsSync(resolve(root, "src/app/api/watchfloor-preferences")));
  assert.ok(!existsSync(resolve(root, "src/app/api/agent/runs/review-bulk")));
  assert.ok(!/watchfloor_preferences/.test(read("supabase-schema.sql")));
});

test("the broken Watchfloor drill is replaced by the shell onboarding", () => {
  assert.ok(existsSync(resolve(root, "src/components/product/DashboardOnboarding.tsx")));
  assert.match(read("src/components/product/ProductShell.tsx"), /DashboardOnboarding/);
  assert.doesNotMatch(read("src/components/product/AgentWorkspaceClient.tsx"), /WatchfloorDrill|Run the drill/);
});

test("the pre-hydration mode script follows the supported InlineScript pattern", () => {
  // Next.js 16 guide (preventing-flash-before-hydration): rendered <script>
  // tags need type "text/javascript" on the server and "text/plain" on the
  // client, plus suppressHydrationWarning — raw dangerouslySetInnerHTML
  // scripts in the layout warn during client navigation and never execute.
  const script = read("src/components/product/WatchfloorModeScript.tsx");
  assert.match(script, /"use client"/);
  assert.match(script, /typeof window === "undefined" \? "text\/javascript" : "text\/plain"/);
  assert.match(script, /suppressHydrationWarning/);
  // Soft navigations bypass inline scripts, so the client applies the stored
  // mode on mount from the same storage key the script reads.
  assert.match(script, /m9r_mode/);
  assert.match(script, /useEffect/);
  const layout = read("src/app/dashboard/layout.tsx");
  assert.match(layout, /WatchfloorModeScript/);
  assert.doesNotMatch(layout, /dangerouslySetInnerHTML/);
});

test("the dashboard and ops floor share one day/night mode contract", () => {
  assert.equal(normalizeDashboardMode("day"), "day");
  assert.equal(normalizeDashboardMode("night"), "night");
  assert.equal(normalizeDashboardMode("unexpected"), "day");
  assert.equal(nextDashboardMode("night"), "day");
  assert.equal(nextDashboardMode("day"), "night");

  const shell = read("src/components/product/ProductShell.tsx");
  const floor = read("src/components/product/WatchfloorOps.tsx");
  assert.match(shell, /applyDashboardMode/);
  assert.match(shell, /DASHBOARD_MODE_EVENT/);
  assert.doesNotMatch(floor, /DASHBOARD_MODE_EVENT|readDashboardMode|applyDashboardMode|nextDashboardMode|wo-mode-toggle/);
  assert.match(floor, /forcedMode/);
  // HeroFloor (a staged terminal forced into data-bs-mode="night") was
  // replaced by HeroChatPreview -- a live-product chat preview scoped
  // entirely under .lp-chat-preview's own --lp-* tokens, never .wf-root, so
  // there's no ambient data-bs-mode context to defend against here (verified
  // no CSS rule gates .lp-chat-preview or AgentMark on [data-bs-mode]).
  assert.doesNotMatch(read("src/app/globals.css"), /\.wf-root\[data-bs-mode[^{]*\.lp-chat-preview/);
  assert.doesNotMatch(floor, /oathlock-watch-mode/);
});

test("theme switching uses a bounded transition without rerendering the ops floor", () => {
  const mode = read("src/lib/dashboard-mode.ts");
  const css = read("src/app/globals.css");
  assert.match(mode, /data-mode-transitioning/);
  assert.match(mode, /requestAnimationFrame/);
  assert.match(css, /data-mode-transitioning/);
  assert.doesNotMatch(css, /data-mode-transitioning[^}]*\*/);
});

test("the sidebar keeps navigation scrollable and the complete account row visible", () => {
  const css = read("src/app/globals.css");
  assert.match(css, /\.product-nav\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/);
  assert.match(css, /\.product-sidebar-footer\s*\{[\s\S]*?flex:\s*none;/);
  assert.match(css, /\.product-account\s*\{[\s\S]*?min-width:\s*0;/);
});

test("the Watchfloor is live: self-refresh, tab badge, ticking clocks, opt-in notifications", () => {
  const workspace = read("src/components/product/AgentWorkspaceClient.tsx");
  // Poll-refresh only while the tab is visible.
  assert.match(workspace, /document\.visibilityState === "visible"/);
  assert.match(workspace, /router\.refresh\(\)/);
  assert.match(workspace, /visibilitychange/);
  assert.match(workspace, /window\.addEventListener\("focus"/);
  assert.match(workspace, /LIVE_REFRESH_INTERVAL_MS/);
  assert.match(workspace, /IDLE_REFRESH_INTERVAL_MS/);
  assert.match(workspace, /const hasLiveActivity = hasLiveRun \|\| pendingDecisions > 0/);
  assert.match(workspace, /hasLiveActivity \? LIVE_REFRESH_INTERVAL_MS : IDLE_REFRESH_INTERVAL_MS/);
  // Tab title carries the pending-decision count.
  assert.match(workspace, /\(\$\{pendingDecisions\}\) M9R/);
  // Elapsed timer on the live run and a relative-time tick.
  assert.match(workspace, /function ElapsedTimer/);
  assert.match(workspace, /setClock/);
  // Notifications are opt-in and only fire when the pending count rises.
  assert.match(workspace, /Notification\.requestPermission/);
  assert.match(workspace, /Notification\.permission === "granted"/);
  assert.match(workspace, /pendingDecisions > prevPendingRef\.current/);
});


test("sidebar sign out is an accessible symbol rather than text chrome", () => {
  const shell = read("src/components/product/ProductShell.tsx");
  assert.match(shell, /aria-label="Sign out"/);
  assert.match(shell, /<svg[^>]*viewBox="0 0 18 18"/);
  assert.doesNotMatch(shell, />Sign out<|\? "Sign out"/);
});
