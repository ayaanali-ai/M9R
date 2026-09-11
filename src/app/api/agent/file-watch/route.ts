import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { recordWorkspaceFileActivity } from "@/lib/bridge/workspace-file-activity-service";
import { handleAgentError } from "../_shared";

const MAX_EVENTS_PER_REQUEST = 200;
const MAX_CONTENT_CHARS = 20_000;

interface FileWatchEvent {
  filePath: string;
  activityKind: "create" | "changed" | "delete";
  newText?: string | null;
}

function isValidEvent(value: unknown): value is FileWatchEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return typeof event.filePath === "string" && event.filePath.trim().length > 0
    && (event.activityKind === "create" || event.activityKind === "changed" || event.activityKind === "delete");
}

/**
 * POST /api/agent/file-watch — real filesystem events from the one
 * per-machine resident process (scripts/oathlock-terminal-bridge.ts), not
 * from any agent's own tool call. This is what makes the Files rail and
 * Live Code honestly "live": a file deleted or changed any way other than
 * an agent's own reported tool call (a human editing directly, `git
 * checkout`, anything) previously left workspace_file_activity's last row
 * unchanged, so the UI kept showing it as current forever. See
 * workspace-file-activity-service.ts's WorkspaceFileActivitySource doc
 * comment for why these rows carry no connectionId/conversationId and are
 * excluded from the per-agent "eyes" presence mechanism.
 *
 * Auth reuses the same Bearer agent-token scheme bridge-commands already
 * does for the reconnect poll -- any one connected provider's token proves
 * "a resident for this workspace sent this," which is all that's needed
 * for a workspace-scoped write.
 */
export async function POST(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });

    const body = await req.json().catch(() => null) as { events?: unknown } | null;
    const rawEvents = Array.isArray(body?.events) ? body.events : null;
    if (!rawEvents) return NextResponse.json({ error: "events must be an array." }, { status: 400 });
    const events = rawEvents.filter(isValidEvent).slice(0, MAX_EVENTS_PER_REQUEST);

    await Promise.all(events.map((event) => recordWorkspaceFileActivity({
      workspaceId: agent.workspaceId,
      conversationId: null,
      connectionId: null,
      messageId: null,
      filePath: event.filePath,
      activityKind: event.activityKind,
      status: "succeeded",
      newText: event.activityKind === "delete" ? null : (event.newText?.slice(0, MAX_CONTENT_CHARS) ?? null),
      source: "fs_watch",
    })));

    return NextResponse.json({ ok: true, recorded: events.length });
  } catch (err) {
    return handleAgentError(err);
  }
}
