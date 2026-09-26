import { createOpenCodeSessionAdapter } from "./opencode-session-core";

export interface OpenCodeCliIo {
  baseUrl: string;
  username?: string;
  password?: string;
  fetch?: typeof fetch;
  out(line: string): void;
  err(line: string): void;
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/** Local-only OpenCode session commands; session selection is always folder-qualified. */
export async function runOpenCodeCli(args: readonly string[], io: OpenCodeCliIo): Promise<number> {
  const command = args[0];
  if (command !== "sessions" && command !== "send") {
    io.err('Usage: m9r-cli opencode sessions | opencode send --folder <absolute-path> --session <id> --text "<message>"');
    return 2;
  }

  let adapter: ReturnType<typeof createOpenCodeSessionAdapter>;
  try {
    adapter = createOpenCodeSessionAdapter({ baseUrl: io.baseUrl, username: io.username, password: io.password, fetch: io.fetch });
  } catch (error) {
    io.err(`OpenCode configuration refused: ${error instanceof Error ? error.message : "invalid configuration"}`);
    return 2;
  }

  try {
    if (command === "sessions") {
      const sessions = await adapter.listSessions();
      for (const session of sessions) io.out(`${session.id}\t${session.projectFolder}${session.title ? `\t${session.title}` : ""}`);
      io.out(`${sessions.length} OpenCode session(s) from ${io.baseUrl}`);
      return 0;
    }

    const projectFolder = flag(args, "--folder");
    const sessionId = flag(args, "--session");
    const text = flag(args, "--text");
    if (!projectFolder || !sessionId || !text) {
      io.err('Usage: m9r-cli opencode send --folder <absolute-path> --session <id> --text "<message>"');
      return 2;
    }
    const session = await adapter.attach({ projectFolder, sessionId });
    await adapter.send({ session, text });
    io.out(`Message sent to OpenCode session ${session.sessionId} in ${session.projectFolder}.`);
    return 0;
  } catch (error) {
    io.err(`OpenCode ${command} failed: ${error instanceof Error ? error.message : "request failed"}`);
    return 1;
  }
}
