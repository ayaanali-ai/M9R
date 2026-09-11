import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("deleteDashboardConversation exists, proves ownership, and refuses built-in channels the same way archive does", () => {
  const src = read("src/lib/conversation-service.ts");
  assert.match(src, /export async function deleteDashboardConversation\(conversationId: string\): Promise<void>/);
  // Same ownership proof every other mutation in this file uses.
  assert.match(src, /const conversation = await ownedConversation\(context, conversationId\)/);
  // Same core-channel refusal reasoning as archive, not a weaker or missing check.
  assert.match(src, /channelGroupForConversation\(\{ channelSlug: conversation\.channel_slug, channelKind: conversation\.channel_kind, topic: conversation\.topic \}\) === "core"/);
  assert.match(src, /Built-in workspace channels cannot be deleted\./);
});

test("deleteDashboardConversation performs a real, workspace-scoped delete, not a soft-archive relabel", () => {
  const src = read("src/lib/conversation-service.ts");
  const start = src.indexOf("export async function deleteDashboardConversation");
  const end = src.indexOf("\n}", start);
  const body = src.slice(start, end);
  assert.match(body, /\.from\("agent_conversations"\)\.delete\(\)/);
  assert.match(body, /\.eq\("id", conversation\.id\)/);
  assert.match(body, /\.eq\("workspace_id", context\.workspaceId\)/);
});

test("the conversations route exposes a real DELETE handler wired to deleteDashboardConversation", () => {
  const route = read("src/app/api/dashboard/conversations/[id]/route.ts");
  assert.match(route, /import \{ updateDashboardConversation, deleteDashboardConversation, leaveDashboardConversation \} from "@\/lib\/conversation-service"/);
  assert.match(route, /export async function DELETE\(/);
  assert.match(route, /await deleteDashboardConversation\(id\)/);
});

test("ConversationPanel uses the reusable confirmation dialog for destructive message actions", () => {
  const panel = read("src/components/product/ConversationPanel.tsx");
  assert.match(panel, /import ProductConfirmDialog from "@\/components\/product\/ProductConfirmDialog"/);
  assert.match(panel, /confirmDeleteMessageTarget/);
  assert.match(panel, /Delete this message\?/);
  assert.match(panel, /confirmDeleteMessage/);
  assert.match(panel, /<ProductConfirmDialog/);
  assert.match(panel, /tone="danger"/);
  assert.ok(!/window\.confirm\(|\bconfirm\(/.test(panel));
});

test("bulk channel selection is delete-only, with no Archive path anywhere in the batch endpoint or service", () => {
  const route = read("src/app/api/dashboard/conversations/batch/route.ts");
  assert.match(route, /body\?\.action !== "delete"/);
  // Explanatory comments are allowed to say "Archive"; what must never
  // exist is a live code path branching on it.
  assert.doesNotMatch(route, /action === "archive"/);
  assert.doesNotMatch(route, /archiveDashboardConversations/);
  const service = read("src/lib/conversation-service.ts");
  assert.doesNotMatch(service, /export async function archiveDashboardConversations/);
  assert.match(service, /export async function deleteDashboardConversations/);
});
