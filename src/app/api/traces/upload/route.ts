import { NextRequest, NextResponse } from "next/server";
import {
  uploadTrace,
  TraceUploadError,
  MAX_TRACE_BYTES,
  type TraceFileInfo,
} from "@/lib/trace-upload";
import { createClient } from "@/lib/supabase/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";

// ---------------------------------------------------------------------------
// POST /api/traces/upload — upload a raw agent trace for forensic analysis.
//
// Accepts EITHER:
//   1. multipart/form-data with a `file` field (a .json trace file), plus
//      optional `projectId` form field.
//   2. application/json, where the body is one of:
//        a) the raw trace object itself, or
//        b) a wrapper { trace, projectId? }.
//
// Identity always comes from the signed-in cookie session. A supplied
// projectId is accepted only when that project belongs to the signed-in user.
//
// The route is a thin adapter: it parses the request and delegates ALL
// validation, size limits, and persistence to uploadTrace(). Typed
// TraceUploadError instances are mapped to their HTTP status; everything else
// becomes a generic 500 (never leaking trace content).
// ---------------------------------------------------------------------------

// Allow a little headroom over the trace byte limit for multipart envelopes.
export const maxDuration = 30;

interface ParsedRequest {
  trace: unknown;
  projectId?: string;
  fileInfo?: TraceFileInfo;
}

/** Parse a JSON string, raising a 400-style error on malformed input. */
function parseJsonOrThrow(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new TraceUploadError("Malformed JSON payload.", "INVALID_JSON", 400);
  }
}

/**
 * Normalize the incoming request (multipart or JSON) into a common shape.
 * Performs a cheap size pre-check on raw text before parsing to avoid spending
 * work on oversized uploads.
 */
async function parseRequest(req: NextRequest): Promise<ParsedRequest> {
  const contentType = req.headers.get("content-type") || "";

  // --- multipart/form-data: file upload ------------------------------------
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      throw new TraceUploadError(
        "multipart upload requires a 'file' field containing a JSON trace.",
        "MISSING_FILE",
        400,
      );
    }
    // Pre-check size before reading/parsing.
    if (file.size > MAX_TRACE_BYTES) {
      throw new TraceUploadError(
        `Uploaded file is too large (${file.size} bytes). Limit is ${MAX_TRACE_BYTES} bytes.`,
        "TRACE_TOO_LARGE",
        413,
      );
    }

    const text = await file.text();
    const trace = parseJsonOrThrow(text);

    const projectId = form.get("projectId");
    return {
      trace,
      projectId: typeof projectId === "string" ? projectId : undefined,
      fileInfo: {
        originalFilename: file.name || null,
        contentType: file.type || "application/json",
      },
    };
  }

  // --- application/json ----------------------------------------------------
  if (contentType.includes("application/json")) {
    const text = await req.text();
    // Cheap size guard on the raw request body.
    if (Buffer.byteLength(text, "utf8") > MAX_TRACE_BYTES) {
      throw new TraceUploadError(
        `Request body is too large. Limit is ${MAX_TRACE_BYTES} bytes.`,
        "TRACE_TOO_LARGE",
        413,
      );
    }

    const body = parseJsonOrThrow(text);
    if (body !== null && typeof body === "object" && !Array.isArray(body)) {
      const obj = body as Record<string, unknown>;
      // Wrapper form { trace, projectId?, userId? } vs. the raw trace itself.
      // We treat it as a wrapper only when a `trace` key is present.
      if ("trace" in obj) {
        return {
          trace: obj.trace,
          projectId: typeof obj.projectId === "string" ? obj.projectId : undefined,
        };
      }
    }
    // Otherwise the whole body is the trace.
    return { trace: body };
  }

  throw new TraceUploadError(
    "Content-Type must be application/json or multipart/form-data.",
    "UNSUPPORTED_CONTENT_TYPE",
    415,
  );
}

export async function POST(req: NextRequest) {
  try {
    const db = await createClient();
    if (!db) {
      throw new TraceUploadError("M9R is not configured.", "DB_NOT_CONFIGURED", 503);
    }
    const {
      data: { user },
    } = await db.auth.getUser();
    if (!user) {
      return NextResponse.json(
        { error: "Authentication required.", code: "AUTH_REQUIRED" },
        { status: 401 },
      );
    }

    const parsed = await parseRequest(req);
    let projectId = parsed.projectId?.trim();
    if (projectId) {
      const { data: ownedProject, error: ownershipError } = await db
        .from("projects")
        .select("id")
        .eq("id", projectId)
        .eq("owner_id", user.id)
        .is("deleted_at", null)
        .maybeSingle();
      if (ownershipError) {
        throw new TraceUploadError(
          "Could not verify project ownership.",
          "PROJECT_SCOPE_FAILED",
          500,
        );
      }
      if (!ownedProject) {
        throw new TraceUploadError("Project not found.", "PROJECT_NOT_FOUND", 404);
      }
    } else {
      projectId = await resolveActiveOrDefaultProjectId(db, {
        id: user.id,
        email: user.email,
        name: (user.user_metadata?.name as string | undefined) ?? null,
      });
    }

    // Delegate validation + persistence to the service.
    const result = await uploadTrace(parsed.trace, user.id, projectId, parsed.fileInfo);

    return NextResponse.json(
      {
        ok: true,
        trace: {
          id: result.id,
          sessionId: result.sessionId,
          taskSummary: result.taskSummary,
          projectId: result.projectId,
          stepCount: result.stepCount,
          hasTokenUsage: result.hasTokenUsage,
          byteSize: result.byteSize,
          createdAt: result.createdAt,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    // Typed pipeline errors carry their own HTTP status and a safe message.
    if (err instanceof TraceUploadError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    // Anything else: log the message only (never the trace content) and 500.
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Trace upload error:", message);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
