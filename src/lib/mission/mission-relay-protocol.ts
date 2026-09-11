export const MISSION_RELAY_FRAME_VERSION = "oathlock.relay.v1" as const;
export const MISSION_RELAY_MAX_FRAME_BYTES = 16_384;
export const MISSION_RELAY_MAX_PAYLOAD_BYTES = 8_192;

export const RELAY_CLIENT_FRAME_TYPES = [
  "auth.browser",
  "auth.bridge",
  "workspace.subscribe",
  "workspace.unsubscribe",
  "workspace.post",
  "workspace.timing",
  "mission.subscribe",
  "mission.unsubscribe",
  "message.post",
  "message.acknowledge",
  "participant.presence",
  "participant.typing",
  "workspace.step",
  "workspace.turn",
  "workspace.todos",
  "workspace.queued",
  "runtime.event",
  "runtime.session_state",
  "runtime.permission_response",
  "bridge.heartbeat",
  "git.operation_result",
  "cursor.resume",
  "huddle.join",
  "huddle.leave",
  "huddle.mute",
  "huddle.offer",
  "huddle.answer",
  "huddle.ice",
  "pty.open",
  "pty.output",
  "pty.input",
  "pty.resize",
  "pty.close",
  "pty.share",
  "pty.request",
  "pty.link",
  "pty.unlink",
  // Item #9 Phase 1a: fs.tree.request/fs.read.request are sent by a
  // viewer's browser, fs.tree/fs.content.chunk are sent by the resident (as
  // a client, since it holds a bridge connection to the relay like any
  // other), and both directions are listed here and in the server array so
  // parseRelayFrame accepts both the outbound request and the resident's
  // own room rebroadcast of its response.
  "fs.tree.request",
  "fs.tree",
  "fs.read.request",
  "fs.content.chunk",
  "fs.error",
  // Item #21 Phase 5b: live terminal-pane cursors. Pure fan-out, never
  // replayed to late joiners (a stale cursor position is noise, not state
  // worth keeping) -- see handlePresenceCursor's own comment for the
  // mandatory server-side rate limit this needs.
  "presence.cursor",
] as const;
export type RelayClientFrameType = (typeof RELAY_CLIENT_FRAME_TYPES)[number];

export const RELAY_SERVER_FRAME_TYPES = [
  "relay.ready",
  "workspace.snapshot",
  "workspace.event",
  "mission.snapshot",
  "mission.event",
  "message.delivery_command",
  "message.delivery_state",
  "runtime.event",
  "runtime.session_state",
  "runtime.permission_request",
  "participant.presence",
  "participant.typing",
  "workspace.step",
  "workspace.turn",
  "workspace.todos",
  "workspace.queued",
  "git.operation_command",
  "relay.error",
  "huddle.join",
  "huddle.leave",
  "huddle.mute",
  "huddle.offer",
  "huddle.answer",
  "huddle.ice",
  "pty.output",
  "pty.input",
  "pty.resize",
  "pty.state",
  "pty.requested",
  // Item #21 Phase 6: never sent by a client socket at all -- this only
  // ever originates from the internal-ingest HTTP path (see
  // MissionRelayService.publishServerFrame), which is why it appears only
  // in the server array, not RELAY_CLIENT_FRAME_TYPES, unlike every other
  // pty.* type above.
  "pty.handoff",
  "fs.tree.request",
  "fs.tree",
  "fs.read.request",
  "fs.content.chunk",
  "fs.error",
  "presence.cursor",
] as const;
export type RelayServerFrameType = (typeof RELAY_SERVER_FRAME_TYPES)[number];

export type MissionHuddleSignalFrameType = "huddle.offer" | "huddle.answer" | "huddle.ice";
export type MissionHuddleDescriptionType = "offer" | "answer";

export interface MissionHuddleIdentityPayload {
  huddleId: string;
  participantId: string;
}

export interface MissionHuddleMutePayload extends MissionHuddleIdentityPayload {
  muted: boolean;
}

