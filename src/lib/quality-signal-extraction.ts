/**
 * Quality Signal Extraction — OathLock
 * ----------------------------------------------------------------------------
 * Pulls OBJECTIVE, measurable proof signals out of a redacted session markdown /
 * text export, without overclaiming. This is what lets `submit-session` print a
 * measurability block and `compare` recognise that the later run actually carried
 * verification evidence (tests / build / lint / human review).
 *
 * Claim discipline (non-negotiable):
 *  - A test/build/lint result is only "objective" when it is clearly tied to a
 *    command (a `Command:` line or a recognizable test/build/lint invocation in
 *    the same section). A bare "passed" with no command is ignored.
 *  - Agent self-claims ("Loaded rule status reported by agent: followed",
 *    "the rule appears followed") are NEVER objective proof — they are about the
 *    agent's behaviour, not about the output of a verifiable command, so they do
 *    not set any signal here.
 *  - "No commit was performed" / "Human approval: pending" are recorded honestly
 *    (false / unset), never inflated into a positive signal.
 *
 * Pure module: deterministic, no IO. Operates on already-redacted text.
 */

export type PassFail = "passed" | "failed";
export interface VerificationProvenance {
  kind: "test" | "lint" | "build";
  command: string;
  result: PassFail;
  source: "command_tied";
}

/** Raw, literal signals extracted from the session text. */
export interface ExtractedQualitySignals {
  verification: VerificationProvenance[];
  /** Distinct changed/edited files explicitly listed in the evidence. */
  changedFiles: string[];
  focusedTestCommand: string | null;
  focusedTestResult: PassFail | null;
  fullTestCommand: string | null;
  fullTestResult: PassFail | null;
  lintResult: PassFail | null;
  buildResult: PassFail | null;
  /** Count of explicit non-empty entries under "Failed commands". Raw command text is not exposed. */
  failedCommandCount: number;
  /** True only when the evidence explicitly says the failed-command list is empty. */
  failedCommandsExplicitNone: boolean;
  /** True only when the text states a human reviewed/approved the diff. */
  humanReviewed: boolean | null;
  /** True/false only when the text explicitly states whether a commit happened. */
  commitPerformed: boolean | null;
}

/**
 * The compact, human-facing measurability block printed by `submit-session`.
 * Strings are display-ready ("focused passed, full passed" / "not supplied").
 */
export interface MeasurabilitySummary {
  changedFiles: number;
  tests: string;
  build: string;
  lint: string;
  humanApproval: string;
  /** True when ANY objective signal was extracted (gates whether to print). */
  hasObjectiveSignals: boolean;
}

