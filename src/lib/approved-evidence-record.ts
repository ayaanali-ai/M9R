export interface ApprovedEvidenceSection {
  recorded: boolean;
  items: string[];
}

export interface ApprovedEvidenceRecord {
  what_changed: ApprovedEvidenceSection;
  why: ApprovedEvidenceSection;
  scope_deviations: ApprovedEvidenceSection;
  limitations: ApprovedEvidenceSection;
}

const LABELS = {
  what_changed: ["what changed", "changed files"],
  why: ["why", "why these changes were made"],
  scope_deviations: ["scope deviations", "sensitive areas touched"],
  limitations: ["limitations or unresolved issues", "limitations", "rule conflicts or uncertainty"],
} as const;

type SectionKey = keyof ApprovedEvidenceRecord;

function emptySection(): ApprovedEvidenceSection {
  return { recorded: false, items: [] };
}

function cleanItem(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/^[-*]\s*/, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function sectionForLabel(label: string): SectionKey | null {
  const normalized = label.trim().toLowerCase();
  for (const [key, labels] of Object.entries(LABELS) as Array<[SectionKey, readonly string[]]>) {
    if (labels.includes(normalized)) return key;
  }
  return null;
}

export function extractApprovedEvidenceRecord(text: string): ApprovedEvidenceRecord {
  const record: ApprovedEvidenceRecord = {
    what_changed: emptySection(),
    why: emptySection(),
    scope_deviations: emptySection(),
    limitations: emptySection(),
  };
  let current: SectionKey | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const heading = rawLine.match(/^\s*([^:]{1,80}):\s*(.*)$/);
    if (heading) {
      const matched = sectionForLabel(heading[1]);
      if (matched) {
        current = matched;
        record[current].recorded = true;
        const inline = cleanItem(heading[2]);
        if (inline && !/^(?:none|none identified|n\/a|not applicable)$/i.test(inline)) {
          record[current].items.push(inline);
        }
        continue;
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const item = cleanItem(rawLine);
    if (!item || /^(?:none|none identified|n\/a|not applicable)$/i.test(item)) continue;
    if (record[current].items.length < 20) record[current].items.push(item);
  }

  return record;
}

export function normalizeApprovedEvidenceRecord(value: unknown): ApprovedEvidenceRecord {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const normalize = (key: SectionKey): ApprovedEvidenceSection => {
    const raw = source[key];
    if (!raw || typeof raw !== "object") return emptySection();
    const section = raw as { recorded?: unknown; items?: unknown };
    return {
      recorded: section.recorded === true,
      items: Array.isArray(section.items)
        ? section.items.map((item) => cleanItem(String(item))).filter(Boolean).slice(0, 20)
        : [],
    };
  };
  return {
    what_changed: normalize("what_changed"),
    why: normalize("why"),
    scope_deviations: normalize("scope_deviations"),
    limitations: normalize("limitations"),
  };
}
