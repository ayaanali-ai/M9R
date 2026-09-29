/** Membership-bound room relay coordination. Payloads are opaque to this layer; local owners retain browser authority. */
export type RoomMemberState = "requested" | "invited" | "active" | "left" | "removed" | "denied";
export type RoomEventKind = "presence" | "message" | "claim" | "release" | "web.presence";

export interface RoomMember {
  memberId: string;
  ownerId: string;
  state: RoomMemberState;
  quietUntilInvited: boolean;
}

export interface RoomRelayEvent {
  roomId: string;
  sequence: number;
  eventId: string;
  actorMemberId: string;
  kind: RoomEventKind;
  payload: string;
}

export type RoomRelayResult = { ok: true } | { ok: false; error: string };

const MAX_SEEN = 5_000;

export function createRoomRelayCore(options: { now?: () => number; newId?: () => string } = {}) {
  const newId = options.newId ?? (() => crypto.randomUUID());
  const rooms = new Map<string, { ownerMemberId: string; members: Map<string, RoomMember>; sinks: Map<string, Set<(event: RoomRelayEvent) => void>>; sequence: number; seen: Set<string> }>();

  function create(roomId: string, ownerId: string): RoomRelayResult {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(roomId) || !ownerId || rooms.has(roomId)) return { ok: false, error: "room already exists or identifiers are invalid" };
    const members = new Map<string, RoomMember>();
    members.set(ownerId, { memberId: ownerId, ownerId, state: "active", quietUntilInvited: false });
    rooms.set(roomId, { ownerMemberId: ownerId, members, sinks: new Map(), sequence: 0, seen: new Set() });
    return { ok: true };
  }

  function requestJoin(roomId: string, memberId: string, ownerId: string): RoomRelayResult {
    const room = rooms.get(roomId);
    if (!room || !memberId || !ownerId) return { ok: false, error: "room not found" };
    const current = room.members.get(memberId);
    if (current?.state === "active") return { ok: true };
    room.members.set(memberId, { memberId, ownerId, state: "requested", quietUntilInvited: true });
    return { ok: true };
  }

  function admit(roomId: string, actingMemberId: string, memberId: string): RoomRelayResult {
    const room = rooms.get(roomId);
    const member = room?.members.get(memberId);
    if (!room || !member) return { ok: false, error: "member request not found" };
    if (room.ownerMemberId !== actingMemberId) return { ok: false, error: "only the room owner can admit a member" };
    if (member.state !== "requested" && member.state !== "invited") return { ok: false, error: "member is not awaiting admission" };
    member.state = "active";
    member.quietUntilInvited = false;
    return { ok: true };
  }

  function remove(roomId: string, actingMemberId: string, memberId: string): RoomRelayResult {
    const room = rooms.get(roomId);
    const member = room?.members.get(memberId);
    if (!room || !member) return { ok: false, error: "member not found" };
    if (room.ownerMemberId !== actingMemberId) return { ok: false, error: "only the room owner can remove a member" };
    member.state = "removed";
    member.quietUntilInvited = true;
    room.sinks.delete(memberId);
    return { ok: true };
  }

  function attach(roomId: string, memberId: string, send: (event: RoomRelayEvent) => void): (() => void) | null {
    const room = rooms.get(roomId);
    const member = room?.members.get(memberId);
    if (!room || !member || member.state !== "active") return null;
    const sinks = room.sinks.get(memberId) ?? new Set<(event: RoomRelayEvent) => void>();
    sinks.add(send);
    room.sinks.set(memberId, sinks);
    return () => { sinks.delete(send); if (sinks.size === 0) room.sinks.delete(memberId); };
  }

  function publish(roomId: string, actorMemberId: string, input: { eventId?: string; kind: RoomEventKind; payload: string }): RoomRelayResult {
    const room = rooms.get(roomId);
    const actor = room?.members.get(actorMemberId);
    if (!room || !actor || actor.state !== "active") return { ok: false, error: "active room membership is required" };
    if (input.payload.length > 64 * 1024) return { ok: false, error: "room payload is too large" };
    const eventId = input.eventId ?? newId();
    if (room.seen.has(eventId)) return { ok: false, error: "room event was replayed" };
    room.seen.add(eventId);
    // A room that stays open runs this forever; without a cap the replay-guard set grows without bound. Only the most
    // recent MAX_SEEN ids need remembering to catch a genuine replay -- Set preserves insertion order, so the oldest is
    // whichever key iteration yields first.
    if (room.seen.size > MAX_SEEN) room.seen.delete(room.seen.values().next().value as string);
    const event: RoomRelayEvent = { roomId, sequence: ++room.sequence, eventId, actorMemberId, kind: input.kind, payload: input.payload };
    for (const [memberId, sinks] of room.sinks) {
      const destination = room.members.get(memberId);
      if (!destination || destination.state !== "active") continue;
      for (const sink of sinks) sink({ ...event });
    }
    return { ok: true };
  }

  function members(roomId: string): RoomMember[] { return [...(rooms.get(roomId)?.members.values() ?? [])].map((member) => ({ ...member })); }
  return { create, requestJoin, admit, remove, attach, publish, members };
}