export interface MissionHuddleDescription {
  type: MissionHuddleDescriptionType;
  sdp: string;
}

export interface MissionHuddleSignalTargetPayload extends MissionHuddleIdentityPayload {
  targetParticipantId: string;
}

export interface MissionHuddleOfferPayload extends MissionHuddleSignalTargetPayload {
  description: MissionHuddleDescription & { type: "offer" };
}

export interface MissionHuddleAnswerPayload extends MissionHuddleSignalTargetPayload {
  description: MissionHuddleDescription & { type: "answer" };
}

export interface MissionHuddleIceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface MissionHuddleIcePayload extends MissionHuddleSignalTargetPayload {
  candidate: MissionHuddleIceCandidate;
}

export interface RelayFrame<T = unknown> {
  version: typeof MISSION_RELAY_FRAME_VERSION;
  frameId: string;
  type: string;
  workspaceId: string;
  missionId?: string;
  /** Workspace channel id for workspace-scoped rooms. */
  channelId?: string;
  correlationId: string;
  causationId?: string | null;
  idempotencyKey?: string | null;
  sentAt: string;
  payload: T;
}

export type RelayFrameParseResult =
  | { ok: true; frame: RelayFrame }
  | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const isBoundedString = (value: unknown, maxLength: number): value is string => typeof value === "string" && value.length > 0 && value.length <= maxLength;

export function parseRelayFrame(input: unknown): RelayFrameParseResult {
  if (!isRecord(input)) return { ok: false, error: "frame must be an object" };
  if (input.version !== MISSION_RELAY_FRAME_VERSION) return { ok: false, error: "unsupported relay protocol version" };
  if (!isBoundedString(input.frameId, 128)) return { ok: false, error: "frameId is invalid" };
  if (!isBoundedString(input.type, 128)) return { ok: false, error: "frame type is invalid" };
  if (![...RELAY_CLIENT_FRAME_TYPES, ...RELAY_SERVER_FRAME_TYPES].includes(input.type as never)) return { ok: false, error: "unknown frame type" };
  if (!isBoundedString(input.workspaceId, 256)) return { ok: false, error: "workspaceId is invalid" };
  if (input.missionId !== undefined && !isBoundedString(input.missionId, 256)) return { ok: false, error: "missionId is invalid" };
  if (input.channelId !== undefined && !isBoundedString(input.channelId, 256)) return { ok: false, error: "channelId is invalid" };
  if (!isBoundedString(input.correlationId, 256)) return { ok: false, error: "correlationId is invalid" };
  if (input.causationId !== undefined && input.causationId !== null && !isBoundedString(input.causationId, 256)) return { ok: false, error: "causationId is invalid" };
  if (input.idempotencyKey !== undefined && input.idempotencyKey !== null && !isBoundedString(input.idempotencyKey, 256)) return { ok: false, error: "idempotencyKey is invalid" };
  if (!isBoundedString(input.sentAt, 64)) return { ok: false, error: "sentAt is invalid" };
  if (!Object.prototype.hasOwnProperty.call(input, "payload")) return { ok: false, error: "payload is required" };
  let payloadBytes: number;
  let frameBytes: number;
  try {
    payloadBytes = utf8ByteLength(JSON.stringify(input.payload) ?? "");
    frameBytes = utf8ByteLength(JSON.stringify(input) ?? "");
  } catch {
    return { ok: false, error: "frame is not serializable" };
  }
  if (payloadBytes > MISSION_RELAY_MAX_PAYLOAD_BYTES) return { ok: false, error: "payload exceeds relay limit" };
  if (frameBytes > MISSION_RELAY_MAX_FRAME_BYTES) return { ok: false, error: "frame exceeds relay limit" };
  return { ok: true, frame: input as unknown as RelayFrame };
}

/** Keep frame validation usable by both the Node Relay and the browser client. */
function utf8ByteLength(value: string): number {
  if (typeof Buffer !== "undefined") return Buffer.byteLength(value, "utf8");
  return new TextEncoder().encode(value).byteLength;
}
