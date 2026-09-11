/**
 * Brief — OathLock V2 (referenced by Phase 5's "relevant Finding Briefs")
 * ----------------------------------------------------------------------------
 * A compact relevant-event packet delivered to an agent: the available
 * (human-reviewed) Findings for its workspace, capped and stripped to what
 * fits a small context budget. Pure/IO-free — callers fetch Findings
 * (finding-service.ts) and pass them in.
 *
 * Deliberately simple: exact reuse before semantic reuse (master spec §12).
 * This does no ranking or embedding-based relevance — it returns the most
 * recent available Findings, capped, full stop. Semantic relevance filtering
 * is future work and is not faked here.
 */

import type { FindingView } from "./finding-service";
import type { WorkspaceIdentity } from "./workspace-identity-service";

export interface BriefItem {
  findingId: string;
  title: string;
  applicableEnvironment: string;
  suggestedResponse: string;
  evidenceLevel: string;
}

export interface Brief {
  /** The workspace's own mission statement, human-set, read-only to agents.
   * Null when no human has set one yet -- absence, not a fabricated default. */
  mission: string | null;
  items: BriefItem[];
  /** True when more available Findings exist than fit in this Brief. */
  truncated: boolean;
}

const DEFAULT_MAX_ITEMS = 10;
const MAX_CHARS = 4000;

export function buildBrief(
  findings: FindingView[],
  identity: WorkspaceIdentity | null,
  opts: { maxItems?: number } = {},
): Brief {
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const items: BriefItem[] = [];
  let chars = 0;
  let truncated = false;

  for (const f of findings) {
    if (items.length >= maxItems) {
      truncated = true;
      break;
    }
    const item: BriefItem = {
      findingId: f.id,
      title: f.title,
      applicableEnvironment: f.applicableEnvironment,
      suggestedResponse: f.suggestedResponse,
      evidenceLevel: f.evidenceLevel,
    };
    const itemChars = JSON.stringify(item).length;
    if (chars + itemChars > MAX_CHARS) {
      truncated = true;
      break;
    }
    items.push(item);
    chars += itemChars;
  }

  if (!truncated && findings.length > items.length) truncated = true;

  return { mission: identity?.mission ?? null, items, truncated };
}
