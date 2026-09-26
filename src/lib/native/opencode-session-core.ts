/** Small, dependency-free client for attaching M9R to an existing local `opencode serve` instance. */
import { normalizeProjectFolder } from "./hosted-agent-session-core";
import { isIP } from "node:net";

export interface OpenCodeSessionRecord {
  id: string;
  projectFolder: string;
  title?: string;
}

export interface OpenCodeSessionHandle {
  provider: "opencode";
  sessionId: string;
  projectFolder: string;
  title?: string;
}

export interface OpenCodeAdapterOptions {
  baseUrl: string;
  username?: string;
  password?: string;
  fetch?: typeof fetch;
}

function validateBaseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("OpenCode server URL is invalid."); }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = hostname === "localhost" || hostname === "::1" || (isIP(hostname) === 4 && hostname.startsWith("127."));
  if (!loopback || !["http:", "https:"].includes(url.protocol)) throw new Error("OpenCode server must use a loopback URL.");
  if (url.username || url.password) throw new Error("OpenCode URL credentials are not allowed; pass credentials through the adapter options.");
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("OpenCode server URL must be an origin with no path, query, or fragment.");
  return url;
}

function parseSession(value: unknown): OpenCodeSessionRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const path = record.path && typeof record.path === "object" && !Array.isArray(record.path)
    ? record.path as Record<string, unknown>
    : undefined;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const directory = typeof record.directory === "string" ? record.directory : typeof path?.cwd === "string" ? path.cwd : "";
  const projectFolder = normalizeProjectFolder(directory);
  if (!id || id.length > 256 || !projectFolder) return null;
  return { id, projectFolder, ...(typeof record.title === "string" ? { title: record.title.slice(0, 200) } : {}) };
}

/** Attach to an existing explicitly selected OpenCode conversation; never starts or silently selects a session. */
export function createOpenCodeSessionAdapter(options: OpenCodeAdapterOptions) {
  const baseUrl = validateBaseUrl(options.baseUrl).origin;
  if (options.username && !options.password) throw new Error("OpenCode username requires a server password.");
  const fetcher = options.fetch ?? fetch;
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.password !== undefined) {
    headers.authorization = `Basic ${Buffer.from(`${options.username || "opencode"}:${options.password}`).toString("base64")}`;
  }
  const attachedFolders = new Map<string, string>();

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetcher(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) }, redirect: "error" });
    if (!response.ok) throw new Error(`OpenCode server returned HTTP ${response.status}.`);
    if (response.status === 204) return undefined;
    try { return await response.json() as unknown; } catch { throw new Error("OpenCode server returned invalid JSON."); }
  }

  return {
    async health(): Promise<{ version?: string }> {
      const value = await request("/global/health");
      if (!value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).healthy !== true) {
        throw new Error("OpenCode server is not healthy.");
      }
      const version = (value as Record<string, unknown>).version;
      return typeof version === "string" ? { version: version.slice(0, 100) } : {};
    },

    async listSessions(): Promise<OpenCodeSessionRecord[]> {
      const value = await request("/session");
      if (!Array.isArray(value)) throw new Error("OpenCode server returned an invalid session list.");
      return value.flatMap((item) => {
        const session = parseSession(item);
        return session ? [session] : [];
      });
    },

    async attach(input: { projectFolder: string; sessionId?: string }): Promise<OpenCodeSessionHandle> {
      const projectFolder = normalizeProjectFolder(input.projectFolder);
      if (!projectFolder) throw new Error("OpenCode project folder must be absolute.");
      const sessions = await this.listSessions();
      let candidates = sessions.filter((session) => session.projectFolder === projectFolder);
      if (input.sessionId !== undefined) {
        const idMatches = sessions.filter((session) => session.id === input.sessionId);
        if (idMatches.length > 1) throw new Error("OpenCode session id is ambiguous on this server.");
        if (idMatches.length === 0) throw new Error("OpenCode session was not found.");
        if (idMatches[0].projectFolder !== projectFolder) throw new Error("OpenCode session is not in the requested folder.");
        candidates = idMatches;
      }
      if (candidates.length === 0) throw new Error("No OpenCode session was found in the requested folder.");
      if (candidates.length > 1) throw new Error(`OpenCode session selection is ambiguous (${candidates.length} sessions); provide a session id.`);
      attachedFolders.set(candidates[0].id, candidates[0].projectFolder);
      return { provider: "opencode", sessionId: candidates[0].id, projectFolder: candidates[0].projectFolder, ...(candidates[0].title ? { title: candidates[0].title } : {}) };
    },

    async send(input: { session: OpenCodeSessionHandle; text: string }): Promise<void> {
      if (input.session.provider !== "opencode" || !input.session.sessionId.trim() || input.session.sessionId.length > 256) {
        throw new Error("A valid attached OpenCode session is required.");
      }
      const projectFolder = normalizeProjectFolder(input.session.projectFolder);
      if (!projectFolder || attachedFolders.get(input.session.sessionId) !== projectFolder) throw new Error("OpenCode session handle was not attached by this adapter.");
      if (!input.text.trim() || input.text.length > 20_000) throw new Error("OpenCode prompt must contain 1 to 20000 characters.");
      await request(`/session/${encodeURIComponent(input.session.sessionId)}/prompt_async`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: input.text }] }),
      });
    },
  };
}
