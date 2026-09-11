import { DEFAULT_BRIDGE_HOST, DEFAULT_BRIDGE_PORT } from "@/lib/local-terminal-protocol";

export type RuntimeStartResult = "already-running" | "started" | "failed";

export interface RuntimeLauncherDeps {
  probe(url: string): Promise<boolean>;
  spawn(): Promise<void> | void;
  wait(ms: number): Promise<void>;
}

export function runtimeHealthUrl(port = DEFAULT_BRIDGE_PORT): string {
  return `http://${DEFAULT_BRIDGE_HOST}:${port}/health`;
}

/** Idempotently ensure the machine-local PTY runtime is available. */
export async function ensureLocalTerminalRuntime(
  deps: RuntimeLauncherDeps,
  options: { port?: number; attempts?: number; intervalMs?: number } = {},
): Promise<RuntimeStartResult> {
  const url = runtimeHealthUrl(options.port);
  if (await deps.probe(url)) return "already-running";

  try {
    await deps.spawn();
  } catch {
    return "failed";
  }

  const attempts = options.attempts ?? 20;
  const intervalMs = options.intervalMs ?? 100;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await deps.wait(intervalMs);
    if (await deps.probe(url)) return "started";
  }
  return "failed";
}
