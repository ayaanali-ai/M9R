/** Always-on, metadata-only native event uploader. Never called from a provider hook. */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLocalStore, defaultStoreRoot } from "@/lib/native/local-store";
import { attributeNativeEvents, type AttributedNativeEvent, type NativeWorkspaceBinding } from "@/lib/native-event-attribution";

interface MachineCredential {
  token: string;
  deviceId: string;
  workspaceId: string;
  agentKind: string;
  apiUrl: string;
  repoRoots: Array<{ path: string; connectedAt: string }>;
}
interface QueuedEvent {
  id: string;
  seq: number;
  kind: AttributedNativeEvent["kind"];
  taskId?: string;
  handle?: string;
  occurredAt: string;
}
interface SyncState {
  hmacKey: string;
  nextSeq: number;
  seen: string[];
  pending: QueuedEvent[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PENDING = 5_000;

function eventUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function loadCredentials(home: string): Promise<MachineCredential[]> {
  const workspaces = join(home, ".m9r", "workspaces");
  const result: MachineCredential[] = [];
  for (const workspaceId of await readdir(workspaces).catch(() => [])) {
    if (!UUID.test(workspaceId)) continue;
    for (const file of await readdir(join(workspaces, workspaceId)).catch(() => [])) {
      if (!/^[a-z0-9-]+\.json$/.test(file)) continue;
      try {
        const value = JSON.parse(await readFile(join(workspaces, workspaceId, file), "utf8")) as MachineCredential;
        if (value.workspaceId !== workspaceId || !UUID.test(value.deviceId) || !value.token
          || !/^https?:\/\//.test(value.apiUrl) || !/^[a-z0-9-]{1,40}$/.test(value.agentKind)
          || !Array.isArray(value.repoRoots) || value.repoRoots.length === 0) continue;
        result.push(value);
      } catch { /* A damaged profile is not consent. */ }
    }
  }
  return result.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId) || a.agentKind.localeCompare(b.agentKind));
}

async function loadState(path: string): Promise<SyncState> {
  try {
    const saved = JSON.parse(await readFile(path, "utf8")) as SyncState;
    if (/^[a-f0-9]{64}$/.test(saved.hmacKey) && Number.isSafeInteger(saved.nextSeq)
      && Array.isArray(saved.seen) && Array.isArray(saved.pending)) return saved;
  } catch { /* First run. */ }
  return { hmacKey: randomBytes(32).toString("hex"), nextSeq: 0, seen: [], pending: [] };
}

async function saveState(path: string, state: SyncState): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, path);
}

async function withStateLock(root: string, workspaceId: string, run: (state: SyncState, path: string) => Promise<void>): Promise<void> {
  const directory = join(root, "sync");
  await mkdir(directory, { recursive: true });
  const lock = join(directory, `${workspaceId}.lock`);
  try { await mkdir(lock); } catch {
    const details = await stat(lock).catch(() => null);
    if (!details || Date.now() - details.mtimeMs <= 120_000) return;
    await rmdir(lock).catch(() => {});
    try { await mkdir(lock); } catch { return; }
  }
  try {
    const path = join(directory, `${workspaceId}.json`);
    await run(await loadState(path), path);
  } finally { await rmdir(lock).catch(() => {}); }
}

async function uploadWorkspace(
  root: string,
  workspaceId: string,
  credentials: readonly MachineCredential[],
  allCredentials: readonly MachineCredential[],
  snapshot: ReturnType<ReturnType<typeof createLocalStore>["snapshot"]>,
  post: typeof fetch,
): Promise<void> {
  await withStateLock(root, workspaceId, async (state, path) => {
    const rootsByWorkspace = new Map<string, NativeWorkspaceBinding>();
    for (const item of allCredentials) {
      const current = rootsByWorkspace.get(item.workspaceId) ?? { workspaceId: item.workspaceId,
        hmacKey: item.workspaceId === workspaceId ? state.hmacKey : "not-used", repoRoots: [] };
      current.repoRoots.push(...item.repoRoots);
      rootsByWorkspace.set(item.workspaceId, current);
    }
    // Pass every workspace's roots to the resolver. A nested or duplicate
    // root owned by another workspace must never be guessed into this one.
    const events = attributeNativeEvents(snapshot, [...rootsByWorkspace.values()])
      .filter((event) => event.workspaceId === workspaceId);
    const seen = new Set(state.seen);
    for (const event of events) {
      if (seen.has(event.localIdentity) || state.pending.length >= MAX_PENDING) continue;
      state.pending.push({ id: eventUuid(event.localIdentity), seq: state.nextSeq++, kind: event.kind,
        ...(event.taskId ? { taskId: event.taskId } : {}), ...(event.handle ? { handle: event.handle } : {}), occurredAt: event.occurredAt });
      state.seen.push(event.localIdentity);
      seen.add(event.localIdentity);
    }
    state.seen = state.seen.slice(-10_000);
    await saveState(path, state); // Durable before network attempt.
    if (state.pending.length === 0) return;
    const batch = state.pending.slice(0, 100);
    for (const credential of credentials) {
      try {
        const response = await post(`${credential.apiUrl.replace(/\/+$/, "")}/api/agent/native/events`, {
          method: "POST", headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
          body: JSON.stringify({ deviceId: credential.deviceId, events: batch }), signal: AbortSignal.timeout(10_000),
        });
        if (response.status === 401 || response.status === 403) continue; // Another approved provider may still be active.
        if (!response.ok) return;
        state.pending.splice(0, batch.length);
        await saveState(path, state);
        return;
      } catch { return; /* Offline: retain queued metadata for the next tick. */ }
    }
  });
}

export async function syncNativeEventsOnce(options: { home?: string; env?: Record<string, string | undefined>; post?: typeof fetch } = {}): Promise<void> {
  const home = options.home ?? homedir();
  const credentials = await loadCredentials(home);
  if (credentials.length === 0) return;
  const root = defaultStoreRoot(home, options.env ?? process.env);
  const snapshot = createLocalStore(root).snapshot();
  const byWorkspace = new Map<string, MachineCredential[]>();
  for (const credential of credentials) byWorkspace.set(credential.workspaceId, [...(byWorkspace.get(credential.workspaceId) ?? []), credential]);
  for (const [workspaceId, group] of byWorkspace) await uploadWorkspace(root, workspaceId, group, credentials, snapshot, options.post ?? fetch);
}

export function startNativeEventSync(options: { home?: string; env?: Record<string, string | undefined>; intervalMs?: number } = {}): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await syncNativeEventsOnce(options); } finally { busy = false; }
  };
  void tick().catch(() => {});
  const timer = setInterval(() => void tick().catch(() => {}), options.intervalMs ?? 30_000);
  timer.unref();
  return () => clearInterval(timer);
}
