import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { requireOwnRun } from "@/lib/agent-run-service";
import { hasOpenSimilarDispatch, publishDispatch } from "@/lib/dispatch-service";
import { validateBoundedRequest, canIssueRequest, type BoundedRequestType } from "@/lib/bounded-assistance";
import { readRunCoordinationState, policyForRun } from "@/lib/bounded-assistance-service";
import { routeAssistanceForAgent } from "@/lib/resident-routing-service";
import { AGENT_KIND_SLUG_PATTERN } from "@/lib/agent-join";
import type { ResidentProvider } from "@/lib/resident-launch-contract";
import { decideCoordinationValue, type CoordinationIntent } from "@/lib/coordination-value-gate";
import { routeAgentTask } from "@/lib/agent-task-routing";
import { handleAgentError } from "../../../_shared";

// ---------------------------------------------------------------------------
// POST /api/agent/runs/[id]/request-help — publish a bounded HELP_REQUESTED
// or CHECK_REQUESTED Dispatch, checked against this run's own coordination
// budget (run-mode.ts) first. Solo (the default) always rejects — a run must
// be started in coordinated/assurance/collaborative mode to request anything.
// ---------------------------------------------------------------------------

interface RequestHelpBody {
  type?: unknown;
  need?: unknown;
  allowed?: unknown;
  not_allowed?: unknown;
  target_connection_id?: unknown;
  preferred_provider?: unknown;
  repository_binding_id?: unknown;
  required_capabilities?: unknown;
  allowed_paths?: unknown;
  prohibited_paths?: unknown;
  max_duration_ms?: unknown;
  max_estimated_tokens?: unknown;
  coordination_intent?: unknown;
  objective_success_criteria?: unknown;
  max_added_latency_ms?: unknown;
}

function jsonError(error: string, status: number, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error, ...extra }, { status });
}

function bounded(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized && normalized.length <= max ? normalized : null;
}

