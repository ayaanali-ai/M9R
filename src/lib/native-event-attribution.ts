/** Assign local native metadata to exactly one consented workspace by its recorded working directory.
 * No arbitrary event text or task goal is returned or sent to the server.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createHmac } from "node:crypto";
import type { EventRecord, SessionRecord } from "@/lib/native/local-store";
import type { Task } from "@/lib/native/inbox-core";

export interface NativeWorkspaceBinding {
  workspaceId: string;
  repoRoots: Array<{ path: string; connectedAt: string }>;
  hmacKey: string;
}

export interface AttributedNativeEvent {
  workspaceId: string;
  kind: "agent_connected" | "task_created" | "task_delivered" | "task_approved" | "task_result";
  taskId?: string;
  handle?: string;
  occurredAt: string;
  /** Opaque HMAC of local event identity, never prompt text. */
  localIdentity: string;
}

const TASK_KIND: Partial<Record<EventRecord["kind"], AttributedNativeEvent["kind"]>> = {
  "task.created": "task_created",
  "task.delivered": "task_delivered",
  "task.approved": "task_approved",
  "task.result": "task_result",
};

/** The deepest containing root wins. Equal-depth conflicting workspaces fail closed. */
export function workspaceForNativePath(path: string | undefined, occurredAt: string, bindings: readonly NativeWorkspaceBinding[]): string | null {
  if (!path || !isAbsolute(path) || !Number.isFinite(Date.parse(occurredAt))) return null;
  const target = resolve(path);
  let depth = -1;
  let selected: string | null = null;
  let ambiguous = false;
  for (const binding of bindings) for (const root of binding.repoRoots) {
    if (!isAbsolute(root.path) || !Number.isFinite(Date.parse(root.connectedAt)) || Date.parse(occurredAt) < Date.parse(root.connectedAt)) continue;
    const base = resolve(root.path);
    const remainder = relative(base, target);
    if (remainder === ".." || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) continue;
    if (base.length < depth) continue;
    if (base.length > depth) { depth = base.length; selected = binding.workspaceId; ambiguous = false; }
    else if (selected !== binding.workspaceId) ambiguous = true;
  }
  return ambiguous ? null : selected;
}

export function attributeNativeEvents(snapshot: { tasks: readonly Task[]; sessions: readonly SessionRecord[]; events: readonly EventRecord[] }, bindings: readonly NativeWorkspaceBinding[]): AttributedNativeEvent[] {
  const tasks = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const hmacKeyByWorkspace = new Map(bindings.map((binding) => [binding.workspaceId, binding.hmacKey]));
  const identity = (workspaceId: string, pieces: unknown[]) => createHmac("sha256", hmacKeyByWorkspace.get(workspaceId)!).update(JSON.stringify(pieces)).digest("hex");
  const result: AttributedNativeEvent[] = [];
  for (const event of snapshot.events) {
    const kind = TASK_KIND[event.kind];
    if (!kind || !event.taskId) continue;
    const task = tasks.get(event.taskId);
    if (!task) continue;
    const workspaceId = workspaceForNativePath(task.cwd, event.at, bindings);
    if (!workspaceId) continue;
    result.push({ workspaceId, kind, occurredAt: event.at,
      ...(event.taskId && /^[A-Za-z0-9-]{1,64}$/.test(event.taskId) ? { taskId: event.taskId } : {}),
      ...(event.handle && /^[a-z0-9-]{1,80}$/.test(event.handle) ? { handle: event.handle } : {}),
      localIdentity: identity(workspaceId, [event.at, event.kind, event.taskId, event.handle ?? "", event.text]),
    });
  }
  for (const session of snapshot.sessions) {
    const workspaceId = workspaceForNativePath(session.cwd, session.firstSeenAt, bindings);
    if (!workspaceId) continue;
    result.push({ workspaceId, kind: "agent_connected", occurredAt: session.firstSeenAt,
      ...(session.handle && /^[a-z0-9-]{1,80}$/.test(session.handle) ? { handle: session.handle } : {}),
      localIdentity: identity(workspaceId, [session.firstSeenAt, session.handle, session.provider, session.sessionId]),
    });
  }
  return result.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}
