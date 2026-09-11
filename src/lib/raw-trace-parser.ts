/**
 * Raw output parser — OathLock
 * ----------------------------------------------------------------------------
 * Turns messy, unstructured agent/terminal output — including real Claude Code
 * and Cursor markdown transcripts — into the structured trace shape the Blackbox
 * Report engine consumes, with REAL parsing (never invented numbers).
 *
 * What it understands (aggressively):
 *  - Conversation turns: markdown role headers (`## User`, `**Assistant**`,
 *    `### Human`, `Cursor`, `Claude`, …) bound turns and seed the task summary.
 *  - Tool calls in agent-native syntax: `Read(...)`, `Edit(...)`, `Write(...)`,
 *    `Bash(...)`, `Grep(...)`, `RunTerminalCmd(...)`, optionally prefixed by the
 *    `⏺ ● • - *` bullets Claude Code prints.
 *  - Fenced code blocks: ```bash / ```sh / ```console / unlabeled terminal dumps
 *    are scanned for commands + errors; ```ts / ```python / ```json etc. are
 *    treated as opaque content so code is never misread as commands or errors.
 *  - Prose file ops ("Reading src/x.ts", "Edited app/y.tsx"), shell prompts
 *    (`$`, `>`, `#`, `PS>`), inline errors, and model identifiers.
 *
 * Each command / tool call / file op becomes its OWN step, so a real transcript
 * yields many structured steps — which is what surfaces retry spirals, repeated
 * file access, and missing-context patterns downstream.
 *
 * Claim discipline (non-negotiable, mirrors the rest of OathLock):
 *  - We extract only what the text literally shows.
 *  - token_usage and cost are NEVER fabricated — they stay absent, so the report
 *    honestly says "not measurable" rather than guessing.
 *  - If we can't find structure, we return ok:false with guidance instead of a
 *    hollow one-step trace that would produce bullshit findings.
 *
 * Output is plain JSON in the snake_case trace shape, ready for
 * normalizeToTrace() → generateBlackboxReport().
 */

// --- Line-level detectors ---------------------------------------------------

// A path like src/lib/foo.ts, app/page.tsx, ./utils/x.js, or a bare file.ext.
const PATH_RE =
  /(?:\.?\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:tsx?|jsx?|mjs|cjs|css|scss|json|md|mdx|svg|txt|ya?ml|toml|py|rb|go|rs|java|sql|sh|html?|vue|svelte|c|cpp|h|hpp|php|kt|swift|dart|ipynb|env|lock|cfg|ini|xml)\b/g;

