import process from "node:process";
import * as pty from "node-pty";
import { createTerminalSessionManager, type PtyFactory } from "../src/lib/local-terminal-session-manager";
import { isTerminalProvider, type TerminalProvider } from "../src/lib/local-terminal-protocol";

const provider = (process.argv[2] ?? "codex") as TerminalProvider;
if (!isTerminalProvider(provider)) throw new Error("Provider must be a valid lowercase slug.");

async function main() {
  const ptyFactory: PtyFactory = { spawn: (command, args, options) => pty.spawn(command, [...args], options) };
  const manager = createTerminalSessionManager({ repositoryRoot: process.cwd(), ptyFactory, maxReplayBytes: 16 * 1024 });
  const session = manager.spawn({ provider, cwd: ".", cols: 100, rows: 30 });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { manager.close(session.id); reject(new Error(`${provider} produced no PTY output within 10 seconds.`)); }, 10_000);
    manager.attach(session.id, (event) => {
      if (!event.data) return;
      clearTimeout(timer);
      manager.close(session.id);
      resolve();
    });
  });
  process.stdout.write(`PASS: ${provider} launched inside a real OathLock PTY and produced terminal output.\n`);
  process.exit(0);
}

void main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : error}\n`); process.exitCode = 1; });
