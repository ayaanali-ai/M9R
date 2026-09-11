/**
 * conversation_drafts / conversation_draft_sections CRUD -- the durable
 * store behind shared co-drafting (#13). Same split as message-todo-
 * service.ts: this file is pure data access with no participant/auth
 * checks of its own, conversation-service.ts wraps every export here with
 * the real requireParticipant guard so there is exactly one place that
 * decides who may touch a conversation's drafts.
 */

import { supabase } from "@/lib/supabase";

export const DRAFT_STATUSES = ["draft", "ready"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

const MAX_TITLE_LENGTH = 200;
const MAX_HEADING_LENGTH = 120;
const MAX_BODY_LENGTH = 8_000;
/** A document, not a dumping ground -- past this many sections a draft has
 * stopped being one reviewable artifact. */
const MAX_SECTIONS_PER_DRAFT = 40;

export interface DraftSection {
  id: string;
  heading: string;
  body: string;
  position: number;
  authorKind: "agent" | "human";
  authorConnectionId: string | null;
  authorUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Draft {
  id: string;
  conversationId: string;
  title: string;
  status: DraftStatus;
  createdAt: string;
  updatedAt: string;
  sections: DraftSection[];
}

function requireService() {
  if (!supabase) throw new Error("M9R backend is not configured.");
  return supabase;
}

function toSection(row: Record<string, unknown>): DraftSection {
  return {
    id: String(row.id),
    heading: String(row.heading),
    body: String(row.body),
    position: Number(row.position ?? 0),
    authorKind: row.author_kind === "human" ? "human" : "agent",
    authorConnectionId: typeof row.author_connection_id === "string" ? row.author_connection_id : null,
    authorUserId: typeof row.author_user_id === "string" ? row.author_user_id : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** Batched read for a whole conversation, newest draft first, sections in
 * document order -- the one call both the agent-facing GET and the
 * dashboard read use. */
export async function listDraftsForConversation(workspaceId: string, conversationId: string): Promise<Draft[]> {
  const db = requireService();
  const { data: drafts, error } = await db
    .from("conversation_drafts")
    .select("id, title, status, created_at, updated_at")
    .eq("workspace_id", workspaceId)
    .eq("conversation_id", conversationId)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`Could not read drafts: ${error.message}`);
  const draftRows = drafts ?? [];
  if (draftRows.length === 0) return [];

  const draftIds = draftRows.map((row) => row.id as string);
  const { data: sections, error: sectionsError } = await db
    .from("conversation_draft_sections")
    .select("id, draft_id, heading, body, position, author_kind, author_connection_id, author_user_id, created_at, updated_at")
    .in("draft_id", draftIds)
    .order("position", { ascending: true });
  if (sectionsError) throw new Error(`Could not read draft sections: ${sectionsError.message}`);

  const sectionsByDraft = new Map<string, DraftSection[]>();
  for (const row of sections ?? []) {
    const draftId = String((row as { draft_id: unknown }).draft_id);
    const list = sectionsByDraft.get(draftId) ?? [];
    list.push(toSection(row as Record<string, unknown>));
    sectionsByDraft.set(draftId, list);
  }

  return draftRows.map((row) => ({
    id: row.id as string,
    conversationId,
    title: row.title as string,
    status: (row.status as DraftStatus) ?? "draft",
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    sections: sectionsByDraft.get(row.id as string) ?? [],
  }));
}

/**
 * The one write path for co-drafting: finds or creates a draft by title
 * within the conversation (case-insensitive), then upserts one named
 * section (also case-insensitive on heading) -- an agent or human writing
 * the same heading again is an intentional revision, not a duplicate.
 * Whoever writes last owns the section's attribution.
 */
export async function upsertDraftSection(input: {
  workspaceId: string;
  conversationId: string;
  draftTitle: string;
  heading: string;
  body: string;
  author: { kind: "agent"; connectionId: string } | { kind: "human"; userId: string };
}): Promise<Draft> {
  const db = requireService();
  const title = input.draftTitle.trim().slice(0, MAX_TITLE_LENGTH);
  const heading = input.heading.trim().slice(0, MAX_HEADING_LENGTH);
  const body = input.body.trim().slice(0, MAX_BODY_LENGTH);
  if (!title) throw new Error("draftTitle is required.");
  if (!heading) throw new Error("heading is required.");
  if (!body) throw new Error("body is required.");

  const { data: existingDraft, error: findError } = await db
    .from("conversation_drafts")
    .select("id, status")
    .eq("workspace_id", input.workspaceId)
    .eq("conversation_id", input.conversationId)
    .ilike("title", title)
    .maybeSingle();
  if (findError) throw new Error(`Could not look up the draft: ${findError.message}`);

  let draftId: string;
  if (existingDraft) {
    draftId = existingDraft.id as string;
    if (existingDraft.status === "ready") {
      throw new Error(`"${title}" is marked ready and no longer accepting edits. Start a new draft instead.`);
    }
  } else {
    const { data: created, error: createError } = await db
      .from("conversation_drafts")
      .insert({
        workspace_id: input.workspaceId,
        conversation_id: input.conversationId,
        title,
        created_by_user_id: input.author.kind === "human" ? input.author.userId : null,
        created_by_connection_id: input.author.kind === "agent" ? input.author.connectionId : null,
      })
      .select("id")
      .single();
    if (createError || !created) throw new Error(`Could not create the draft: ${createError?.message ?? "unknown error"}`);
    draftId = created.id as string;
  }

  const { data: existingSection, error: sectionFindError } = await db
    .from("conversation_draft_sections")
    .select("id, position")
    .eq("draft_id", draftId)
    .ilike("heading", heading)
    .maybeSingle();
  if (sectionFindError) throw new Error(`Could not look up the section: ${sectionFindError.message}`);

  const authorFields = input.author.kind === "agent"
    ? { author_kind: "agent" as const, author_connection_id: input.author.connectionId, author_user_id: null }
    : { author_kind: "human" as const, author_connection_id: null, author_user_id: input.author.userId };

  if (existingSection) {
    const { error: updateError } = await db
      .from("conversation_draft_sections")
      .update({ body, updated_at: new Date().toISOString(), ...authorFields })
      .eq("id", existingSection.id);
    if (updateError) throw new Error(`Could not update the section: ${updateError.message}`);
  } else {
    const { count, error: countError } = await db
      .from("conversation_draft_sections")
      .select("id", { count: "exact", head: true })
      .eq("draft_id", draftId);
    if (countError) throw new Error(`Could not count existing sections: ${countError.message}`);
    if ((count ?? 0) >= MAX_SECTIONS_PER_DRAFT) throw new Error(`"${title}" already has ${MAX_SECTIONS_PER_DRAFT} sections, the most one draft can hold.`);
    const { error: insertError } = await db
      .from("conversation_draft_sections")
      .insert({ draft_id: draftId, heading, body, position: count ?? 0, ...authorFields });
    if (insertError) throw new Error(`Could not add the section: ${insertError.message}`);
  }

  await db.from("conversation_drafts").update({ updated_at: new Date().toISOString() }).eq("id", draftId);

  const [draft] = await listDraftsForConversation(input.workspaceId, input.conversationId).then((all) => all.filter((d) => d.id === draftId));
  if (!draft) throw new Error("Draft was written but could not be read back.");
  return draft;
}

/** Human-only: marks a draft finished and locks it against further section
 * writes (see upsertDraftSection's ready check above) -- the explicit
 * signal that it is safe to hand off as a real artifact (a PR description,
 * a spec) rather than still being actively co-authored. */
export async function setDraftStatus(input: { workspaceId: string; conversationId: string; draftId: string; status: DraftStatus }): Promise<void> {
  const db = requireService();
  const { data, error } = await db
    .from("conversation_drafts")
    .update({ status: input.status, updated_at: new Date().toISOString() })
    .eq("id", input.draftId)
    .eq("workspace_id", input.workspaceId)
    .eq("conversation_id", input.conversationId)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`Could not update the draft status: ${error.message}`);
  if (!data) throw new Error("Draft was not found in this conversation.");
}
