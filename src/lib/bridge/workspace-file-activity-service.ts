/**
 * workspace_file_activity CRUD -- the durable record behind the live step
 * feed and the cross-agent "eyes" prompt injection. Previously this data
 * (real ACP tool-call events: file reads, file writes, real diff content)
 * only ever reached a live WebSocket relay frame with, by the relay's own
 * doc comment, "no replay-on-reconnect cache" -- a human who reloaded the
 * page, or another agent's session starting fresh, saw nothing. This table
 * is the fix: every real activity event gets persisted here first, and the
 * live relay push stays exactly as it was, now fed from the same write.
 *
 * Diff content (oldText/newText/diffPatch) is redacted with the same
 * heuristic used on real session transcripts (redactSession with
 * includeHeuristics on) before it is ever written -- a diff is exactly
 * where a credential or .env value would leak verbatim, more so than a
 * short structured summary label.
 */
import { supabase } from "@/lib/supabase";
import { redactSession } from "@/lib/session-redaction";

/** Where an activity row actually came from -- an agent's own real ACP tool
 * call, or the machine-level filesystem watcher (see the migration's own
 * doc comment for why this exists: a file can vanish or change with no
 * agent ever reporting it, and the watcher is the only honest way to know
 * that). The "eyes" cross-agent mechanism and any per-agent presence view
 * must only ever look at 'agent_tool_call' rows -- a filesystem event isn't
 * "an agent is doing this right now." */
export type WorkspaceFileActivitySource = "agent_tool_call" | "fs_watch";

export interface WorkspaceFileActivityInput {
  workspaceId: string;
  /** Null for a fs_watch row -- a disk event belongs to no specific channel. */
  conversationId: string | null;
  /** Null for a fs_watch row -- a disk event belongs to no specific agent turn. */
  connectionId: string | null;
  messageId: string | null;
  filePath: string;
  activityKind: "read" | "changed" | "create" | "delete";
  status: "started" | "succeeded" | "failed";
  oldText?: string | null;
  newText?: string | null;
  diffPatch?: string | null;
  additions?: number | null;
  deletions?: number | null;
  source?: WorkspaceFileActivitySource;
}

export interface WorkspaceFileActivityRow {
  id: string;
  connectionId: string | null;
  filePath: string;
  activityKind: WorkspaceFileActivityInput["activityKind"];
  status: WorkspaceFileActivityInput["status"];
  oldText: string | null;
  newText: string | null;
  diffPatch: string | null;
  additions: number | null;
  deletions: number | null;
  createdAt: string;
  updatedAt: string;
  source: WorkspaceFileActivitySource;
}

export interface WorkspaceFileSummaryRow {
  filePath: string;
  connectionId: string | null;
  activityKind: WorkspaceFileActivityInput["activityKind"];
  status: WorkspaceFileActivityInput["status"];
  /** From the same most-recent row the rest of this summary comes from, so
   * the Files rail can show +N/-N without a second query. Null for an
   * activity that carried no counts (a read, or a pre-counts row). */
  additions: number | null;
  deletions: number | null;
  updatedAt: string;
  /** True when this row's raw status is still "started" but has sat
   * unresolved longer than a turn is ever allowed to run (see
   * STARTED_STALE_AFTER_MS below) -- the agent CLI's own turn timeout has
   * already fired by this point, so the write it was reporting is
   * definitely not still in flight, whatever the last-written status says.
   * A dedicated field rather than silently rewriting `status`: this keeps
   * the raw value honest (it really was reported as "started" and nothing
   * ever corrected it) while letting the UI stop presenting it as live. */
  stale: boolean;
  source: WorkspaceFileActivitySource;
}

/** Matches acp-stdio-adapter.ts's own DEFAULT_PROMPT_TIMEOUT_MS -- the real
 * ceiling the system itself enforces on how long one turn may run before
 * declaring it abandoned. A "started" file-activity row older than this is
 * definitely from a turn that has already been abandoned by that same
 * rule, not a coincidentally slow write still legitimately in progress. */
const STARTED_STALE_AFTER_MS = 20 * 60 * 1_000;

function requireService() {
  if (!supabase) throw new Error("M9R backend is not configured.");
  return supabase;
}

/** A diff is real user/repo content, not a short structured label -- the
 * noisy heuristics (high-entropy, email) stay ON here, unlike a tool-call
 * title, per redactSession's own doc comment on when each mode is correct. */
function redact(text: string | null | undefined): string | null {
  if (!text) return text ?? null;
  return redactSession(text, { includeHeuristics: true }).redactedText;
}

const COLUMNS = "id, connection_id, file_path, activity_kind, status, old_text, new_text, diff_patch, additions, deletions, created_at, updated_at, source";

