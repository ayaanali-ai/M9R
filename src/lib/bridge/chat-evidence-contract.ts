import { redactSession } from "@/lib/session-redaction";
import { SECRET_PATTERNS } from "@/lib/agent-run-core";
import { providerMention } from "@/lib/provider-adapter-config";

export const CHAT_EVIDENCE_SCHEMA_VERSION = "oathlock.chat-evidence.v1" as const;

export interface ChatEvidenceVerification {
  command: string;
  result: string;
}

export interface ChatEvidenceContract {
  schemaVersion: typeof CHAT_EVIDENCE_SCHEMA_VERSION;
  summary: string;
  work: string[];
  files: string[];
  verification: ChatEvidenceVerification[];
  limitations: string[];
}

export type EvidenceApprovalLanguage = "approved" | "rejected" | "unclear";

const MAX_SUMMARY = 500;
const MAX_ITEM = 1_000;
const MAX_FILE = 500;
const MAX_VERIFICATIONS = 16;
const MAX_WORK_ITEMS = 16;
const MAX_FILES = 32;
const MAX_LIMITATIONS = 16;

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 && normalized.length <= max ? normalized : null;
}

function cleanList(value: unknown, maxItems: number, maxItem: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const result = value.map((item) => cleanText(item, maxItem));
  return result.every((item): item is string => Boolean(item)) ? result : null;
}

function containsSecret(value: string): boolean {
  const redaction = redactSession(value);
  // The session redactor's broad high-entropy heuristic intentionally catches
  // long path strings too (for example, a legitimate nested source path).
  // Chat evidence has a separate exact-token check below so ordinary paths do
  // not become false positives while named credentials still fail closed.
  if (Object.entries(redaction.countsByType).some(([type, count]) => type !== "high_entropy" && count > 0)) return true;
  if (/[A-Za-z0-9+_-]{40,}={0,2}/.test(value)) return true;
  return SECRET_PATTERNS.some(([pattern]) => {
    pattern.lastIndex = 0;
    const found = pattern.test(value);
    pattern.lastIndex = 0;
    return found;
  });
}

function issue(errors: string[], message: string): void {
  errors.push(message);
}

export function parseChatEvidenceContract(input: unknown):
  | { ok: true; value: ChatEvidenceContract }
  | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const body = input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null;
  if (!body) return { ok: false, errors: ["Evidence must be a structured object."] };

  if (body.schemaVersion !== CHAT_EVIDENCE_SCHEMA_VERSION) issue(errors, `schemaVersion must be ${CHAT_EVIDENCE_SCHEMA_VERSION}.`);
  const summary = cleanText(body.summary, MAX_SUMMARY);
  if (!summary) issue(errors, "summary is required and must be concise.");
  const work = cleanList(body.work, MAX_WORK_ITEMS, MAX_ITEM);
  if (!work || work.length === 0) issue(errors, "work must contain at least one concrete completed action.");
  const files = cleanList(body.files, MAX_FILES, MAX_FILE);
  if (!files) issue(errors, "files must be a list of paths or links.");
  const limitations = cleanList(body.limitations, MAX_LIMITATIONS, MAX_ITEM);
  if (!limitations) issue(errors, "limitations must be a list, even when empty.");

  const rawVerification = body.verification;
  const verification = Array.isArray(rawVerification) && rawVerification.length > 0 && rawVerification.length <= MAX_VERIFICATIONS
    ? rawVerification.map((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
      const item = entry as Record<string, unknown>;
      const command = cleanText(item.command, MAX_FILE);
      const result = cleanText(item.result, MAX_ITEM);
      return command && result ? { command, result } : null;
    })
    : null;
  if (!verification || verification.some((entry) => entry === null)) issue(errors, "verification must include a command and observed result.");

  const serialized = JSON.stringify(body);
  if (containsSecret(serialized)) issue(errors, "secret-shaped content is not allowed in evidence.");

  if (errors.length > 0) return { ok: false, errors: [...new Set(errors)] };
  return {
    ok: true,
    value: {
      schemaVersion: CHAT_EVIDENCE_SCHEMA_VERSION,
      summary: summary!,
      work: work!,
      files: files!,
      verification: verification as ChatEvidenceVerification[],
      limitations: limitations!,
    },
  };
}

