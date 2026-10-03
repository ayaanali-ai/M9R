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

test("W1a the endpoint strip is gone; connection state lives in the sidebar and a first-run card shows only until an agent connects", () => {
  const agentsPage = read("src/app/dashboard/agents/page.tsx");
  const shell = read("src/components/product/ProductShell.tsx");
  const card = read("src/components/product/FirstRunCard.tsx");
  assert.doesNotMatch(agentsPage, /WorkspaceEndpointCard/);
  assert.match(agentsPage, /agents\.some\(\(agent\) => agent\.connected\)/);
  assert.match(agentsPage, /<FirstRunCard \/>/);
  assert.match(card, /npx m9r-cli init/);
  assert.match(shell, /agents? connected/);
  assert.match(shell, /m9r-dash-conn/);
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
