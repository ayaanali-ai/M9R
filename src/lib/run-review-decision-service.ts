import { redactRunEvent } from "@/lib/agent-run-core";

export const RUN_REVIEW_DECISIONS = ["reviewed", "needs_follow_up", "not_accepted"] as const;
export type RunReviewDecision = (typeof RUN_REVIEW_DECISIONS)[number];

export const REVIEW_DECISION_EVENT_TYPE = "review_decision";
export const MAX_REVIEW_NOTE_LENGTH = 1000;
const MAX_NOTE_PREVIEW_LENGTH = 160;

export interface RunReviewEventPayload {
  decision: RunReviewDecision;
  note_present: boolean;
  note_preview: string | null;
  created_at: string;
}

export interface HumanRunReview {
  decision: RunReviewDecision | null;
  reviewed_at: string | null;
  note_present: boolean;
}

export interface RunReviewEventRow {
  event_type?: string | null;
  message?: string | null;
  created_at?: string | null;
}

const EMPTY_HUMAN_REVIEW: HumanRunReview = {
  decision: null,
  reviewed_at: null,
  note_present: false,
};

const ACTIVE_HTML_RE = /<\s*(script|iframe|object|embed|style|link|meta|form|input|button|svg|img)\b|on[a-z]+\s*=|javascript\s*:/i;

export function emptyHumanRunReview(): HumanRunReview {
  return { ...EMPTY_HUMAN_REVIEW };
}

export function isRunReviewDecision(value: unknown): value is RunReviewDecision {
  return typeof value === "string" && (RUN_REVIEW_DECISIONS as readonly string[]).includes(value);
}

export function containsActiveReviewNotePayload(value: unknown): boolean {
  return typeof value === "string" && ACTIVE_HTML_RE.test(value);
}

function compactNotePreview(note: string | null | undefined): string | null {
  const text = String(note ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  const redacted = redactRunEvent(redactReviewNoteSecrets(text)).replace(/\s+/g, " ").trim();
  if (!redacted) return null;
  return redacted.length > MAX_NOTE_PREVIEW_LENGTH ? redacted.slice(0, MAX_NOTE_PREVIEW_LENGTH - 1) + "…" : redacted;
}

function redactReviewNoteSecrets(value: string): string {
  return value
    .replace(/\b(?:sk-[A-Za-z0-9_-]{6,}|ghp_[A-Za-z0-9_-]{6,}|github_pat_[A-Za-z0-9_-]{6,})\b/g, "[redacted]")
    .replace(/\b(api[_-]?key|authorization|credential|password|secret|token)\s*[:=]\s*("[^"]+"|'[^']+'|[^\s,;]+)/gi, "$1=[redacted]")
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]*/g, "[path]")
    .replace(/\/(?:Users|home)\/[^\s,;]+/g, "[path]");
}

export function buildRunReviewEventPayload(input: {
  decision: unknown;
  note?: string | null;
  createdAt?: string | null;
}): RunReviewEventPayload {
  if (!isRunReviewDecision(input.decision)) {
    throw new Error("Review decision is required.");
  }
  const note = typeof input.note === "string" ? input.note : "";
  if (note.length > MAX_REVIEW_NOTE_LENGTH) {
    throw new Error("Reviewer note is too large.");
  }
  if (containsActiveReviewNotePayload(note)) {
    throw new Error("Active HTML or script content is not allowed.");
  }

  const notePreview = compactNotePreview(note);
  const createdAt = input.createdAt?.trim() || new Date().toISOString();
  return {
    decision: input.decision,
    note_present: note.trim().length > 0,
    note_preview: notePreview,
    created_at: createdAt,
  };
}

export function parseRunReviewEventMessage(message: unknown, eventCreatedAt?: string | null): HumanRunReview | null {
  if (typeof message !== "string" || !message.trim()) return null;
  try {
    const parsed = JSON.parse(message) as Partial<RunReviewEventPayload>;
    if (!isRunReviewDecision(parsed.decision)) return null;
    return {
      decision: parsed.decision,
      reviewed_at: typeof parsed.created_at === "string" && parsed.created_at.trim() ? parsed.created_at : eventCreatedAt ?? null,
      note_present: parsed.note_present === true,
    };
  } catch {
    return null;
  }
}

export function humanReviewFromEvents(events: RunReviewEventRow[] | null | undefined): HumanRunReview {
  const sorted = [...(events ?? [])].sort((a, b) => {
    const at = a.created_at ? new Date(a.created_at).getTime() : 0;
    const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
    return bt - at;
  });

  for (const event of sorted) {
    if (event.event_type !== REVIEW_DECISION_EVENT_TYPE) continue;
    const review = parseRunReviewEventMessage(event.message, event.created_at);
    if (review) return review;
  }
  return emptyHumanRunReview();
}