// A line that's running a command: an explicit shell prompt, a known tool at the
// start of the line, or a "running: <cmd>" style narration.
const SHELL_PROMPT_RE = /^\s*(?:[$>#]|PS\s*[^>]*>)\s+(.+)$/;
const COMMAND_LEAD_RE =
  /^\s*(npm|npx|pnpm|yarn|bun|deno|git|node|tsc|eslint|prettier|next|vite|webpack|python3?|pip3?|poetry|uv|cargo|go|make|cmake|docker|kubectl|helm|terraform|curl|wget|jest|vitest|pytest|mocha|rake|bundle|rails|composer|gradle|mvn|dotnet|cmd|pwsh)\b.*/i;
const RUNNING_RE = /(?:running|executing|\$\s*run|exec(?:uting)?)[:\s]+[`'"]?([^`'"\n]+)/i;

// File operations expressed in prose ("Reading src/x.ts", "Edited app/y.tsx").
const READ_RE = /\b(?:read(?:ing)?|cat|open(?:ed|ing)?|loaded|viewing|inspect(?:ed|ing)?)\b/i;
const WRITE_RE =
  /\b(?:wr(?:ite|ote|iting)|edit(?:ed|ing)?|creat(?:e|ed|ing)|modif(?:y|ied|ying)|updat(?:e|ed|ing)|patch(?:ed|ing)?|append(?:ed|ing)?|refactor(?:ed|ing)?|delet(?:e|ed|ing)|remov(?:e|ed|ing))\b/i;

// Errors / failures. Conservative enough to avoid matching every "error handler".
const ERROR_RE =
  /\b(?:error|exception|traceback|failed|failure|cannot|can't|not found|ENOENT|EADDRINUSE|undefined is not|is not defined|unexpected|panic|fatal|segfault|assertion|✗|✖|❌)\b/i;

// Step / turn boundaries the agent itself emitted.
const STEP_MARKER_RE = /^\s*(?:#{1,6}\s*)?(?:step|turn|iteration|action)\s*#?\s*\d+/i;

// Model identifiers, for honest model-handoff detection downstream.
const MODEL_RE =
  /\b(gpt-[\w.-]+|gpt-4o|o[134]-?(?:mini|preview)?|claude-[\w.-]+|claude-(?:opus|sonnet|haiku)-[\w.-]+|gemini-[\w.-]+|llama-?[\w.-]+|mistral-[\w.-]+|deepseek-[\w.-]+|grok-[\w.-]+)\b/i;

// Task/objective hints in prose.
const TASK_RE = /^\s*(?:task|objective|goal|prompt|request)[:\s]+(.+)$/i;
const FAILED_COMMANDS_EMPTY_RE =
  /^\s*(?:#{1,6}\s*)?(?:[-*+]\s*)?failed\s+commands?\s*:?\s*(?:none\.?)?\s*$/i;

// Conversation role headers across Claude Code / Cursor / generic md exports.
// Matches "## User", "**Assistant**", "### Human:", "🧑 User", "Cursor", etc.
const ROLE_HEADER_RE =
  /^\s*(?:#{1,6}\s*)?(?:[*_>]+\s*)?(?:[🧑👤🤖💬⏺●]\s*)?(user|human|you|assistant|ai|claude|cursor|copilot|model|system)\b[:*_\s]*$/i;

// Agent-native tool call: optional bullet, a CapitalizedName, then (args).
// Examples: "⏺ Bash(npm test)", "Read(file_path: \"src/x.ts\")", "- Edit(a.ts)".
const TOOL_CALL_RE = /^[\s>*+\-•·⏺●◯○☐⎿└├]*([A-Z][A-Za-z0-9_]+)\(([\s\S]*?)\)?\s*$/;

// Languages whose fenced blocks are terminal-ish (scan for commands + errors).
// Anything else (ts, python, json, …) is treated as opaque code content.
const SHELL_FENCE_LANGS = new Set([
  "", "bash", "sh", "shell", "zsh", "console", "terminal", "shell-session",
  "shellsession", "session", "ps", "ps1", "powershell", "pwsh", "bat", "cmd",
  "text", "output", "log",
]);

// Tool-name → action classification (lowercased lookup).
const READ_TOOLS = new Set(["read", "readfile", "view", "viewfile", "cat", "open", "notebookread"]);
const WRITE_TOOLS = new Set([
  "edit", "multiedit", "write", "writefile", "update", "create", "createfile",
  "apply", "applypatch", "notebookedit", "str_replace", "str_replace_editor",
  "search_replace", "insert", "delete",
]);
const EXEC_TOOLS = new Set([
  "bash", "shell", "run", "exec", "terminal", "runcommand", "runterminalcmd",
  "executecommand", "command",
]);
const SEARCH_TOOLS = new Set([
  "grep", "glob", "search", "find", "ls", "list", "codebase", "codebasesearch",
  "filesearch", "grepsearch", "listdir",
]);

type RawStep = {
  step: number;
  actor: "agent";
  model?: string;
  tool?: string;
  files_read?: string[];
  files_written?: string[];
  shell_commands?: string[];
  errors?: string[];
  retries?: number;
};

function paths(text: string): string[] {
  const m = text.match(PATH_RE);
  return m ? [...new Set(m)] : [];
}

/** Pull a shell command out of a free-text line, or null. */
function commandIn(line: string): string | null {
  const prompt = line.match(SHELL_PROMPT_RE);
  if (prompt) return prompt[1].trim();
  const running = line.match(RUNNING_RE);
  if (running) return running[1].trim();
  if (COMMAND_LEAD_RE.test(line)) return line.trim();
  return null;
}

/**
 * Clean a tool-call argument list down to a usable value: strip a leading
 * `key:` label (file_path:, command:, pattern:) and surrounding quotes/braces.
 */
function cleanArg(args: string): string {
  let a = args.trim();
  // Drop a leading "key:" or "key =" prefix (file_path:, command =, …).
  a = a.replace(/^[A-Za-z_][A-Za-z0-9_]*\s*[:=]\s*/, "");
  // Strip wrapping quotes/backticks/braces.
  a = a.replace(/^[{[("'`]+/, "").replace(/[}\])"'`]+$/, "");
  return a.trim();
}

export interface RawParseResult {
  ok: boolean;
  /** The parsed trace as a plain JSON object (snake_case), or null. */
  trace: Record<string, unknown> | null;
  stepCount: number;
  /** Human, honest summary of what was (or wasn't) extracted. */
  note: string;
}

/**
 * Parse raw agent/terminal output into a trace. Deterministic and side-effect
 * free. Returns ok:false (with guidance) when no structure can be found.
 */
export function parseRawOutput(raw: string): RawParseResult {
  const text = (raw ?? "").trim();
  if (!text) {
    return { ok: false, trace: null, stepCount: 0, note: "Nothing to parse — paste some output first." };
  }

  const lines = text.split(/\r?\n/);
  const steps: RawStep[] = [];
  let current: RawStep | null = null;
  let taskSummary: string | null = null;
  let lastModel: string | undefined;

  // Turn tracking: when the user just spoke and we have no task yet, the next
  // prose line is the best-available task summary.
  let expectTaskNext = false;
  let turns = 0;

  // Fenced-block state.
  let inFence = false;
  let fenceShell = false;

  // Tallies, to describe honestly what we found.
  let nCommands = 0;
  let nReads = 0;
  let nWrites = 0;
  let nErrors = 0;
  let nTools = 0;

  // Each detected action becomes its own step; non-action lines (errors,
  // command output) attach to the most recent step.
  const newStep = (): RawStep => {
    current = { step: steps.length + 1, actor: "agent" };
    if (lastModel) current.model = lastModel;
    steps.push(current);
    return current;
  };
  const attachStep = (): RawStep => current ?? newStep();

  const addError = (step: RawStep, line: string) => {
    step.errors = [...(step.errors ?? []), line.trim()];
    nErrors += 1;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    if (FAILED_COMMANDS_EMPTY_RE.test(line)) continue;

    // --- Fenced code blocks ------------------------------------------------
    const fence = line.match(/^\s*```+\s*([A-Za-z0-9_-]*)/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceShell = SHELL_FENCE_LANGS.has(fence[1].toLowerCase());
      } else {
        inFence = false;
        fenceShell = false;
      }
      continue;
    }

    if (inFence) {
      // Opaque code content (ts/py/json/…): never parse as commands or errors.
      if (!fenceShell) continue;
      // Terminal-ish block: extract commands and errors only.
      const cmd = commandIn(line);
      if (cmd) {
        const step = newStep();
        step.shell_commands = [cmd];
        nCommands += 1;
        if (ERROR_RE.test(line)) addError(step, line);
        continue;
      }
      if (ERROR_RE.test(line)) addError(attachStep(), line);
      continue;
    }

    // --- Conversation turn boundaries --------------------------------------
    if (ROLE_HEADER_RE.test(line)) {
      turns += 1;
      const role = line.match(ROLE_HEADER_RE)![1].toLowerCase();
      const isUser = role === "user" || role === "human" || role === "you";
      expectTaskNext = isUser && !taskSummary;
      // A new turn closes the current step group.
      current = null;
      continue;
    }

    // Capture the task: explicit marker wins; otherwise first user prose line.
    if (!taskSummary) {
      const t = line.match(TASK_RE);
      if (t) {
        taskSummary = t[1].trim();
        expectTaskNext = false;
      } else if (expectTaskNext && line.trim().length > 3) {
        taskSummary = stripMd(line);
        expectTaskNext = false;
      }
    }

    // Track the most recent model mention; attach to the open step.
    const model = line.match(MODEL_RE)?.[1];
    if (model) {
      lastModel = model;
      const open = steps[steps.length - 1];
      if (open && !open.model) open.model = model;
    }

    // --- Agent-native tool calls: Read(...) / Bash(...) / Edit(...) ---------
    const toolMatch = line.match(TOOL_CALL_RE);
    if (toolMatch && !commandIn(line)) {
      const name = toolMatch[1];
      const key = name.toLowerCase();
      const arg = cleanArg(toolMatch[2] ?? "");

      if (EXEC_TOOLS.has(key)) {
        const step = newStep();
        step.tool = name;
        if (arg) step.shell_commands = [arg];
        nCommands += 1;
        if (ERROR_RE.test(line)) addError(step, line);
        continue;
      }
      if (WRITE_TOOLS.has(key)) {
        const step = newStep();
        step.tool = name;
        const found = paths(arg);
        step.files_written = found.length ? found : arg ? [arg] : [];
        if (step.files_written.length) nWrites += 1;
        continue;
      }
      if (READ_TOOLS.has(key)) {
        const step = newStep();
        step.tool = name;
        const found = paths(arg);
        step.files_read = found.length ? found : arg ? [arg] : [];
        if (step.files_read.length) nReads += 1;
        continue;
      }
      if (SEARCH_TOOLS.has(key)) {
        const step = newStep();
        step.tool = name;
        nTools += 1;
        continue;
      }
      // Unknown but tool-shaped (Task(...), WebFetch(...), etc.) — record it.
      const step = newStep();
      step.tool = name;
      nTools += 1;
      continue;
    }

    // --- Explicit step markers ("Step 3", "## Action 2") -------------------
    if (STEP_MARKER_RE.test(line)) {
      newStep();
      continue;
    }

    // --- Free-text shell commands ------------------------------------------
    const cmd = commandIn(line);
    if (cmd) {
      const step = newStep();
      step.shell_commands = [cmd];
      nCommands += 1;
      if (ERROR_RE.test(line)) addError(step, line);
      continue;
    }

    // --- Prose file operations (write checked first; "edited" beats "read") -
    const filePaths = paths(line);
    if (filePaths.length && WRITE_RE.test(line)) {
      const step = newStep();
      step.files_written = filePaths;
      nWrites += 1;
      if (ERROR_RE.test(line)) addError(step, line);
      continue;
    }
    if (filePaths.length && READ_RE.test(line)) {
      const step = newStep();
      step.files_read = filePaths;
      nReads += 1;
      continue;
    }

    // --- Standalone errors attach to the current step ----------------------
    if (ERROR_RE.test(line)) {
      addError(attachStep(), line);
      continue;
    }
  }

  const signalCount = nCommands + nReads + nWrites + nErrors + nTools;
  if (steps.length === 0 || signalCount === 0) {
    return {
      ok: false,
      trace: null,
      stepCount: 0,
      note:
        "Couldn't find commands, tool calls, file operations, or errors to structure. " +
        "Paste a Claude Code / Cursor transcript, raw terminal output, or structured trace JSON.",
    };
  }

  // Derive per-step retry counts: a step whose command repeats an earlier
  // FAILING command is a retry. Conservative and evidence-based.
  annotateRetries(steps);

  const trace = {
    schema: "oathlock.trace.v0",
    variant: "messy",
    provenance: "Parsed from raw agent/terminal output (no measured token/cost data).",
    session_id: `raw_${Date.now().toString(36)}`,
    task_summary: taskSummary ?? "Imported from raw output",
    actors_observed: ["agent"],
    steps,
    totals: {
      steps: steps.length,
      failed_commands: steps.filter((s) => (s.errors?.length ?? 0) > 0).length,
      retries: steps.reduce((a, s) => a + (s.retries ?? 0), 0),
    },
    // Honest, explicit: raw text never carries token/cost receipts.
    missing_metadata_global: [
      "token_usage not present in raw text (cannot be measured)",
      "estimated_cost_usd not derivable without token receipts",
    ],
  };

  const parts: string[] = [];
  if (nTools) parts.push(`${nTools} tool call${nTools === 1 ? "" : "s"}`);
  if (nCommands) parts.push(`${nCommands} command${nCommands === 1 ? "" : "s"}`);
  if (nReads) parts.push(`${nReads} file read${nReads === 1 ? "" : "s"}`);
  if (nWrites) parts.push(`${nWrites} edit${nWrites === 1 ? "" : "s"}`);
  if (nErrors) parts.push(`${nErrors} error${nErrors === 1 ? "" : "s"}`);
  const turnNote = turns > 0 ? ` across ${turns} conversation turn${turns === 1 ? "" : "s"}` : "";

  return {
    ok: true,
    trace,
    stepCount: steps.length,
    note: `Parsed ${steps.length} steps${turnNote} (${parts.join(", ")}). No token/cost data in raw text.`,
  };
}

/** Strip leading markdown decoration from a captured prose line. */
function stripMd(line: string): string {
  return line
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(/^\s*[*_>\-•·]+\s*/, "")
    .replace(/\*\*/g, "")
    .trim();
}

/** Mark a step as a retry when it repeats an earlier step's failing command. */
function annotateRetries(steps: RawStep[]): void {
  const failedCommands = new Set<string>();
  for (const step of steps) {
    const failed = (step.errors?.length ?? 0) > 0;
    for (const cmd of step.shell_commands ?? []) {
      const key = cmd.trim().toLowerCase();
      if (failedCommands.has(key)) {
        step.retries = (step.retries ?? 0) + 1;
      }
      if (failed) failedCommands.add(key);
    }
  }
}
