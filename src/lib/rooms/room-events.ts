import { createHash } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_KINDS = new Set([
  "action", "post", "ask", "reply", "share", "approval", "disclosure", "membership",
  "task", "handoff", "intent", "artifact",
]);
const AUTHORITATIVE_EVENT_KINDS = new Set(["approval", "disclosure", "intent", "membership"]);
const TASK_STATES = new Set(["open", "claimed", "blocked", "done", "cancelled"]);
const HANDOFF_STATES = new Set(["proposed", "accepted", "declined", "countered", "cancelled", "completed"]);

export interface NormalizedRoomEvent {
  clientEventId: string;
  kind: string;
  actorSeatId: string | null;
  causalEventIds: string[];
  payload: Record<string, unknown>;
  payloadDigest: string;
}

export type RoomEventNormalization =
  | { ok: true; value: NormalizedRoomEvent }
  | { ok: false; error: string };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= max ? text : null;
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function actorId(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 128) return null;
  if (/^member:[0-9a-f-]{36}$/i.test(value) || /^seat:[0-9a-f-]{36}$/i.test(value)) return value;
  return null;
}

function normalizeDoneCriteria(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return null;
  const criteria = value.map((item) => boundedText(item, 500));
  return criteria.every((item): item is string => item !== null) ? criteria : null;
}

function normalizedPayload(kind: string, input: unknown): Record<string, unknown> | null {
  const source = record(input);
  if (!source) return null;
  const payload: Record<string, unknown> = {};

  if (["post", "ask", "reply"].includes(kind)) {
    const text = boundedText(source.text, 4_000);
    if (!text) return null;
    payload.type = kind === "post" ? "message" : kind;
    payload.text = text;
    if (source.recipientActorId !== undefined) {
      const recipient = actorId(source.recipientActorId);
      if (!recipient) return null;
      payload.recipientActorId = recipient;
    }
    if (source.replyTo !== undefined) {
      if (!uuid(source.replyTo)) return null;
      payload.replyTo = source.replyTo;
    }
    return payload;
  }

  if (kind === "task") {
    const type = source.type;
    const taskId = source.taskId;
    if (!uuid(taskId) || !["created", "updated", "completed", "cancelled", "blocked"].includes(String(type))) return null;
    payload.type = type;
    payload.taskId = taskId;
    if (source.title !== undefined) {
      const title = boundedText(source.title, 160);
      if (!title) return null;
      payload.title = title;
    }
    if (source.goal !== undefined) {
      const goal = boundedText(source.goal, 4_000);
      if (!goal) return null;
      payload.goal = goal;
    }
    if (source.doneCriteria !== undefined) {
      const criteria = normalizeDoneCriteria(source.doneCriteria);
      if (!criteria) return null;
      payload.doneCriteria = criteria;
    }
    if (source.status !== undefined) {
      if (typeof source.status !== "string" || !TASK_STATES.has(source.status)) return null;
      payload.status = source.status;
    }
    const expectedStatus = type === "completed" ? "done" : type === "cancelled" ? "cancelled" : type === "blocked" ? "blocked" : type === "created" ? "open" : null;
    if (expectedStatus && source.status !== undefined && source.status !== expectedStatus) return null;
    if (expectedStatus) payload.status = expectedStatus;
    if (type === "created" && (!payload.title || !payload.goal || !payload.doneCriteria)) return null;
    return payload;
  }

  if (kind === "handoff") {
    if (!uuid(source.handoffId) || !uuid(source.taskId)
      || ![...HANDOFF_STATES].includes(String(source.type))) return null;
    const recipient = actorId(source.recipientActorId);
    if (!recipient) return null;
    payload.type = source.type;
    payload.handoffId = source.handoffId;
    payload.taskId = source.taskId;
    payload.recipientActorId = recipient;
    if (source.context !== undefined) {
      const context = boundedText(source.context, 4_000);
      if (!context) return null;
      payload.context = context;
    }
    if (source.doneCriteria !== undefined) {
      const criteria = normalizeDoneCriteria(source.doneCriteria);
      if (!criteria) return null;
      payload.doneCriteria = criteria;
    }
    if (source.response !== undefined) {
      const response = boundedText(source.response, 2_000);
      if (!response) return null;
      payload.response = response;
    }
    if (source.type === "proposed" && (!payload.context || !payload.doneCriteria)) return null;
    return payload;
  }

  if (kind === "artifact") {
    if (!uuid(source.artifactId) || !["created", "updated"].includes(String(source.type))) return null;
    const title = boundedText(source.title, 160);
    if (!title || typeof source.content !== "string" || Buffer.byteLength(source.content, "utf8") > 8_000) return null;
    if (Object.keys(source).some((key) => !["type", "artifactId", "baseEventId", "title", "content"].includes(key))) return null;
    payload.type = source.type;
    payload.artifactId = source.artifactId;
    payload.title = title;
    payload.content = source.content;
    if (source.type === "created") {
      if (source.baseEventId !== undefined) return null;
    } else {
      if (!uuid(source.baseEventId)) return null;
      payload.baseEventId = source.baseEventId;
    }
    return payload;
  }

  if (kind === "action") {
    if (source.type !== "shared_target.confirmed" || source.owner_confirmed !== true
      || Object.keys(source).some((key) => !["type", "owner_confirmed", "target"].includes(key))) return null;
    const target = record(source.target);
    const targetKeys = ["pageGroupId", "origin", "path", "tabRef"];
    if (!target || Object.keys(target).some((key) => !targetKeys.includes(key))) return null;
    const safeTarget: Record<string, string> = {};
    for (const key of targetKeys) {
      const text = boundedText(target[key], 512);
      if (!text) return null;
      safeTarget[key] = text;
    }
    return { type: "shared_target.confirmed", owner_confirmed: true, target: safeTarget };
  }

  const allowed = new Set([
    "type", "recipientActorId", "replyTo", "intentId", "taskId", "decision", "summary", "action",
    "pageGroupId", "origin", "path", "tabRef", "claimId", "artifactRef", "label", "owner_confirmed", "target", "scope",
    "resourceKey", "holderActorId", "expiresAt",
  ]);
  if (Object.keys(source).some((key) => !allowed.has(key))) return null;
  for (const key of ["type", "recipientActorId", "replyTo", "intentId", "taskId", "decision", "summary", "action", "pageGroupId", "origin", "path", "tabRef", "claimId", "artifactRef", "label", "resourceKey", "holderActorId", "expiresAt"]) {
    const value = source[key];
    if (value === undefined) continue;
    if (key === "recipientActorId" || key === "holderActorId") {
      const recipient = actorId(value);
      if (!recipient) return null;
      payload[key] = recipient;
    } else if (["replyTo", "intentId", "taskId", "claimId"].includes(key)) {
      if (!uuid(value)) return null;
      payload[key] = value;
    } else if (key === "owner_confirmed") {
      if (value !== true) return null;
      payload[key] = true;
    } else {
      const text = boundedText(value, key === "summary" ? 1_000 : 256);
      if (!text) return null;
      payload[key] = text;
    }
  }
  if (source.owner_confirmed !== undefined) {
    if (source.owner_confirmed !== true) return null;
    payload.owner_confirmed = true;
  }
  if (source.target !== undefined) {
    const target = record(source.target);
    if (!target || Object.keys(target).some((key) => !["pageGroupId", "origin", "path", "tabRef"].includes(key))) return null;
    const safeTarget: Record<string, string> = {};
    for (const key of ["pageGroupId", "origin", "path", "tabRef"]) {
      if (target[key] === undefined) continue;
      const text = boundedText(target[key], 512);
      if (!text) return null;
      safeTarget[key] = text;
    }
    payload.target = safeTarget;
  }
  if (source.scope !== undefined) {
    const scope = record(source.scope);
    if (!scope || Object.keys(scope).some((key) => !["kind", "key"].includes(key))) return null;
    const safeScope: Record<string, string> = {};
    for (const key of ["kind", "key"]) {
      if (scope[key] === undefined) continue;
      const text = boundedText(scope[key], 256);
      if (!text) return null;
      safeScope[key] = text;
    }
    payload.scope = safeScope;
  }
  return payload;
}

