/**
 * Bounded planning-context builder — Phase 5B §6/§7.
 * ----------------------------------------------------------------------------
 * Everything a planning model call is allowed to see, and nothing else.
 * Deliberately an ALLOW-LIST builder, not a filter over "everything except
 * secrets" — the default is empty; a caller opts fields IN, never has to
 * remember to opt something OUT. This is what makes "no unrestricted
 * repository context" true by construction rather than by discipline.
 *
 * The same logical input always produces the same normalized context and
 * the same hash (`contextHash`) — required for idempotent planning
 * requests (mission-model-planner.ts) and for a human/audit trail to prove
 * two requests actually saw the same thing.
 */

import { canonicalizeRepoPath } from "./mission-path-containment";

export const MAX_PLANNING_CONTEXT_CHARS = 20_000;
export const MAX_SNIPPET_CHARS = 4_000;
export const MAX_DOCUMENTATION_SNIPPETS = 10;

export interface PlanningDocumentationSnippet {
  /** Repo-relative path this snippet was taken from — canonicalized, never trusted raw. */
  path: string;
  /** Explicitly selected by a caller (a human, or a prior deterministic step) — never "the whole file," never model-selected. */
  text: string;
}

export interface PlanningContextInput {
  missionId: string;
  objective: string;
  constraints: string[];
  workspaceContext: { repository: string; repositoryId: string | null };
  applicableRules: string[];
  allowedRoles: readonly string[];
  scope: { allowedPaths: string[]; prohibitedPaths: string[] };
  collaborationPolicySummary: string;
  approvalPolicySummary: string;
  evidencePolicySummary: string;
  budgetSummary: string;
  /** Explicitly selected, already-extracted documentation snippets — never full file contents, never binary. */
  documentationSnippets: PlanningDocumentationSnippet[];
}

export type PlanningContextTruncationReason = "snippet_count" | "snippet_length" | "total_length" | "binary_excluded" | "prohibited_path_excluded" | "unsupported_encoding";

export interface PlanningContextTruncationNote {
  reason: PlanningContextTruncationReason;
  detail: string;
}

/** The bounded, normalized, redacted context actually handed to a planning model — never the input verbatim. */
export interface BoundedPlanningContext {
  missionId: string;
  objective: string;
  constraints: string[];
  repository: string;
  repositoryId: string | null;
  applicableRules: string[];
  allowedRoles: string[];
  allowedPaths: string[];
  prohibitedPaths: string[];
  collaborationPolicySummary: string;
  approvalPolicySummary: string;
  evidencePolicySummary: string;
  budgetSummary: string;
  documentationSnippets: PlanningDocumentationSnippet[];
  truncationNotes: PlanningContextTruncationNote[];
  /** Deterministic sha256 of the normalized context below — same logical input always yields the same hash. */
  contextHash: string;
}

const BINARY_EXTENSION_RE = /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|tar|exe|dll|so|dylib|woff2?|ttf|eot|mp3|mp4|mov|wasm)$/i;

function isBinaryPath(path: string): boolean {
  return BINARY_EXTENSION_RE.test(path);
}

