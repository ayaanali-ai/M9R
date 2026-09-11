/**
 * conversation_message_todos CRUD -- the durable half of the live checklist
 * an agent renders inside its own message bubble.
 *
 * The live half is the `workspace.todos` relay frame (mission-relay-client.ts),
 * which is point-in-time and vanishes on refresh the same way steps and turn
 * state do. A checklist is not a status ping though: it is meant to read as
 * one evolving message, so the last known state has to survive a reload.
 * That is what this table is for -- the relay frame is the fast path, this
 * is the truth a page load reads back.
 *
 * Status vocabulary is ACP's own (PlanEntryStatus: pending | in_progress |
 * completed) rather than a parallel invented one, so nothing has to be
 * translated back when reading a stored row against a live provider update.
 */

import { supabase } from "@/lib/supabase";

export const MESSAGE_TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export type MessageTodoStatus = (typeof MESSAGE_TODO_STATUSES)[number];

export const MESSAGE_TODO_PRIORITIES = ["high", "medium", "low"] as const;
export type MessageTodoPriority = (typeof MESSAGE_TODO_PRIORITIES)[number];

export interface MessageTodoEntry {
  content: string;
  status: MessageTodoStatus;
  priority: MessageTodoPriority;
}

export interface MessageTodoState {
  message_id: string;
  /** The agent that reported this checklist. Two agents can be working the
   * same anchor message at once, so a checklist is theirs, not the
   * message's -- see the migration's own note. */
  connection_id: string;
  entries: MessageTodoEntry[];
  updated_at: string;
}

/** A checklist is a human-readable list, not a data feed: past this many
 * entries it stops being a checklist and starts being a log, and the relay
 * frame carrying it starts pushing against the per-frame payload limit. */
export const MAX_MESSAGE_TODO_ENTRIES = 50;
const MAX_TODO_CONTENT_LENGTH = 240;

function requireService() {
  if (!supabase) throw new Error("M9R backend is not configured.");
  return supabase;
}

/**
 * Runtime-validates and bounds an entries array coming off the wire (an
 * agent-facing HTTP body, or a relay payload) -- never trusted as typed.
 * Anything that is not a usable entry is dropped rather than defaulted into
 * a wrong status: a checklist that silently invents "completed" is worse
 * than a shorter checklist.
 */
export function normalizeMessageTodoEntries(input: unknown): MessageTodoEntry[] {
  if (!Array.isArray(input)) return [];
  const entries: MessageTodoEntry[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const value = raw as { content?: unknown; status?: unknown; priority?: unknown };
    if (typeof value.content !== "string") continue;
    const content = value.content.trim().slice(0, MAX_TODO_CONTENT_LENGTH);
    if (!content) continue;
    const status = MESSAGE_TODO_STATUSES.find((candidate) => candidate === value.status);
    if (!status) continue;
    const priority = MESSAGE_TODO_PRIORITIES.find((candidate) => candidate === value.priority) ?? "medium";
    entries.push({ content, status, priority });
    if (entries.length >= MAX_MESSAGE_TODO_ENTRIES) break;
  }
  return entries;
}

/**
 * Replaces (not merges) one agent's checklist on one message. ACP's plan
 * contract is that every update carries the complete list and the client
 * replaces the whole plan, so an upsert on (message_id, connection_id) is
 * the exact right write -- there is no per-entry identity to reconcile.
 */
export async function upsertMessageTodos(input: {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  connectionId: string;
  entries: MessageTodoEntry[];
}): Promise<MessageTodoState> {
  const db = requireService();
  const updatedAt = new Date().toISOString();
  const { error } = await db.from("conversation_message_todos").upsert({
    message_id: input.messageId,
    workspace_id: input.workspaceId,
    conversation_id: input.conversationId,
    connection_id: input.connectionId,
    entries: input.entries,
    updated_at: updatedAt,
  }, { onConflict: "message_id,connection_id" });
  if (error) throw new Error(`Could not store the message checklist: ${error.message}`);
  return { message_id: input.messageId, connection_id: input.connectionId, entries: input.entries, updated_at: updatedAt };
}

/** Batched read for a message list -- same shape as the attachments fetch in listConversationsForDashboard, grouped by message id. */
export async function listMessageTodosForConversations(conversationIds: string[]): Promise<Map<string, MessageTodoState[]>> {
  const byMessageId = new Map<string, MessageTodoState[]>();
  if (conversationIds.length === 0) return byMessageId;
  const db = requireService();
  const { data, error } = await db.from("conversation_message_todos")
    .select("message_id, connection_id, entries, updated_at").in("conversation_id", conversationIds);
  // A workspace whose migration has not been applied yet must not take the
  // whole channel list down over an additive feature.
  if (error) return byMessageId;
  for (const raw of data ?? []) {
    const row = raw as { message_id: unknown; connection_id: unknown; entries?: unknown; updated_at: unknown };
    const entries = normalizeMessageTodoEntries(row.entries);
    if (entries.length === 0) continue;
    const messageId = String(row.message_id);
    const state: MessageTodoState = { message_id: messageId, connection_id: String(row.connection_id), entries, updated_at: String(row.updated_at) };
    byMessageId.set(messageId, [...(byMessageId.get(messageId) ?? []), state]);
  }
  return byMessageId;
}
