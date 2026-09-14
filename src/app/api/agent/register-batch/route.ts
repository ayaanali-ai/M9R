import { NextRequest, NextResponse } from "next/server";
import { validateRegisterInput } from "@/lib/agent-join";
import { MAX_BATCH_CLAIMS, registerClaimBatch, AgentJoinError } from "@/lib/agent-join-service";
import { handleAgentError, resolveBaseUrl } from "../_shared";

/**
 * POST /api/agent/register-batch
 *
 * Creates one pending, independently-pollable claim for each provider in a
 * CLI `connect` invocation. The returned batch URL is the only URL a human
 * needs to approve; setup codes remain private to the calling CLI.
 */
export const maxDuration = 15;

export async function POST(req: NextRequest) {
  try {
    if (!(req.headers.get("content-type") || "").includes("application/json")) {
      return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    if (!body || typeof body !== "object" || !Array.isArray((body as { agents?: unknown }).agents)) {
      return NextResponse.json({ error: "agents must be an array." }, { status: 400 });
    }

    const rawAgents = (body as { agents: unknown[] }).agents;
    if (rawAgents.length < 1 || rawAgents.length > MAX_BATCH_CLAIMS) {
      return NextResponse.json({ error: `agents must contain 1-${MAX_BATCH_CLAIMS} providers.` }, { status: 400 });
    }
    const validated = rawAgents.map(validateRegisterInput);
    const invalid = validated.find((result) => !result.ok);
    if (invalid && !invalid.ok) return NextResponse.json({ error: invalid.error }, { status: invalid.status });

    const inputs = validated.map((result) => result.ok ? result.value : null).filter((value): value is NonNullable<typeof value> => value !== null);
    if (new Set(inputs.map((input) => input.agentKind)).size !== inputs.length) {
      return NextResponse.json({ error: "agents must contain each provider kind only once." }, { status: 400 });
    }

    const result = await registerClaimBatch(inputs, resolveBaseUrl(req));
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof AgentJoinError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    return handleAgentError(err);
  }
}
