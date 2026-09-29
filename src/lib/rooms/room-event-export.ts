const TASK_TYPES = new Set(["created", "updated", "completed", "cancelled", "blocked", "assigned"]);
const ARTIFACT_TYPES = new Set(["created", "updated"]);
const HANDOFF_TYPES = new Set(["proposed", "accepted", "declined", "countered", "cancelled", "completed"]);
const ACTOR_ID = /^(member|seat):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHARED_TARGET_KEYS = ["pageGroupId", "origin", "path", "tabRef"];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function verifiedSharedTarget(payload: Record<string, unknown>): boolean {
  const target = record(payload.target);
  const payloadKeys = ["type", "owner_confirmed", "target"];
  return payload.type === "shared_target.confirmed"
    && payload.owner_confirmed === true
    && payloadKeys.every((key) => key in payload)
    && Object.keys(payload).every((key) => payloadKeys.includes(key))
    && Boolean(target)
    && SHARED_TARGET_KEYS.every((key) => typeof target?.[key] === "string" && (target[key] as string).length > 0 && (target[key] as string).length <= 512)
    && Object.keys(target!).length === SHARED_TARGET_KEYS.length
    && Object.keys(target!).every((key) => SHARED_TARGET_KEYS.includes(key));
}

/** Derive exported event types from the server-controlled kind, never an arbitrary payload.type. */
export function projectRoomEventType(kind: string, payloadValue: unknown): string {
  const payload = record(payloadValue) ?? {};
  const payloadType = typeof payload.type === "string" ? payload.type : "";

  switch (kind) {
    case "post": return "room.message";
    case "ask": return "agent.ask";
    case "reply": return "agent.reply";
    case "action": return verifiedSharedTarget(payload) ? "room.shared_target.confirmed" : "room.action.unverified";
    case "intent":
    case "approval":
    case "disclosure":
    case "membership": return `room.${kind}.unverified`;
    case "handoff":
      return HANDOFF_TYPES.has(payloadType) && typeof payload.actorId === "string" && ACTOR_ID.test(payload.actorId)
        && typeof payload.senderActorId === "string" && ACTOR_ID.test(payload.senderActorId)
        ? `room.handoff.${payloadType}`
        : "room.handoff.unverified";
    case "task": return TASK_TYPES.has(payloadType) ? `room.task.${payloadType}` : "room.task.unverified";
    case "artifact": return ARTIFACT_TYPES.has(payloadType) ? `room.artifact.${payloadType}` : "room.artifact.unverified";
    default: return `room.${kind}`;
  }
}