// A file path with a real extension, used to validate "changed file" bullets.
const FILE_PATH_RE =
  /(?:\.?\/?[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:tsx?|jsx?|mjs|cjs|css|scss|json|md|mdx|svg|txt|ya?ml|toml|py|rb|go|rs|java|sql|sh|html?|vue|svelte|c|cpp|h|hpp|php|kt|swift|dart|ipynb|env|lock|cfg|ini|xml)\b/;

// Section headers that scope test/build/lint results.
const FOCUSED_HEADER_RE = /focused\s+(?:test|verification)/i;
const FULL_HEADER_RE = /\b(?:full\s+test|final\s+verification|full\s+verification|whole\s+suite)\b/i;
const LINT_HEADER_RE = /^\s*#{0,6}\s*lint\b/i;
const BUILD_HEADER_RE = /^\s*#{0,6}\s*build\b/i;
const VERIFICATION_HEADER_RE = /^\s*#{0,6}\s*verification\s+(?:commands?|results?)\b\s*:?\s*$/i;
const RESULTS_HEADER_RE = /^\s*#{0,6}\s*results\b\s*:?\s*$/i;
const FAILED_COMMANDS_HEADER_RE = /^\s*#{0,6}\s*failed\s+commands?\b\s*:?\s*$/i;
const FAILED_COMMANDS_INLINE_RE = /^\s*#{0,6}\s*failed\s+commands?\s*:\s*(\S.*)$/i;

// "Changed file(s):" / "Files Touched" / "Files changed/edited" headers.
const CHANGED_FILES_HEADER_RE =
  /^\s*#{0,6}\s*(?:changed\s+files?|files?\s+(?:touched|changed|edited|modified))\b\s*:?\s*$/i;

// A markdown header line (resets the active section when it isn't a known one).
const ANY_HEADER_RE = /^\s*#{1,6}\s+\S/;

// Commands that, on their own, identify a focused vs full test run.
const FULL_TEST_CMD_RE = /\bnpm\s+(?:run\s+)?test\b|\byarn\s+test\b|\bpnpm\s+test\b/i;
const FOCUSED_TEST_CMD_RE = /--test\b|\b(?:vitest|jest|mocha|pytest)\b.*\b[\w./-]+\.(?:test|spec)\./i;
const TEST_CMD_RE = /\b(?:test|tests|vitest|jest|mocha|pytest|--test)\b/i;
const LINT_CMD_RE = /\b(?:lint|eslint|prettier|biome)\b/i;
const BUILD_CMD_RE = /\b(?:build|tsc|next\s+build|webpack|vite\s+build)\b/i;
const COMMAND_START_RE =
  /^(?:npm|npx|pnpm|yarn|bun|deno|node|tsc|eslint|next|vitest|jest|pytest|mocha)\b/i;

/** Classify a "passed"/"failed"-style result phrase. Null when unclear. */
function classifyResult(value: string): PassFail | null {
  const v = value.toLowerCase();
  // A nonzero failure count, a leading "failed", or a failure glyph → failed.
  if (
    /^[\s.\-:]*fail/.test(v) ||
    /[1-9]\d*\s*(?:tests?\s*)?failed/.test(v) ||
    /\b(?:exited?|exit)\s+(?:with\s+)?(?:code\s+)?[1-9]\d*\b/.test(v) ||
    /\bnon[-\s]?zero\b/.test(v) ||
    /\b[1-9]\d*\s+errors?\b/.test(v) ||
    /\berror\b/.test(v) ||
    /[✗✖❌]/.test(value)
  ) {
    return "failed";
  }
  if (
    /\bpass(?:ed)?\b/.test(v) ||
    /\b(?:exited?|exit)\s+(?:with\s+)?(?:code\s+)?0\b/.test(v) ||
    /\b0\s*(?:failed|errors?)\b/.test(v) ||
    /\ball\s+(?:tests?\s+)?pass/.test(v)
  ) {
    return "passed";
  }
  return null;
}

/** Strip surrounding markdown/quote decoration from a captured value. */
function clean(value: string): string {
  return value
    .replace(/^[\s>*_`-]+/, "")
    .replace(/[`*_]+$/, "")
    .trim();
}

type Section = "focused" | "full" | "lint" | "build" | null;

/**
 * Extract literal objective signals from session text. Conservative: a result is
 * only attached to a category when a command is present in (or implied by) the
 * same section, so prose never masquerades as verification.
 */
export function extractQualitySignals(sessionText: string): ExtractedQualitySignals {
  const out: ExtractedQualitySignals = {
    verification: [],
    changedFiles: [],
    focusedTestCommand: null,
    focusedTestResult: null,
    fullTestCommand: null,
    fullTestResult: null,
    lintResult: null,
    buildResult: null,
    failedCommandCount: 0,
    failedCommandsExplicitNone: false,
    humanReviewed: null,
    commitPerformed: null,
  };

  const lines = (sessionText ?? "").split(/\r?\n/);
  const changed = new Set<string>();

  let section: Section = null;
  // When we just saw a bare "Command:" / "Result:" label, the value is on the
  // next non-empty line; remember which section it belongs to.
  let pendingCommand: Section = null;
  let pendingResult: Section = null;
  let pendingHumanApproval = false;
  let collectingChangedFiles = false;
  let collectingFailedCommands = false;
  // Whether a command was seen in the current section (gates objective results).
  const sawCommand: Record<Exclude<Section, null>, boolean> = {
    focused: false,
    full: false,
    lint: false,
    build: false,
  };

  const recordCommand = (sec: Exclude<Section, null>, cmd: string) => {
    sawCommand[sec] = true;
    if (sec === "focused" && !out.focusedTestCommand) out.focusedTestCommand = cmd;
    if (sec === "full" && !out.fullTestCommand) out.fullTestCommand = cmd;
  };

  const recordResult = (sec: Exclude<Section, null>, value: string) => {
    const verdict = classifyResult(value);
    if (!verdict) return;
    // Only objective when a command anchored the section.
    if (!sawCommand[sec]) return;
    if (sec === "focused" && out.focusedTestResult == null) out.focusedTestResult = verdict;
    if (sec === "full" && out.fullTestResult == null) out.fullTestResult = verdict;
    if (sec === "lint" && out.lintResult == null) out.lintResult = verdict;
    if (sec === "build" && out.buildResult == null) out.buildResult = verdict;
  };

  const sectionsForCommand = (cmd: string): Array<Exclude<Section, null>> => {
    const sections: Array<Exclude<Section, null>> = [];
    if (LINT_CMD_RE.test(cmd)) sections.push("lint");
    if (BUILD_CMD_RE.test(cmd)) sections.push("build");
    if (TEST_CMD_RE.test(cmd)) {
      sections.push(FULL_TEST_CMD_RE.test(cmd) ? "full" : "focused");
    }
    return sections;
  };

  const recordCommandOutcome = (cmd: string, resultText: string, forceFailed = false): boolean => {
    const command = clean(cmd).replace(/`/g, "");
    if (!COMMAND_START_RE.test(command)) return false;
    const sections = sectionsForCommand(command);
    if (sections.length === 0) return false;
    const result = forceFailed ? "failed" : classifyResult(resultText);
    if (!result) return false;
    for (const sec of sections) {
      recordCommand(sec, command);
      recordResult(sec, result);
      const kind = sec === "focused" || sec === "full" ? "test" : sec;
      if (!out.verification.some((item) => item.kind === kind && item.command === command && item.result === result)) {
        out.verification.push({ kind, command: command.slice(0, 500), result, source: "command_tied" });
      }
    }
    return true;
  };

  const isNoFailedCommandsValue = (value: string): boolean =>
    /^(?:none|none\.|no\s+failed\s+commands?|no\s+failures?)$/i.test(clean(value).replace(/[.!]+$/, ""));

  const handleFailedCommandValue = (value: string): void => {
    const cleaned = clean(value).replace(/`/g, "");
    if (!cleaned) return;
    if (isNoFailedCommandsValue(cleaned)) {
      out.failedCommandsExplicitNone = true;
      return;
    }
    out.failedCommandCount += 1;
    recordCommandOutcome(cleaned, cleaned, true);
  };

  const parseInlineCommandOutcome = (value: string): boolean => {
    const item = clean(value).replace(/`/g, "");
    if (!COMMAND_START_RE.test(item)) return false;

    const colonMatch = item.match(/^([^:]+?)\s*:\s*(\S.*)$/);
    if (colonMatch) {
      return recordCommandOutcome(colonMatch[1], colonMatch[2]);
    }

    const exitMatch = item.match(/^(.+?)\s+(?:exited?|exit)\s+(?:with\s+)?(?:code\s+)?([0-9]+)\b/i);
    if (exitMatch) {
      return recordCommandOutcome(exitMatch[1], `exited ${exitMatch[2]}`);
    }

    return false;
  };

  for (const raw of lines) {
    const line = raw.trim();

    // --- Changed-files block -------------------------------------------------
    if (CHANGED_FILES_HEADER_RE.test(line) || /^\s*changed\s+files?\s*:/i.test(line)) {
      collectingChangedFiles = true;
      // Inline form: "Changed file: src/x.ts"
      const inline = line.split(":").slice(1).join(":").trim();
      if (inline) {
        const m = inline.match(FILE_PATH_RE);
        if (m) changed.add(m[0]);
      }
      continue;
    }
    if (collectingChangedFiles) {
      const bullet = line.match(/^[-*+]\s+(.+)$/);
      if (bullet) {
        const m = bullet[1].match(FILE_PATH_RE);
        if (m) changed.add(m[0]);
        continue;
      }
      if (line === "") continue; // tolerate blank lines within the block
      collectingChangedFiles = false; // any other content ends the block
    }

    // --- Failed-command block ----------------------------------------------
    const failedInline = line.match(FAILED_COMMANDS_INLINE_RE);
    if (failedInline) {
      collectingFailedCommands = true;
      handleFailedCommandValue(failedInline[1]);
      continue;
    }
    if (FAILED_COMMANDS_HEADER_RE.test(line)) {
      collectingFailedCommands = true;
      continue;
    }
    if (collectingFailedCommands) {
      const bullet = line.match(/^[-*+]\s+(.+)$/);
      if (bullet) {
        handleFailedCommandValue(bullet[1]);
        continue;
      }
      if (line === "") continue;
      collectingFailedCommands = false;
    }

    // --- Inline lint / build results (checked before headers so a line like
    // "Lint result: passed" is read as a result, not a bare section header) ----
    const lintInlineEarly = line.match(/^\s*lint(?:\s+result)?\s*:\s*(\S.*)$/i);
    if (lintInlineEarly) {
      continue;
    }
    const buildInlineEarly = line.match(/^\s*build(?:\s+result)?\s*:\s*(\S.*)$/i);
    if (buildInlineEarly) {
      continue;
    }

    // --- Inline command outcomes -------------------------------------------
    if (parseInlineCommandOutcome(line)) {
      continue;
    }

    // --- Section headers -----------------------------------------------------
    if (FOCUSED_HEADER_RE.test(line)) {
      section = "focused";
      pendingCommand = pendingResult = null;
      continue;
    }
    if (FULL_HEADER_RE.test(line)) {
      section = "full";
      pendingCommand = pendingResult = null;
      continue;
    }
    if (LINT_HEADER_RE.test(line)) {
      section = "lint";
      pendingCommand = pendingResult = null;
      continue;
    }
    if (BUILD_HEADER_RE.test(line)) {
      section = "build";
      pendingCommand = pendingResult = null;
      continue;
    }
    if (VERIFICATION_HEADER_RE.test(line) || RESULTS_HEADER_RE.test(line)) {
      section = null;
      pendingCommand = pendingResult = null;
      continue;
    }
    // An unrelated markdown header closes the active section.
    if (ANY_HEADER_RE.test(line)) {
      section = null;
      pendingCommand = pendingResult = null;
    }

    // --- Pending value resolution (label was on its own line) ----------------
    if (line === "") continue;
    if (pendingHumanApproval) {
      const value = line.toLowerCase();
      if (/\b(?:yes|true|supplied|approved|accepted|granted|met|done|confirmed)\b/.test(value)) {
        out.humanReviewed = true;
      } else if (/\b(?:no|false|pending|awaiting|not\b)\b/.test(value)) {
        out.humanReviewed = false;
      }
      pendingHumanApproval = false;
      continue;
    }
    if (pendingCommand) {
      recordCommand(pendingCommand, clean(line));
      pendingCommand = null;
      continue;
    }
    if (pendingResult) {
      recordResult(pendingResult, clean(line));
      pendingResult = null;
      continue;
    }

    // --- Command lines -------------------------------------------------------
    const cmdLabel = line.match(/^command\s*:?\s*(.*)$/i);
    if (cmdLabel && section) {
      const value = clean(cmdLabel[1]);
      if (value) recordCommand(section, value);
      else pendingCommand = section;
      continue;
    }
    // A recognizable test/build/lint command anchors its section even without a
    // "Command:" label (e.g. a bare `npm test` or `node --test ...`).
    if (section && (TEST_CMD_RE.test(line) || LINT_CMD_RE.test(line) || BUILD_CMD_RE.test(line))) {
      if (FULL_TEST_CMD_RE.test(line) && section === "full") recordCommand("full", clean(line));
      else if (FOCUSED_TEST_CMD_RE.test(line) && section === "focused") recordCommand("focused", clean(line));
      else recordCommand(section, clean(line));
    }

    // --- Result lines --------------------------------------------------------
    const resLabel = line.match(/^result\s*:?\s*(.*)$/i);
    if (resLabel && section) {
      const value = clean(resLabel[1]);
      if (value) recordResult(section, value);
      else pendingResult = section;
      continue;
    }

    // --- Human review / approval --------------------------------------------
    const humanMatch = line.match(/\bhuman\s*(?:-|\s)?\s*(?:review(?:ed|er)?|approv(?:al|ed|e))\b\s*:?\s*(.*)$/i);
    if (humanMatch && out.humanReviewed == null) {
      const rest = humanMatch[1].toLowerCase();
      if (/\b(?:yes|true|supplied|approved|accepted|granted|met|done|confirmed)\b/.test(rest)) {
        out.humanReviewed = true;
      } else if (/\b(?:no|false|pending|awaiting|not\b)\b/.test(rest)) {
        out.humanReviewed = false;
      } else if (!rest.trim()) {
        pendingHumanApproval = true;
      }
      // Ambiguous ("Human approval:") leaves it unset rather than guessing.
    }

    // --- Commit performed ----------------------------------------------------
    if (out.commitPerformed == null) {
      if (/\bno\s+commit(?:\s+or\s+push)?\b.*\bperform/i.test(line) || /\bno\s+commit\b/i.test(line)) {
        out.commitPerformed = false;
      } else if (/\b(?:commit performed|committed|did commit|commit and push|pushed the commit)\b/i.test(line)) {
        out.commitPerformed = true;
      }
    }
  }

  out.changedFiles = [...changed];
  return out;
}

/**
 * Collapse focused/full test results into a single objective tests verdict:
 * - null when no test result was tied to a command
 * - false when any tied test result failed
 * - true when at least one tied test result passed and none failed
 */
export function testsObjectiveVerdict(s: ExtractedQualitySignals): boolean | null {
  const results = [s.focusedTestResult, s.fullTestResult].filter(Boolean) as PassFail[];
  if (results.length === 0) return null;
  if (results.includes("failed")) return false;
  return true;
}

/** Map a pass/fail to a boolean signal (null stays null). */
function pfToBool(v: PassFail | null): boolean | null {
  return v == null ? null : v === "passed";
}

/** The compare-layer QualitySignals shape (kept structurally compatible). */
export interface DerivedQualitySignals {
  testsPassed: boolean | null;
  buildPassed: boolean | null;
  lintPassed: boolean | null;
  humanApproval: boolean | null;
}

/** Derive the conservative compare-layer signals from the literal extraction. */
export function deriveQualitySignals(s: ExtractedQualitySignals): DerivedQualitySignals {
  return {
    testsPassed: testsObjectiveVerdict(s),
    buildPassed: pfToBool(s.buildResult),
    lintPassed: pfToBool(s.lintResult),
    humanApproval: s.humanReviewed === true ? true : s.humanReviewed === false ? false : null,
  };
}

/** True when test/build/lint evidence was tied to an actual command. */
export function hasCommandTiedVerificationSignal(s: ExtractedQualitySignals): boolean {
  return testsObjectiveVerdict(s) != null || s.buildResult != null || s.lintResult != null;
}

/** Build the compact measurability block for `submit-session` output. */
export function buildMeasurabilitySummary(s: ExtractedQualitySignals): MeasurabilitySummary {
  const testParts: string[] = [];
  if (s.focusedTestResult) testParts.push(`focused ${s.focusedTestResult}`);
  if (s.fullTestResult) testParts.push(`full ${s.fullTestResult}`);
  const tests = testParts.length ? testParts.join(", ") : "not supplied";
  const build = s.buildResult ?? "not supplied";
  const lint = s.lintResult ?? "not supplied";
  const humanApproval =
    s.humanReviewed === true ? "supplied" : s.humanReviewed === false ? "not supplied" : "not supplied";

  const hasObjectiveSignals =
    s.changedFiles.length > 0 ||
    s.focusedTestResult != null ||
    s.fullTestResult != null ||
    s.buildResult != null ||
    s.lintResult != null ||
    s.humanReviewed === true;

  return {
    changedFiles: s.changedFiles.length,
    tests,
    build,
    lint,
    humanApproval,
    hasObjectiveSignals,
  };
}
