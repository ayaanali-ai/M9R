/**
 * The resident engine answers hook calls over a local pipe so the small hook program never has to start the big engine
 * inside an agent's hook time limit (Claude cancels a hook after 5 s; a cold start of the 92 MB engine took 5.5 to 6 s).
 *
 * Wire format, one request per connection: the client writes one JSON line; the server writes the hook's output (possibly
 * empty) and closes. `{"cmd":"shutdown"}` stops the server (setup and uninstall use it before replacing the engine file).
 * The pipe belongs to the current user; like the state file it is only as private as that Windows account.
 */
import { createServer, connect, type Server } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import type { HookInput } from "./hook-handler";

const BACKSLASH = String.fromCharCode(92);

/** FNV-1a over the lower-cased M9R folder path, so different M9R homes (real, test) never share a pipe. The native hook computes the same. */
export function rootTag(root: string): string {
  let norm = root.split("/").join(BACKSLASH).toLowerCase();
  while (norm.endsWith(BACKSLASH)) norm = norm.slice(0, -1);
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(norm, "utf8")) { h ^= byte; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

export function hookPipePath(root: string, platform: NodeJS.Platform = process.platform, user = safeUser()): string {
  if (platform === "win32") return [BACKSLASH, BACKSLASH, ".", BACKSLASH, "pipe", BACKSLASH, `m9r-hook-${user}-${rootTag(root)}`].join("");
  return join(root, "hook.sock");
}

function safeUser(): string {
  try { return userInfo().username.replace(/[^A-Za-z0-9_-]/g, "_"); } catch { return "user"; }
}

export interface ServerRequest { cmd?: string; event?: string; provider?: string; input?: HookInput | null; env?: Record<string, string | undefined> }

export function startHookServer(options: { path: string; handle: (req: ServerRequest) => string; onShutdown: () => void }): Server {
  if (process.platform !== "win32" && existsSync(options.path)) rmSync(options.path, { force: true });
  const server = createServer((socket) => {
    let buf = "";
    let answered = false;
    const answer = (text: string) => { if (answered) return; answered = true; socket.end(text); };
    socket.setTimeout(8000, () => answer(""));
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0 && buf.length < 4_000_000) return;
      try {
        const req = JSON.parse(nl < 0 ? buf : buf.slice(0, nl)) as ServerRequest;
        if (req.cmd === "shutdown") { answer("ok"); setTimeout(options.onShutdown, 50); return; }
        answer(options.handle(req));
      } catch { answer(""); }
    });
  });
  server.on("error", () => undefined);
  server.listen(options.path);
  return server;
}

/** Asks a running engine to stop; resolves quietly whether or not one was there. */
export function requestShutdown(path: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const done = (ok: boolean) => { try { socket.destroy(); } catch { /* gone */ } resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on("error", () => done(false));
    socket.on("connect", () => socket.write(JSON.stringify({ cmd: "shutdown" }) + "\n"));
    socket.on("data", () => done(true));
  });
}