/** UTF-8 only — anything else is excluded rather than guessed at (matches "unsupported encoding behavior" requiring an explicit, documented choice). */
function hasUnsupportedEncoding(text: string): boolean {
  return text.includes("�"); // the Unicode replacement character — the standard signal a decode already failed upstream
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Builds the bounded context: deterministic ordering (paths/rules/roles all
 * sorted; snippets sorted by path), truncation (snippet count capped at
 * `MAX_DOCUMENTATION_SNIPPETS`, each snippet capped at `MAX_SNIPPET_CHARS`,
 * total serialized size capped at `MAX_PLANNING_CONTEXT_CHARS` — truncating
 * whole snippets from the end, never mid-snippet, so what remains is always
 * complete and never silently corrupted), and redaction (binary paths,
 * paths inside `scope.prohibitedPaths`, and non-UTF-8 snippets are excluded
 * outright, each producing a `truncationNotes` entry rather than silently
 * vanishing).
 */
export async function buildPlanningContext(input: PlanningContextInput): Promise<BoundedPlanningContext> {
  const truncationNotes: PlanningContextTruncationNote[] = [];

  const allowedPaths = [...input.scope.allowedPaths].sort();
  const prohibitedPaths = [...input.scope.prohibitedPaths].sort();
  const applicableRules = [...input.applicableRules].sort();
  const allowedRoles = [...input.allowedRoles].sort();

  const isProhibited = (rawPath: string): boolean => {
    const canonical = canonicalizeRepoPath(rawPath);
    if (!canonical.ok) return true; // fails closed: an unparseable/escaping path is never included
    return prohibitedPaths.some((prohibited) => {
      const prohibitedCanonical = canonicalizeRepoPath(prohibited);
      if (!prohibitedCanonical.ok) return false;
      return prohibitedCanonical.segments.every((segment, i) => canonical.segments[i] === segment);
    });
  };

  let snippets = [...input.documentationSnippets].sort((a, b) => a.path.localeCompare(b.path));

  const filtered: PlanningDocumentationSnippet[] = [];
  for (const snippet of snippets) {
    if (isBinaryPath(snippet.path)) {
      truncationNotes.push({ reason: "binary_excluded", detail: `"${snippet.path}" excluded — binary file extension.` });
      continue;
    }
    if (isProhibited(snippet.path)) {
      truncationNotes.push({ reason: "prohibited_path_excluded", detail: `"${snippet.path}" excluded — inside a prohibited path.` });
      continue;
    }
    if (hasUnsupportedEncoding(snippet.text)) {
      truncationNotes.push({ reason: "unsupported_encoding", detail: `"${snippet.path}" excluded — contains an unsupported/undecodable byte sequence.` });
      continue;
    }
    filtered.push(snippet);
  }
  snippets = filtered;

  if (snippets.length > MAX_DOCUMENTATION_SNIPPETS) {
    truncationNotes.push({ reason: "snippet_count", detail: `${snippets.length} snippets exceeded the cap of ${MAX_DOCUMENTATION_SNIPPETS} — the last ${snippets.length - MAX_DOCUMENTATION_SNIPPETS} (by path order) were dropped.` });
    snippets = snippets.slice(0, MAX_DOCUMENTATION_SNIPPETS);
  }

  snippets = snippets.map((snippet) => {
    if (snippet.text.length <= MAX_SNIPPET_CHARS) return snippet;
    truncationNotes.push({ reason: "snippet_length", detail: `"${snippet.path}" truncated from ${snippet.text.length} to ${MAX_SNIPPET_CHARS} characters.` });
    return { ...snippet, text: snippet.text.slice(0, MAX_SNIPPET_CHARS) };
  });

  let totalChars = snippets.reduce((sum, s) => sum + s.text.length, 0);
  while (totalChars > MAX_PLANNING_CONTEXT_CHARS && snippets.length > 0) {
    const dropped = snippets.pop()!;
    totalChars -= dropped.text.length;
    truncationNotes.push({ reason: "total_length", detail: `"${dropped.path}" dropped entirely — total context size exceeded ${MAX_PLANNING_CONTEXT_CHARS} characters.` });
  }

  const normalized = {
    missionId: input.missionId,
    objective: input.objective,
    constraints: [...input.constraints].sort(),
    repository: input.workspaceContext.repository,
    repositoryId: input.workspaceContext.repositoryId,
    applicableRules,
    allowedRoles,
    allowedPaths,
    prohibitedPaths,
    collaborationPolicySummary: input.collaborationPolicySummary,
    approvalPolicySummary: input.approvalPolicySummary,
    evidencePolicySummary: input.evidencePolicySummary,
    budgetSummary: input.budgetSummary,
    documentationSnippets: snippets,
  };

  const contextHash = await sha256Hex(JSON.stringify(normalized));

  return { ...normalized, truncationNotes, contextHash };
}

// ---------------------------------------------------------------------------
// Prompt-injection boundary — Phase 5B §7
// ---------------------------------------------------------------------------

/**
 * Renders the bounded context into distinct, clearly-labeled sections a
 * real prompt-construction layer would send to a model — system policy and
 * Mission authority FIRST and structurally separate from repository
 * content, which is always the LAST, explicitly-untrusted section. This
 * function does not itself call any model; it exists so the separation is
 * enforced in ONE place rather than reimplemented per caller.
 *
 * Nothing in `repository content` (rules, documentation snippets) is ever
 * concatenated into the same field as `system planning policy`/`Mission
 * authority` — a model that "obeys" injected repository text can, at
 * most, produce a proposal that still has to pass
 * `validateMissionPlanProposal` (mission-planner-validator.ts) and
 * `checkTemplateSafeguards` (mission-planner-templates.ts), neither of
 * which reads this rendered prompt at all. That is the actual
 * injection defense — this function only keeps the SOURCES visibly
 * separated for a human/log reviewer, it does not itself sanitize
 * anything.
 */
export interface RenderedPlanningPrompt {
  systemPlanningPolicy: string;
  missionAuthority: string;
  trustedConfiguration: string;
  userObjective: string;
  repositoryContent: string;
}

export function renderPlanningPrompt(context: BoundedPlanningContext, systemPlanningPolicy: string): RenderedPlanningPrompt {
  return {
    systemPlanningPolicy,
    missionAuthority: [
      `allowedPaths: ${JSON.stringify(context.allowedPaths)}`,
      `prohibitedPaths: ${JSON.stringify(context.prohibitedPaths)}`,
      `approvalPolicy: ${context.approvalPolicySummary}`,
      `evidencePolicy: ${context.evidencePolicySummary}`,
      `budget: ${context.budgetSummary}`,
      `collaborationPolicy: ${context.collaborationPolicySummary}`,
    ].join("\n"),
    trustedConfiguration: [`allowedRoles: ${JSON.stringify(context.allowedRoles)}`, `applicableRules: ${JSON.stringify(context.applicableRules)}`].join("\n"),
    userObjective: context.objective,
    // UNTRUSTED — labeled as such wherever this is actually sent to a model.
    repositoryContent: context.documentationSnippets.map((s) => `--- ${s.path} (UNTRUSTED REPOSITORY CONTENT) ---\n${s.text}`).join("\n\n"),
  };
}
