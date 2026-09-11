export const RESULT_ADOPTION_DECISIONS = ["adopted", "rejected", "challenged"] as const;
export type ResultAdoptionDecision = (typeof RESULT_ADOPTION_DECISIONS)[number];

export interface ResultAdoption {
  decision: ResultAdoptionDecision;
  rationale: string;
  planEffect: string;
}

function text(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 && normalized.length <= maximum ? normalized : null;
}

export function validateResultAdoption(input: unknown): { ok: boolean; adoption: ResultAdoption | null; reason: string | null } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, adoption: null, reason: "invalid_input" };
  const row = input as Record<string, unknown>;
  const decision = typeof row.decision === "string" && RESULT_ADOPTION_DECISIONS.includes(row.decision as ResultAdoptionDecision)
    ? row.decision as ResultAdoptionDecision : null;
  const rationale = text(row.rationale, 1_000);
  const planEffect = text(row.planEffect, 1_000);
  if (!decision || !rationale || !planEffect) return { ok: false, adoption: null, reason: "invalid_adoption" };
  return { ok: true, adoption: { decision, rationale, planEffect }, reason: null };
}
