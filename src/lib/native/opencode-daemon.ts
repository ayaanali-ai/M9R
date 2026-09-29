import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

type Child = { on(event: "exit", listener: (code: number | null) => void): unknown; on(event: "error", listener: (error: Error) => void): unknown; kill(): unknown };
type Endpoint = { url: string; password: string };

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("could not reserve OpenCode port")); return; }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

export function createOpenCodeDaemon(options: {
  exe: string;
  cwd: string;
  env: Record<string, string | undefined>;
  spawn?: (exe: string, args: string[], options: { cwd: string; env: Record<string, string | undefined> }) => Child;
  reservePort?: () => Promise<number>;
  healthy?: (url: string, password: string) => Promise<boolean>;
  password?: () => string;
  timeoutMs?: number;
}) {
  const spawn = options.spawn ?? ((exe, args, config) => nodeSpawn(exe, args, { cwd: config.cwd, env: config.env as NodeJS.ProcessEnv, stdio: "ignore", windowsHide: true }) as ChildProcess);
  const healthy = options.healthy ?? (async (url: string, password: string) => {
    try {
      const response = await fetch(`${url}/global/health`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }, signal: AbortSignal.timeout(1000) });
      if (!response.ok) return false;
      const body = await response.json() as { healthy?: unknown };
      return body.healthy === true;
    } catch { return false; }
  });
  let child: Child | null = null;
  let endpoint: Endpoint | null = null;
  let starting: Promise<Endpoint> | null = null;
  let closed = false;

  async function start(): Promise<Endpoint> {
    const port = await (options.reservePort ?? reserveLoopbackPort)();
    if (closed) throw new Error("OpenCode daemon was closed");
    const password = (options.password ?? (() => randomBytes(32).toString("hex")))();
    const url = `http://127.0.0.1:${port}`;
    let exitError: Error | null = null;
    child = spawn(options.exe, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: options.cwd,
      env: { ...options.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: "opencode" },
    });
    const activeChild = child;
    activeChild.on("exit", (code) => {
      exitError = new Error(`OpenCode server exited (${code ?? "unknown"})`);
      if (child === activeChild) { child = null; endpoint = null; starting = null; }
    });
    activeChild.on("error", (error) => { exitError = error; if (child === activeChild) { child = null; endpoint = null; starting = null; } });
    const deadline = Date.now() + (options.timeoutMs ?? 15_000);
    while (!closed && Date.now() < deadline) {
      if (exitError) throw exitError;
      if (await healthy(url, password)) {
        if (exitError || closed) break;
        endpoint = { url, password };
        return endpoint;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (child === activeChild) { child = null; activeChild.kill(); }
    throw exitError ?? new Error(closed ? "OpenCode daemon was closed" : "OpenCode server did not become healthy");
  }

  return {
    ready(): Promise<Endpoint> {
      if (closed) return Promise.reject(new Error("OpenCode daemon was closed"));
      if (endpoint) return Promise.resolve(endpoint);
      if (!starting) starting = start().catch((error) => { starting = null; throw error; });
      return starting;
    },
    close(): void { closed = true; endpoint = null; starting = null; const running = child; child = null; running?.kill(); },
  };
}
