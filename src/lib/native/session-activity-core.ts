/**
 * What an agent's open session is doing right now, in a few plain words, read from the tail of its own transcript file.
 * No hook is needed: Claude Code and Codex already record every tool call there. Only the verb and a short target (a file
 * name, the start of a command) are shown, never file contents; the feed redacts secrets again before it is written.
 */

const MAX = 90;

const clip = (text: string, max = MAX) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const base = (path: unknown) => (typeof path === "string" && path ? path.split(/[\\/]/).filter(Boolean).pop() ?? "" : "");

function describeClaudeTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Read": return `Reading ${base(input.file_path) || "a file"}`;
    case "Edit": case "MultiEdit": case "Write": case "NotebookEdit": return `Editing ${base(input.file_path ?? input.notebook_path) || "a file"}`;
    case "Bash": case "PowerShell": return `Running ${clip(String(input.command ?? input.description ?? "a command"), 60)}`;
    case "Grep": return `Searching for ${clip(String(input.pattern ?? "text"), 40)}`;
    case "Glob": return "Looking for files";
    case "WebFetch": case "WebSearch": return "Searching the web";
    case "Agent": case "Task": return "Working with a sub-agent";
    case "TodoWrite": return "Planning the next steps";
    default: return name.startsWith("mcp__") ? `Using ${name.split("__").pop()}` : `Using ${name}`;
  }
}

/** Last visible step in the tail of a Claude Code transcript (JSON lines). Null when nothing recognisable is there. */
export function lastClaudeActivity(tailText: string): string | null {
  const lines = tailText.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.includes('"assistant"')) continue;
    try {
      const event = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
      if (event.type !== "assistant" || !Array.isArray(event.message?.content)) continue;
      const parts = event.message.content as Array<{ type?: string; name?: string; input?: Record<string, unknown>; text?: string }>;
      const tool = [...parts].reverse().find((part) => part.type === "tool_use" && typeof part.name === "string");
      if (tool) return describeClaudeTool(tool.name as string, tool.input ?? {});
      if (parts.some((part) => part.type === "text" && part.text?.trim())) return "Writing a reply";
      if (parts.some((part) => part.type === "thinking")) return "Thinking";
    } catch { /* a cut-off first line of the tail */ }
  }
  return null;
}

function describeCodexCall(payload: Record<string, unknown>): string {
  const name = String(payload.name ?? "");
  let args: Record<string, unknown> = {};
  if (typeof payload.arguments === "string") { try { args = JSON.parse(payload.arguments) as Record<string, unknown>; } catch { /* plain-text arguments */ } }
  const command = args.command ?? args.cmd ?? (payload.action as { command?: unknown } | undefined)?.command;
  const text = Array.isArray(command) ? command.join(" ") : typeof command === "string" ? command : "";
  if (text) return `Running ${clip(text.replace(/^(?:powershell|pwsh|bash|cmd)(?:\.exe)?\s+(?:-\w+\s+)*(?:-Command\s+|-c\s+|\/c\s+)?/i, ""), 60)}`;
  if (/patch|edit|write/i.test(name)) return "Editing files";
  return name ? `Using ${name}` : "Working";
}

/** Last visible step in the tail of a Codex rollout file (JSON lines). */
export function lastCodexActivity(tailText: string): string | null {
  const lines = tailText.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.includes('"response_item"')) continue;
    try {
      const payload = (JSON.parse(line) as { type?: string; payload?: Record<string, unknown> }).payload;
      if (!payload) continue;
      const kind = payload.type;
      if (kind === "function_call" || kind === "custom_tool_call" || kind === "local_shell_call") return describeCodexCall(payload);
      if (kind === "reasoning") return "Thinking";
      if (kind === "message" && payload.role === "assistant") return "Writing a reply";
    } catch { /* a cut-off first line of the tail */ }
  }
  return null;
}

/** Where Claude Code keeps one session's transcript: the project folder name is the working folder with symbols turned into dashes. */
export function claudeTranscriptPath(home: string, cwd: string, sessionId: string): string {
  const folder = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return `${home.replace(/[\\/]+$/, "")}/.claude/projects/${folder}/${sessionId}.jsonl`;
}