/** Validate and minimize data before it enters the durable, member-visible room log. */
export function normalizeRoomEvent(input: unknown): RoomEventNormalization {
  const source = record(input);
  if (!source) return { ok: false, error: "Room event must be an object." };
  if (!uuid(source.clientEventId)) return { ok: false, error: "Room event identity is invalid." };
  if (typeof source.kind !== "string" || !EVENT_KINDS.has(source.kind)) {
    return { ok: false, error: source.kind === "presence" ? "Presence is ephemeral and cannot be stored as a room event." : "Room event kind is invalid." };
  }
  if (AUTHORITATIVE_EVENT_KINDS.has(source.kind)) {
    return { ok: false, error: "This room event requires a purpose-built authority workflow and cannot be appended generically." };
  }
  const actorSeatId = source.actorSeatId === undefined || source.actorSeatId === null ? null : source.actorSeatId;
  if (actorSeatId !== null && !uuid(actorSeatId)) return { ok: false, error: "Room agent seat is invalid." };
  const causalEventIds = source.causalEventIds === undefined ? [] : source.causalEventIds;
  if (!Array.isArray(causalEventIds) || causalEventIds.length > 32 || !causalEventIds.every(uuid)) {
    return { ok: false, error: "Room event causal references are invalid." };
  }
  const payload = normalizedPayload(source.kind, source.payload);
  if (!payload || Buffer.byteLength(JSON.stringify(payload), "utf8") > 12 * 1024) {
    return { ok: false, error: "Room event payload is invalid or too large." };
  }
  if (source.kind === "artifact" && payload.type === "updated" && !causalEventIds.includes(String(payload.baseEventId))) {
    return { ok: false, error: "A shared artifact edit must reference the exact version it replaces." };
  }
  const payloadDigest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return {
    ok: true,
    value: {
      clientEventId: source.clientEventId,
      kind: source.kind,
      actorSeatId,
      causalEventIds: causalEventIds.slice(),
      payload,
      payloadDigest,
    },
  };
}
