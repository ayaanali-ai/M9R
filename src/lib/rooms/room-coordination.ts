const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID = new RegExp(`^${UUID_SOURCE}$`, "i");
const TASK_RESOURCE = new RegExp(`^task:${UUID_SOURCE}$`, "i");
const BROWSER_RESOURCE = /^browser:[A-Za-z0-9:_-]{1,160}$/;

export interface RoomLeaseRequest {
  action: "acquire" | "release";
  clientEventId: string;
  resourceKey: string;
  actorSeatId: string | null;
  ttlMs: number | null;
  preempt: boolean;
}

export type RoomLeaseRequestResult =
  | { ok: true; value: RoomLeaseRequest }
  | { ok: false; error: string };

export interface RoomHandoffRequest {
  action: "propose" | "accept" | "decline" | "counter" | "cancel" | "complete";
  clientEventId: string;
  handoffId: string;
  taskId: string;
  actorSeatId: string | null;
  recipientActorId: string;
  context: string | null;
  doneCriteria: string[] | null;
  response: string | null;
}

export type RoomHandoffRequestResult =
  | { ok: true; value: RoomHandoffRequest }
  | { ok: false; error: string };

/** A lease is a coordination lock, never an execution grant. Only the owner can request preemption. */
export function normalizeRoomLeaseRequest(input: unknown): RoomLeaseRequestResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Room lease request must be an object." };
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["action", "clientEventId", "resourceKey", "actorSeatId", "ttlMs", "preempt"].includes(key))) {
    return { ok: false, error: "Room lease request contains unsupported fields." };
  }
  if (value.action !== "acquire" && value.action !== "release") return { ok: false, error: "Room lease action is invalid." };
  if (typeof value.clientEventId !== "string" || !UUID.test(value.clientEventId)) return { ok: false, error: "Room lease identity is invalid." };
  if (typeof value.resourceKey !== "string" || value.resourceKey.length > 180 || !(TASK_RESOURCE.test(value.resourceKey) || BROWSER_RESOURCE.test(value.resourceKey))) {
    return { ok: false, error: "Room lease resource is invalid." };
  }
  const actorSeatId = value.actorSeatId === undefined || value.actorSeatId === null ? null : value.actorSeatId;
  if (actorSeatId !== null && (typeof actorSeatId !== "string" || !UUID.test(actorSeatId))) return { ok: false, error: "Room agent identity is invalid." };
  const preempt = value.preempt === undefined ? false : value.preempt;
  if (typeof preempt !== "boolean" || (value.action === "release" && preempt)) return { ok: false, error: "Room lease preemption is invalid." };

  let ttlMs: number | null = null;
  if (value.action === "acquire") {
    if (!Number.isSafeInteger(value.ttlMs) || Number(value.ttlMs) < 5_000 || Number(value.ttlMs) > 120_000) {
      return { ok: false, error: "Room lease duration must be between 5 and 120 seconds." };
    }
    ttlMs = Number(value.ttlMs);
  } else if (value.ttlMs !== undefined) {
    return { ok: false, error: "A release request must not set a lease duration." };
  }

  return {
    ok: true,
    value: {
      action: value.action,
      clientEventId: value.clientEventId,
      resourceKey: value.resourceKey,
      actorSeatId,
      ttlMs,
      preempt,
    },
  };
}

/** Validate a stateful handoff command before it reaches the transactional RPC. */
export function normalizeRoomHandoffRequest(input: unknown): RoomHandoffRequestResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Room handoff request must be an object." };
  const value = input as Record<string, unknown>;
  const allowed = ["action", "clientEventId", "handoffId", "taskId", "actorSeatId", "recipientActorId", "context", "doneCriteria", "response"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return { ok: false, error: "Room handoff request contains unsupported fields." };
  const actions = ["propose", "accept", "decline", "counter", "cancel", "complete"] as const;
  if (!actions.includes(value.action as (typeof actions)[number])) return { ok: false, error: "Room handoff action is invalid." };
  if (typeof value.clientEventId !== "string" || !UUID.test(value.clientEventId)
    || typeof value.handoffId !== "string" || !UUID.test(value.handoffId)
    || typeof value.taskId !== "string" || !UUID.test(value.taskId)) {
    return { ok: false, error: "Room handoff identity is invalid." };
  }
  const actorSeatId = value.actorSeatId === undefined || value.actorSeatId === null ? null : value.actorSeatId;
  if (actorSeatId !== null && (typeof actorSeatId !== "string" || !UUID.test(actorSeatId))) return { ok: false, error: "Room agent identity is invalid." };
  if (typeof value.recipientActorId !== "string"
    || !/^(member|seat):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.recipientActorId)) {
    return { ok: false, error: "Room handoff recipient is invalid." };
  }

  const action = value.action as RoomHandoffRequest["action"];
  const context = value.context === undefined || value.context === null ? null : value.context;
  const response = value.response === undefined || value.response === null ? null : value.response;
  if (context !== null && (typeof context !== "string" || context.trim().length < 1 || context.trim().length > 4_000)) {
    return { ok: false, error: "Room handoff context must be between 1 and 4,000 characters." };
  }
  if (response !== null && (typeof response !== "string" || response.trim().length < 1 || response.trim().length > 2_000)) {
    return { ok: false, error: "Room handoff response must be between 1 and 2,000 characters." };
  }
  let doneCriteria: string[] | null = null;
  if (value.doneCriteria !== undefined && value.doneCriteria !== null) {
    if (!Array.isArray(value.doneCriteria) || value.doneCriteria.length < 1 || value.doneCriteria.length > 16
      || value.doneCriteria.some((criterion) => typeof criterion !== "string" || criterion.trim().length < 1 || criterion.trim().length > 500)) {
      return { ok: false, error: "Room handoff done criteria must contain 1 to 16 bounded entries." };
    }
    doneCriteria = value.doneCriteria.map((criterion) => (criterion as string).trim());
  }
  if (action === "propose" && (!context || !doneCriteria)) return { ok: false, error: "A handoff proposal requires context and done criteria." };
  if (action === "counter" && !response) return { ok: false, error: "A counteroffer requires a response." };
  if (action !== "propose" && context === null && doneCriteria !== null && action !== "counter") return { ok: false, error: "Only a proposal or counteroffer may change handoff context or criteria." };
  if (action !== "propose" && (context !== null || doneCriteria !== null) && action !== "counter") return { ok: false, error: "Only a proposal or counteroffer may change handoff context or criteria." };

  return {
    ok: true,
    value: {
      action,
      clientEventId: value.clientEventId,
      handoffId: value.handoffId,
      taskId: value.taskId,
      actorSeatId,
      recipientActorId: value.recipientActorId,
      context: context === null ? null : context.trim(),
      doneCriteria,
      response: response === null ? null : response.trim(),
    },
  };
}
