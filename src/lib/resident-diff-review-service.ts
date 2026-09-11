import { createClient } from "@/lib/supabase/server";
import { AgentJoinError } from "@/lib/agent-join-service";

export async function decideResidentDiffReview(id: string, payload: unknown) {
  const decision = payload && typeof payload === "object" ? (payload as Record<string, unknown>).decision : null;
  if (decision !== "approved" && decision !== "rejected") throw new AgentJoinError("Decision must be approved or rejected.", "BAD_DIFF_DECISION", 400);
  const db = await createClient();
  if (!db) throw new AgentJoinError("M9R is not configured.", "DB_NOT_CONFIGURED", 503);
  const { data: { user } } = await db.auth.getUser();
  if (!user) throw new AgentJoinError("Authentication required.", "AUTH_REQUIRED", 401);
  const { data, error } = await db.rpc("decide_launch_diff_review", {
    p_review_id: id,
    p_decision: decision,
    p_decided_at: new Date().toISOString(),
  });
  const review = Array.isArray(data) ? data[0] : null;
  if (error || !review) throw new AgentJoinError("Pending diff review was not found.", "DIFF_REVIEW_NOT_FOUND", 404);
  return review;
}
