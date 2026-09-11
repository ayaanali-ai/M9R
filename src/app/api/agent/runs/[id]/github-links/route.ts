import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { requireOwnRun } from "@/lib/agent-run-service";
import { setGithubLinks } from "@/lib/github-link-service";
import { handleAgentError } from "../../../_shared";

// ---------------------------------------------------------------------------
// POST /api/agent/runs/[id]/github-links — declare optional GitHub artifact
// references for a run. Bearer-authenticated, own run only. M9R does
// not verify these against GitHub's API and never claims ownership of them.
// ---------------------------------------------------------------------------

interface GithubLinksBody {
  commit?: unknown;
  branch?: unknown;
  pull_request_url?: unknown;
  ci_url?: unknown;
}

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: runId } = await params;
    const token = bearerFrom(req.headers.get("authorization"));
    if (!token) return jsonError("Bearer token required.", 401);
    const agent = await authenticateAgent(token);
    if (!agent) return jsonError("Invalid or missing agent token.", 401);
    await requireOwnRun(agent, runId);

    const raw = (await req.json().catch(() => null)) as GithubLinksBody | null;
    if (!raw) return jsonError("Invalid JSON body.", 400);

    const result = await setGithubLinks(agent, runId, {
      commit: typeof raw.commit === "string" ? raw.commit : null,
      branch: typeof raw.branch === "string" ? raw.branch : null,
      pullRequestUrl: typeof raw.pull_request_url === "string" ? raw.pull_request_url : null,
      ciUrl: typeof raw.ci_url === "string" ? raw.ci_url : null,
    });
    if (!result.ok) return jsonError(result.errors.join(" ") || "Could not save GitHub links.", 400);
    return NextResponse.json({ ok: true, links: result.links });
  } catch (err) {
    return handleAgentError(err);
  }
}
