import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("W1a endpoint API is session-workspace scoped and does not silently hide machine lookup failures", () => {
  const route = read("src/app/api/dashboard/endpoints/route.ts");
  assert.match(route, /dashboardWorkspaceContext\(\)/);
  assert.match(route, /if \(!context\)/);
  assert.match(route, /status: 401/);
  assert.match(route, /loadWorkspaceEndpointsForHuman\(context\.workspaceId, context\.userId\)/);
  assert.match(route, /\.eq\("workspace_id", context\.workspaceId\)/);
  assert.match(route, /if \(error\) throw/);
  assert.match(route, /"cache-control": "no-store"/);
  assert.doesNotMatch(route, /request\.(?:json|url)/);
});

test("W1a endpoint panel uses human-readable connection copy and keeps the existing setup state", () => {
  const panel = read("src/components/product/WorkspaceEndpointCard.tsx");
  const agentsPage = read("src/app/dashboard/agents/page.tsx");
  const nativeResume = read("src/components/product/agent-workspace/strip-board.tsx");
  assert.match(agentsPage, /<WorkspaceEndpointCard\s*\/>/);
  assert.match(panel, /fetch\("\/api\/dashboard\/endpoints"/);
  assert.match(panel, /aria-label=\{row\.reachability\}/);
  assert.match(panel, /Connected/);
  assert.match(panel, /Ask only/);
  assert.doesNotMatch(panel, /\{row\.fidelity\.level\}|gen \{row\.generation\}|Machine \$\{row\.machineId/);
  assert.match(panel, /row\.presence\.lastSeenAt/);
  assert.match(panel, /ONBOARDING_STEPS/);
  assert.match(panel, /Claude connected:/);
  assert.match(panel, /Codex hook trust and desktop restart: verify locally/);
  assert.match(nativeResume, /Resume natively/);
});

test("W1a delivery route authenticates from the session and delegates with its active workspace", () => {
  const route = read("src/app/api/dashboard/messages/[messageId]/delivery/route.ts");
  assert.match(route, /dashboardWorkspaceContext\(\)/);
  assert.match(route, /if \(!context\)/);
  assert.match(route, /status: 401/);
  assert.match(route, /getDashboardMessageDelivery\(context\.workspaceId, context\.userId, messageId\)/);
  assert.match(route, /status === 404/);
  assert.match(route, /"cache-control": "no-store"/);
  assert.doesNotMatch(route, /request\.(?:json|url)/);
});

test("W1b delivery timeline is limited to actual agent-directed messages", () => {
  const panel = read("src/components/product/ConversationPanel.tsx");
  assert.match(panel, /function isAgentDirectedMessage[\s\S]*explicitlyMentionedAgentKinds\([\s\S]*agents\.map/);
  assert.match(panel, /message\.recipient_connection_id/);
  assert.doesNotMatch(panel, /message\.kind !== "notice" && \/@\[a-z\]/);
});

test("W1b delivery details exposes attempts, retry/failure context, evidence and loading/error states", () => {
  const details = read("src/components/product/MessageDeliveryDetails.tsx");
  assert.match(details, /aria-expanded=\{open\}/);
  assert.match(details, /aria-busy=\{loading\}/);
  assert.match(details, /delivery\.attempt/);
  assert.match(details, /delivery\.failureCode/);
  assert.match(details, /delivery\.declined/);
  assert.match(details, /delivery\.pendingUntilTurnBoundary/);
  assert.match(details, /entry\.basis/);
  assert.match(details, /entry\.evidence/);
  assert.match(details, /entry\.persisted/);
  assert.match(details, /delivery\.notes/);
  assert.match(details, /role="status"/);
  assert.match(details, /role="alert"/);
});