function toRow(row: Record<string, unknown>): WorkspaceFileActivityRow {
  return {
    id: String(row.id),
    connectionId: (row.connection_id as string | null) ?? null,
    filePath: String(row.file_path),
    activityKind: row.activity_kind as WorkspaceFileActivityInput["activityKind"],
    status: row.status as WorkspaceFileActivityInput["status"],
    oldText: (row.old_text as string | null) ?? null,
    newText: (row.new_text as string | null) ?? null,
    diffPatch: (row.diff_patch as string | null) ?? null,
    additions: (row.additions as number | null) ?? null,
    deletions: (row.deletions as number | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    source: (row.source as WorkspaceFileActivitySource | undefined) ?? "agent_tool_call",
  };
}

/** Bounded the same way every other agent-authored text field in this
 * codebase is (see acp-stdio-adapter.ts's boundedText) -- a large file edit
 * must truncate visibly, never silently balloon a row or a relay payload. */
const MAX_DIFF_CHARS = 20_000;

function boundedDiffText(text: string | null | undefined): string | null {
  if (text == null) return null;
  return text.length > MAX_DIFF_CHARS ? `${text.slice(0, MAX_DIFF_CHARS)}\n… (truncated, ${text.length - MAX_DIFF_CHARS} more characters)` : text;
}

export async function recordWorkspaceFileActivity(input: WorkspaceFileActivityInput): Promise<{ id: string }> {
  const db = requireService();
  const { data, error } = await db.from("workspace_file_activity").insert({
    workspace_id: input.workspaceId,
    conversation_id: input.conversationId,
    connection_id: input.connectionId,
    message_id: input.messageId,
    file_path: input.filePath.slice(0, 1024),
    activity_kind: input.activityKind,
    status: input.status,
    old_text: boundedDiffText(redact(input.oldText)),
    new_text: boundedDiffText(redact(input.newText)),
    diff_patch: boundedDiffText(redact(input.diffPatch)),
    additions: input.additions ?? null,
    deletions: input.deletions ?? null,
    source: input.source ?? "agent_tool_call",
  }).select("id").single();
  if (error) throw new Error(`Could not record workspace file activity: ${error.message}`);
  return { id: String(data.id) };
}

/** Every connected agent's current activity in one channel -- the read side
 * of the cross-agent "eyes" mechanism and the file-tree view's live markers.
 * "Current" means the most recent row per connection, not a full history
 * dump -- callers that want history query this table directly by
 * conversation_id instead. */
export async function listCurrentWorkspaceFileActivity(conversationId: string): Promise<WorkspaceFileActivityRow[]> {
  const db = requireService();
  const { data, error } = await db
    .from("workspace_file_activity")
    .select(COLUMNS)
    .eq("conversation_id", conversationId)
    .eq("source", "agent_tool_call")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`Could not list workspace file activity: ${error.message}`);
  const rows = (data ?? []).map(toRow);
  // Most-recent-per-connection, computed here rather than in SQL (DISTINCT
  // ON reads backwards to anyone not already fluent in it, and this table
  // is small enough per channel that an in-memory pass is simpler and just
  // as correct). agent_tool_call rows always carry a real connectionId (see
  // the migration's own comment -- only fs_watch rows go null, and those are
  // excluded above), so the non-null assertion here is safe.
  const seen = new Set<string>();
  const current: WorkspaceFileActivityRow[] = [];
  for (const row of rows) {
    if (!row.connectionId || seen.has(row.connectionId)) continue;
    seen.add(row.connectionId);
    current.push(row);
  }
  return current;
}

/**
 * File-tree data source for the Watchfloor's Files panel (Option A step 12):
 * one row per distinct file path ever touched in this workspace, showing
 * only the most recent activity for that path -- not full history. This
 * app's own server still never reads anyone's disk directly, but the rows
 * themselves now come from two real sources: an agent's own tool calls, and
 * the per-machine resident's real filesystem watcher (source: "fs_watch",
 * see WorkspaceFileActivitySource) -- so a file genuinely deleted, however
 * it happened, correctly disappears from this summary (see the succeeded-
 * delete filter below) instead of sitting here looking current forever.
 * Diff content is intentionally NOT selected here (only diffHistoryForPath
 * below fetches it) -- this summary can return hundreds of rows for the
 * tree and a diff body is real repo content, not something to pull hundreds
 * of copies of at once.
 */
export async function listWorkspaceFileSummary(workspaceId: string): Promise<WorkspaceFileSummaryRow[]> {
  const db = requireService();
  const { data, error } = await db
    .from("workspace_file_activity")
    .select("file_path, connection_id, activity_kind, status, additions, deletions, updated_at, source")
    .eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`Could not list workspace file summary: ${error.message}`);
  const seen = new Set<string>();
  const summary: WorkspaceFileSummaryRow[] = [];
  const now = Date.now();
  for (const row of data ?? []) {
    const filePath = String(row.file_path);
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    const activityKind = row.activity_kind as WorkspaceFileActivityInput["activityKind"];
    const status = row.status as WorkspaceFileActivityInput["status"];
    // A confirmed delete (from either an agent's own tool call or the real
    // filesystem watcher) means the file no longer exists -- drop it from
    // the tree entirely rather than leaving it clickable and looking alive.
    // This is the fix for the honesty gap found live: a file removed any
    // way other than an agent's own reported delete used to sit in this
    // list forever with no indication it was gone.
    if (activityKind === "delete" && status === "succeeded") continue;
    const updatedAt = String(row.updated_at);
    const stale = status === "started" && now - Date.parse(updatedAt) > STARTED_STALE_AFTER_MS;
    summary.push({
      filePath,
      connectionId: (row.connection_id as string | null) ?? null,
      activityKind,
      status,
      additions: (row.additions as number | null) ?? null,
      deletions: (row.deletions as number | null) ?? null,
      updatedAt,
      stale,
      source: (row.source as WorkspaceFileActivitySource | undefined) ?? "agent_tool_call",
    });
  }
  return summary;
}

/** Diff history for one file, most recent first -- feeds the click-to-diff
 * panel. Bounded to 20: enough to scrub recent history for one file without
 * turning a hot file into an unbounded payload. */
export async function diffHistoryForPath(workspaceId: string, filePath: string): Promise<WorkspaceFileActivityRow[]> {
  const db = requireService();
  const { data, error } = await db
    .from("workspace_file_activity")
    .select(COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("file_path", filePath)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(`Could not load diff history: ${error.message}`);
  return (data ?? []).map(toRow);
}