const APPROVAL_PREFIX = /^(yes|y|okay|ok|go ahead|approve|approved|submit|submit evidence)\b/;
const REJECTION_PREFIX = /^(no|nope|not yet|hold off|do not|don't|reject|reject evidence)\b/;

/**
 * Words that may legitimately trail an affirmative without changing it into a
 * qualified answer ("yes, submit the evidence", "ok go ahead please"). Anything
 * outside this set is treated as further instruction, so a qualified negative
 * such as "yes, but don't submit yet" fails closed to "unclear" instead of
 * unlocking a real evidence submission.
 */
const APPROVAL_CONTINUATION = new Set([
  "yes", "y", "yeah", "yep", "okay", "ok", "sure",
  "go", "ahead", "approve", "approved", "approval",
  "submit", "submitted", "send", "ship", "record",
  "the", "this", "that", "it", "is", "are", "you", "your", "my",
  "evidence", "draft", "session", "run", "report",
  "please", "now", "thanks", "thank", "good", "great", "lgtm", "looks", "fine", "all", "set",
]);

function approvalTrailerIsAffirmative(rest: string): boolean {
  // A single @provider mention names which pending request to approve and is a
  // documented, legitimate shape (see evidenceDecisionMention).
  const withoutMention = rest.replace(/@[a-z0-9][a-z0-9-]{0,38}/g, " ");
  const tokens = withoutMention.split(/[^a-z']+/).filter(Boolean);
  return tokens.every((token) => APPROVAL_CONTINUATION.has(token));
}

/** Only unambiguous, human-authored consent can unlock an evidence request. */
export function classifyEvidenceApprovalMessage(body: string): EvidenceApprovalLanguage {
  const normalized = body.replace(/\s+/g, " ").trim().toLowerCase().replace(/[.!]+$/, "");
  if (!normalized) return "unclear";
  // Rejection stays a loose prefix match on purpose: over-matching a rejection
  // only withholds submission, which is the safe default.
  if (REJECTION_PREFIX.test(normalized)) return "rejected";
  const approval = APPROVAL_PREFIX.exec(normalized);
  if (approval) {
    return approvalTrailerIsAffirmative(normalized.slice(approval[0].length)) ? "approved" : "unclear";
  }
  return "unclear";
}

export function classifyEvidenceRequestDecision(input: {
  body: string;
  requestMessageId: string | null;
  parentMessageId: string | null | undefined;
}): EvidenceApprovalLanguage {
  const decision = classifyEvidenceApprovalMessage(input.body);
  const shortApproval = /^(yes|y|okay|ok)$/i.test(input.body.replace(/[.!]+$/, "").trim());
  if (decision === "approved" && shortApproval && input.requestMessageId && input.requestMessageId !== input.parentMessageId) return "unclear";
  return decision;
}

/**
 * A human can direct an explicit evidence decision with one @provider mention
 * (for example, `yes @codex`). This is deliberately narrower than ordinary
 * task mention parsing: multiple targets are ambiguous and remain a normal
 * chat message instead of approving the wrong evidence request.
 */
export function evidenceDecisionMention(body: string): string | null {
  if (classifyEvidenceApprovalMessage(body) === "unclear") return null;
  // Resolved through providerMention() so "@Claude" (the real rebranded
  // label, not "claude-code") matches the stored provider slug exactly the
  // same way the raw slug always has -- same alias used for turn dispatch.
  const mentions = [...body.toLowerCase().matchAll(/@([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)/g)].map((match) => providerMention(match[1]));
  return mentions.length === 1 ? mentions[0] : null;
}

export function renderChatEvidenceMessage(evidence: ChatEvidenceContract): string {
  const lines = [
    "📋 Evidence submitted for final review",
    `Summary: ${evidence.summary}`,
    "Work performed:",
    ...evidence.work.map((item) => `- ${item}`),
    "Files / sources:",
    ...evidence.files.map((file) => `- ${file}`),
    "Verification:",
    ...evidence.verification.map((item) => `- ${item.command} → ${item.result}`),
    "Limitations:",
    ...(evidence.limitations.length > 0 ? evidence.limitations.map((item) => `- ${item}`) : ["- None reported."]),
  ];
  return lines.join("\n");
}
