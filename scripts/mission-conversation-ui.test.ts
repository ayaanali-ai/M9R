import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const service = readFileSync("src/lib/mission/mission-application-service.ts", "utf8");
const route = readFileSync("src/app/api/missions/[missionId]/conversation/route.ts", "utf8");
const commandCenter = readFileSync("src/components/product/MissionCommandCenter.tsx", "utf8");
const workspace = readFileSync("src/components/product/MissionConversationWorkspace.tsx", "utf8");
const productConversation = readFileSync("src/components/product/ConversationPanel.tsx", "utf8");

test("conversation read is tenant-scoped and uses the unbounded event-stream message query", () => {
  assert.match(service, /getMissionConversation[\s\S]*loadProjection\(d, missionId, principal\.workspaceId\)/);
  assert.match(service, /queryMissionMessages\(events, \{ limit, cursor \}\)/);
  assert.match(service, /Math\.min\(Math\.max\(options\.limit \?\? 100, 1\), 200\)/);
});

test("conversation DTO omits structured payloads and participant permissions", () => {
  const dtoBlock = service.slice(
    service.indexOf("export interface MissionConversationDto"),
    service.indexOf("function summarizeEvent"),
  );
  assert.doesNotMatch(dtoBlock, /structuredPayload|workspacePermissions|communicationPermissions|leaseId|fencingToken/);
});

test("conversation route uses the established Mission principal boundary", () => {
  assert.match(route, /withMissionPrincipal\(req, \{ requestedWorkspaceId: queryWorkspaceId\(req\) \}\)/);
  assert.match(route, /NextResponse\.json\(\{ conversation \}\)/);
});

test("Mission detail exposes a real lazy-loaded Conversation tab", () => {
  assert.match(commandCenter, /\{ id: "conversation", label: "Conversation" \}/);
  assert.match(commandCenter, /<MissionConversationWorkspace missionId=\{missionId\} workspaceId=\{mission\.workspaceId\} mission=\{mission\} viewerUserId=\{viewerUserId\} \/>/);
  assert.match(commandCenter, /\{ id: "workspace", label: "Mission Workspace" \}/);
  assert.match(workspace, /\/conversation\?limit=200/);
  assert.match(workspace, /\/deliveries\?limit=500/);
  assert.match(workspace, /buildMissionThreads/);
  assert.match(workspace, /mentionedParticipantIds/);
  assert.match(workspace, /Search messages, agents, or message types/);
  assert.match(workspace, /Reply in thread/);
  assert.match(workspace, /Channels/);
  assert.match(workspace, /Agent roster/);
  assert.match(workspace, /participant\.typing/);
  assert.match(workspace, /refreshNotifications/);
  assert.doesNotMatch(workspace, /senderParticipantId.*useState/);
  assert.match(service, /communicationPolicy: \{ \.\.\.DEFAULT_COMMUNICATION_POLICY, allowBroadcast: true \}/);
});

test("workspace relay refreshes short-lived credentials and keeps HTTP fallback available", () => {
  assert.match(productConversation, /getCredential: async \(\) => \(await fetchRelayCredential\(\)\)\.token!/);
  assert.match(productConversation, /setRelayHttpFallback\(true\)/);
});

test("Mission conversation workspace exposes channels and agent context without a separate diagnostics section", () => {
  assert.match(workspace, /Channels/);
  assert.match(workspace, /Agent roster/);
  // Confirmed no unique action lived in the old "Diagnostics & Handoffs"
  // section (opening a row did exactly what any other channel row does),
  // and isDiagnosticConversation/DIAGNOSTIC_INACTIVITY_MS stay untouched --
  // they also drive real 24h stale-test-channel auto-retirement server-side.
  assert.doesNotMatch(productConversation, /Diagnostics &amp; handoffs/);
  assert.doesNotMatch(productConversation, /showDiagnostics/);
  assert.match(productConversation, /isDiagnosticConversation|diagnostic/);
});

test("built-in rooms cannot be archived and stale diagnostics use reversible archival", () => {
  const conversationService = readFileSync("src/lib/conversation-service.ts", "utf8");
  assert.match(conversationService, /BUILT_IN_CHANNEL_ARCHIVE_FORBIDDEN/);
  assert.match(conversationService, /DIAGNOSTIC_INACTIVITY_MS/);
  assert.match(conversationService, /\.is\("mission_id", null\)/);
  assert.match(conversationService, /status: "closed", archived_at/);
});
