/**
 * Pure workforce-proposal logic for Goals.
 *
 * This is intentionally advisory. It ranks live, workspace-scoped agent
 * connections using declared provider preferences and capabilities, but it
 * never grants authority, creates a participant, or dispatches work. Those
 * decisions stay behind the existing Mission and human-approval boundaries.
 */

export interface WorkforceCandidateInput {
  connectionId: string;
  agentKind: string;
  model: string | null;
  availableModels: string[];
  capabilities: string[];
  lastSeenAt: string | null;
}

export interface RankedWorkforceCandidate {
  connectionId: string;
  agentKind: string;
  model: string | null;
  availableModels: string[];
  capabilities: string[];
  lastSeenAt: string | null;
  score: number;
  providerPreferenceMatch: boolean;
  matchedCapabilities: string[];
  missingCapabilities: string[];
}

export interface GoalWorkforceProposal {
  selectionMode: "advisory";
  humanApprovalRequired: true;
  providerPreferences: string[];
  goalCapabilities: string[];
  candidates: RankedWorkforceCandidate[];
  recommendedConnectionIds: string[];
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueNormalized(values: string[]): string[] {
  return [...new Set(values.map(normalized).filter(Boolean))];
}

function preferenceMatches(candidate: WorkforceCandidateInput, preferences: string[]): boolean {
  if (preferences.length === 0) return true;
  const identifiers = uniqueNormalized([
    candidate.agentKind,
    candidate.model ?? "",
    ...candidate.availableModels,
  ]);
  return preferences.some((preference) => identifiers.includes(normalized(preference)));
}

function preferenceStrength(candidate: WorkforceCandidateInput, preferences: string[]): number {
  if (preferences.length === 0) return 0;
  const provider = normalized(candidate.agentKind);
  const model = normalized(candidate.model ?? "");
  const availableModels = uniqueNormalized(candidate.availableModels);
  if (preferences.some((preference) => normalized(preference) === provider)) return 100;
  if (preferences.some((preference) => normalized(preference) === model || availableModels.includes(normalized(preference)))) return 60;
  return 0;
}

function compareRecency(left: string | null, right: string | null): number {
  const leftMs = left ? Date.parse(left) : 0;
  const rightMs = right ? Date.parse(right) : 0;
  return rightMs - leftMs;
}

/** Rank candidates without mutating the input or making any hosted calls. */
export function buildGoalWorkforceProposal(
  providerPreferences: string[],
  goalCapabilities: string[],
  candidates: WorkforceCandidateInput[],
): GoalWorkforceProposal {
  const normalizedPreferences = uniqueNormalized(providerPreferences);
  const normalizedCapabilities = uniqueNormalized(goalCapabilities);
  const ranked = candidates.map((candidate): RankedWorkforceCandidate => {
    const candidateCapabilities = uniqueNormalized(candidate.capabilities);
    const matchedCapabilities = normalizedCapabilities.filter((capability) => candidateCapabilities.includes(capability));
    const missingCapabilities = normalizedCapabilities.filter((capability) => !candidateCapabilities.includes(capability));
    const providerPreferenceMatch = preferenceMatches(candidate, normalizedPreferences);
    const score = preferenceStrength(candidate, normalizedPreferences) + matchedCapabilities.length * 20;
    return {
      connectionId: candidate.connectionId,
      agentKind: candidate.agentKind,
      model: candidate.model,
      availableModels: candidate.availableModels,
      capabilities: candidateCapabilities,
      lastSeenAt: candidate.lastSeenAt,
      score,
      providerPreferenceMatch,
      matchedCapabilities,
      missingCapabilities,
    };
  });

  ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const recency = compareRecency(left.lastSeenAt, right.lastSeenAt);
    if (recency !== 0) return recency;
    return left.connectionId.localeCompare(right.connectionId);
  });

  return {
    selectionMode: "advisory",
    humanApprovalRequired: true,
    providerPreferences: normalizedPreferences,
    goalCapabilities: normalizedCapabilities,
    candidates: ranked,
    recommendedConnectionIds: ranked
      .filter((candidate) => candidate.providerPreferenceMatch && candidate.missingCapabilities.length === 0 && candidate.score > 0)
      .slice(0, 3)
      .map((candidate) => candidate.connectionId),
  };
}