function boundedList(value: unknown, maxItems: number, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const normalized = value.map((item) => bounded(item, maxLength));
  return normalized.every((item): item is string => item !== null) ? [...new Set(normalized)] : null;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: runId } = await params;
    const token = bearerFrom(req.headers.get("authorization"));
    if (!token) return jsonError("Bearer token required.", 401);
    const agent = await authenticateAgent(token);
    if (!agent) return jsonError("Invalid or missing agent token.", 401);

    const run = await requireOwnRun(agent, runId);

    const raw = (await req.json().catch(() => null)) as RequestHelpBody | null;
    if (!raw) return jsonError("Invalid JSON body.", 400);
    if (raw.type !== "HELP_REQUESTED" && raw.type !== "CHECK_REQUESTED") {
      return jsonError('type must be "HELP_REQUESTED" or "CHECK_REQUESTED".', 400);
    }
    const type = raw.type as BoundedRequestType;

    const validated = validateBoundedRequest({
      type,
      need: typeof raw.need === "string" ? raw.need : "",
      allowed: typeof raw.allowed === "string" ? raw.allowed : undefined,
      notAllowed: typeof raw.not_allowed === "string" ? raw.not_allowed : undefined,
    });
    if (!validated.ok) return jsonError(validated.errors.join(" "), 400);

    const state = await readRunCoordinationState(runId, run.workspace_id);
    const policy = policyForRun(state);
    const budget = canIssueRequest(policy, state.usage);
    if (!budget.allowed) {
      return jsonError(budget.reason ?? "Coordination budget exceeded.", 403, { mode: state.mode });
    }

    const routingRequested = [raw.repository_binding_id, raw.target_connection_id, raw.preferred_provider, raw.required_capabilities,
      raw.allowed_paths, raw.prohibited_paths, raw.max_duration_ms, raw.max_estimated_tokens, raw.coordination_intent,
      raw.objective_success_criteria, raw.max_added_latency_ms].some((value) => value !== undefined);
    const repositoryBindingId = routingRequested ? bounded(raw.repository_binding_id, 100) : null;
    if (routingRequested && !repositoryBindingId) return jsonError("Targeted assistance requires repository_binding_id.", 400);
    const targetConnectionId = raw.target_connection_id == null ? null : bounded(raw.target_connection_id, 100);
    if (raw.target_connection_id != null && !targetConnectionId) return jsonError("target_connection_id is invalid.", 400);
    const requestedPreferredProvider = raw.preferred_provider == null ? null
      : typeof raw.preferred_provider === "string" && AGENT_KIND_SLUG_PATTERN.test(raw.preferred_provider)
        ? raw.preferred_provider as ResidentProvider : null;
    if (raw.preferred_provider != null && !requestedPreferredProvider) return jsonError("preferred_provider is invalid.", 400);
    const requiredCapabilities = boundedList(raw.required_capabilities ?? [], 25, 100);
    const allowedPaths = boundedList(raw.allowed_paths, 100, 500);
    const prohibitedPaths = boundedList(raw.prohibited_paths ?? [], 100, 500);
    if (routingRequested && (!requiredCapabilities || !allowedPaths?.length || !prohibitedPaths)) {
      return jsonError("Targeted assistance requires bounded capabilities, allowed_paths, and prohibited_paths.", 400);
    }
    const maxDurationMs = raw.max_duration_ms === undefined ? 10 * 60_000 : raw.max_duration_ms;
    const maxEstimatedTokens = raw.max_estimated_tokens == null ? null : raw.max_estimated_tokens;
    if (typeof maxDurationMs !== "number" || !Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 86_400_000) {
      return jsonError("max_duration_ms is invalid.", 400);
    }
    if (maxEstimatedTokens !== null && (typeof maxEstimatedTokens !== "number" || !Number.isSafeInteger(maxEstimatedTokens) || maxEstimatedTokens < 1 || maxEstimatedTokens > 1_000_000)) {
      return jsonError("max_estimated_tokens is invalid.", 400);
    }
    const coordinationIntent = raw.coordination_intent === "distinct_capability" || raw.coordination_intent === "independent_assurance"
      ? raw.coordination_intent as CoordinationIntent : null;
    const objectiveSuccessCriteria = boundedList(raw.objective_success_criteria, 10, 200);
    const maxAddedLatencyMs = raw.max_added_latency_ms;
    if (routingRequested && !coordinationIntent) return jsonError("Targeted assistance requires a valid coordination_intent.", 400);
    if (routingRequested && (!objectiveSuccessCriteria?.length || objectiveSuccessCriteria.join(" ").length > 200)) {
      return jsonError("Targeted assistance requires bounded objective_success_criteria (200 characters total).", 400);
    }
    if (routingRequested && (typeof maxAddedLatencyMs !== "number" || !Number.isSafeInteger(maxAddedLatencyMs)
      || maxAddedLatencyMs < 1 || maxAddedLatencyMs > 60 * 60_000)) {
      return jsonError("Targeted assistance requires max_added_latency_ms between 1ms and 60m.", 400);
    }
    const taskRoute = routeAgentTask({ task: validated.summary!, paths: allowedPaths ?? [] });
    // A human/primary-agent explicit provider choice wins. The deterministic
    // classifier is a fallback, not authority to silently reroute a requested
    // Codex-to-Claude or Claude-to-Codex handoff.
    const preferredProvider = requestedPreferredProvider ?? taskRoute.providerPreference;
    if (routingRequested) {
      const similarRequestOpen = await hasOpenSimilarDispatch({
        workspaceId: run.workspace_id,
        runId,
        type,
        summary: validated.summary!,
      });
      const policyMaxEstimatedTokens = policy.maxEstimatedTokensPerRequest === null
        ? null
        : Math.min(policy.maxEstimatedTokensPerRequest, taskRoute.maxEstimatedTokens);
      const valueDecision = decideCoordinationValue({
        requestType: type,
        intent: coordinationIntent,
        requiredCapabilities: requiredCapabilities!,
        objectiveSuccessCriteria: objectiveSuccessCriteria!,
        maxEstimatedTokens,
        maxDurationMs,
        maxAddedLatencyMs: maxAddedLatencyMs as number,
        policyMaxEstimatedTokens,
        similarRequestOpen,
      });
      if (valueDecision.delivery !== "coordinate") {
        return jsonError("Coordination value gate kept this run solo.", 422, { reasons: valueDecision.reasons, mode: state.mode });
      }
    }
    const publishResult = await publishDispatch({
      workspaceId: run.workspace_id,
      runId,
      type,
      sender: agent.agentKind ?? "agent",
      summary: validated.summary!,
    });
    if (!publishResult.ok) return jsonError(publishResult.errors.join(" ") || "Could not publish the request.", 400);
    if (!routingRequested) {
      return NextResponse.json({ dispatch_id: publishResult.id, mode: state.mode, routing_status: "unrouted" });
    }
    const routing = await routeAssistanceForAgent(agent, {
      dispatchId: publishResult.id!,
      task: validated.summary!,
      repositoryBindingId: repositoryBindingId!,
      explicitTargetConnectionId: targetConnectionId,
      preferredProvider,
      requiredCapabilities: requiredCapabilities!,
      allowedPaths: allowedPaths!,
      prohibitedPaths: prohibitedPaths!,
      maxDurationMs,
      maxEstimatedTokens,
      maxAddedLatencyMs: maxAddedLatencyMs as number,
      coordinationIntent: coordinationIntent!,
      objectiveSuccessCriteria: objectiveSuccessCriteria!,
      taskClass: taskRoute.taskClass,
      modelTier: taskRoute.modelTier,
      requiresHumanApproval: taskRoute.requiresHumanApproval,
      delegationDepth: state.usage.currentDelegationDepth + 1,
    });
    // The execution grant receives the caller's bounded ceiling. Reflect that
    // effective limit in the response rather than the broader task-route
    // default, otherwise the Watchfloor/CLI can imply more spend than was
    // actually authorized.
    const effectiveTokenCeiling = Math.min(
      maxEstimatedTokens ?? Number.MAX_SAFE_INTEGER,
      policy.maxEstimatedTokensPerRequest ?? Number.MAX_SAFE_INTEGER,
      taskRoute.maxEstimatedTokens,
    );
    return NextResponse.json({
      dispatch_id: publishResult.id,
      mode: state.mode,
      routing_status: routing.status,
      routing,
      task_route: {
        task_class: taskRoute.taskClass,
        model_tier: taskRoute.modelTier,
        provider_preference: preferredProvider,
        max_estimated_tokens: effectiveTokenCeiling,
      },
    });
  } catch (err) {
    return handleAgentError(err);
  }
}
