export const ROOM_LOG_SCHEMA = "m9r.room-log/0" as const;
export const ROOM_LOG_MAX_EVENTS = 10_000;

type ActorKind = "human" | "agent";
type Target = { pageGroupId: string; origin: string; path: string; tabRef: string };
type RoomEvent = {
  eventId: string;
  roomId: string;
  sequence: number;
  actorId: string;
  actorKind: ActorKind;
  type: string;
  target?: Target;
  dependsOn?: string[];
  recipientActorId?: string;
  replyTo?: string;
  relatedEventId?: string;
};
type PageGroup = {
  pageGroupId: string;
  origin: string;
  path: string;
  ownerConfirmed: true;
  members: Array<{ actorId: string; tabRef: string }>;
};

export interface RoomLitmusCriteria {
  dependentAgentAction: boolean;
  agentQuestionAnswered: boolean;
  noHumanRelay: boolean;
  sameSharedPageGroup: boolean;
  completeTrace: boolean;
}

export interface RoomLitmusResult {
  pass: boolean;
  criteria: RoomLitmusCriteria;
  reasons: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const boundedString = (value: unknown, max = 256): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

function parseTarget(value: unknown): Target | null {
  if (!isRecord(value) || !boundedString(value.pageGroupId) || !boundedString(value.origin, 2048) || !boundedString(value.path, 2048) || !boundedString(value.tabRef)) return null;
  let origin: URL;
  try { origin = new URL(value.origin); }
  catch { return null; }
  if ((origin.protocol !== "https:" && origin.protocol !== "http:") || origin.origin !== value.origin || origin.username || origin.password) return null;
  if (!value.path.startsWith("/") || value.path.includes("?") || value.path.includes("#")) return null;
  return { pageGroupId: value.pageGroupId, origin: value.origin, path: value.path, tabRef: value.tabRef };
}

function parseEvent(value: unknown): RoomEvent | null {
  if (!isRecord(value) || !boundedString(value.eventId) || !boundedString(value.roomId) || !boundedString(value.actorId) || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) return null;
  if (value.actorKind !== "human" && value.actorKind !== "agent") return null;
  if (!boundedString(value.type, 64)) return null;
  const event: RoomEvent = {
    eventId: value.eventId,
    roomId: value.roomId,
    sequence: value.sequence as number,
    actorId: value.actorId,
    actorKind: value.actorKind,
    type: value.type,
  };
  if (value.target !== undefined) {
    const target = parseTarget(value.target);
    if (!target) return null;
    event.target = target;
  }
  if (value.dependsOn !== undefined) {
    if (!Array.isArray(value.dependsOn) || value.dependsOn.length > 64 || !value.dependsOn.every((entry) => boundedString(entry))) return null;
    event.dependsOn = value.dependsOn;
  }
  for (const field of ["recipientActorId", "replyTo", "relatedEventId"] as const) {
    if (value[field] !== undefined) {
      if (!boundedString(value[field])) return null;
      event[field] = value[field];
    }
  }
  return event;
}

function parsePageGroups(value: unknown): PageGroup[] | null {
  if (!Array.isArray(value) || value.length > 1_000) return null;
  const groups: PageGroup[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !boundedString(entry.pageGroupId) || !boundedString(entry.origin, 2048) || !boundedString(entry.path, 2048) || entry.ownerConfirmed !== true || !Array.isArray(entry.members) || entry.members.length > 100) return null;
    const members: Array<{ actorId: string; tabRef: string }> = [];
    for (const member of entry.members) {
      if (!isRecord(member) || !boundedString(member.actorId) || !boundedString(member.tabRef)) return null;
      members.push({ actorId: member.actorId, tabRef: member.tabRef });
    }
    groups.push({ pageGroupId: entry.pageGroupId, origin: entry.origin, path: entry.path, ownerConfirmed: true, members });
  }
  return groups;
}

function result(criteria: RoomLitmusCriteria, reasons: string[]): RoomLitmusResult {
  return { pass: Object.values(criteria).every(Boolean), criteria, reasons };
}

/**
 * Checks a bounded, causal room export. This verifies recorded evidence, not
 * the truth of actions outside the exporting components. Message-only exports
 * deliberately fail the complete-trace requirement.
 */
export function checkRoomLitmus(input: unknown): RoomLitmusResult {
  const criteria: RoomLitmusCriteria = {
    dependentAgentAction: false,
    agentQuestionAnswered: false,
    noHumanRelay: false,
    sameSharedPageGroup: false,
    completeTrace: false,
  };
  const reasons: string[] = [];
  if (!isRecord(input) || input.schema !== ROOM_LOG_SCHEMA || !boundedString(input.roomId) || !Array.isArray(input.events) || input.events.length === 0 || input.events.length > ROOM_LOG_MAX_EVENTS) {
    return result(criteria, ["Room log schema, roomId, or bounded events list is invalid."]);
  }
  if (input.traceCoverage === "complete") criteria.completeTrace = true;
  else reasons.push("The export does not declare a complete causal-action trace; message-only history cannot prove the litmus.");
  const groups = parsePageGroups(input.pageGroups);
  if (!groups) return result(criteria, [...reasons, "Page-group attestations are malformed."]);
  const events = input.events.map(parseEvent);
  if (events.some((event) => event === null)) return result(criteria, [...reasons, "An event is malformed or exceeds a field limit."]);
  const parsed = events as RoomEvent[];
  const roomId = input.roomId;
  if (parsed.some((event) => event.roomId !== roomId)) return result(criteria, [...reasons, "Events from a different room are not accepted."]);
  const ids = new Set<string>();
  let priorSequence = 0;
  for (const event of parsed) {
    if (ids.has(event.eventId)) return result(criteria, [...reasons, "Duplicate event IDs indicate replay or an invalid export."]);
    ids.add(event.eventId);
    if (event.sequence <= priorSequence) return result(criteria, [...reasons, "Room events must have strictly increasing sequence numbers."]);
    priorSequence = event.sequence;
  }
  const byId = new Map(parsed.map((event) => [event.eventId, event]));

  const isAttestedTarget = (event: RoomEvent): boolean => {
    const target = event.target;
    if (!target) return false;
    const group = groups.find((candidate) => candidate.pageGroupId === target.pageGroupId && candidate.origin === target.origin && candidate.path === target.path && candidate.ownerConfirmed);
    return Boolean(group?.members.some((member) => member.actorId === event.actorId && member.tabRef === target.tabRef));
  };
  const actions = parsed.filter((event) => event.type === "agent.action" && event.actorKind === "agent");
  for (const action of actions) {
    if (!action.target || !isAttestedTarget(action)) continue;
    for (const dependencyId of action.dependsOn ?? []) {
      const dependency = byId.get(dependencyId);
      if (!dependency || dependency.type !== "agent.action" || dependency.actorKind !== "agent" || dependency.actorId === action.actorId || !dependency.target || !isAttestedTarget(dependency)) continue;
      if (dependency.target.pageGroupId === action.target.pageGroupId && dependency.target.origin === action.target.origin && dependency.target.path === action.target.path) {
        const group = groups.find((candidate) => candidate.pageGroupId === action.target!.pageGroupId);
        const hasDistinctTabs = Boolean(group?.members.some((member) => member.actorId === action.actorId && member.tabRef === action.target!.tabRef)
          && group?.members.some((member) => member.actorId === dependency.actorId && member.tabRef === dependency.target!.tabRef)
          && action.target.tabRef !== dependency.target.tabRef);
        if (hasDistinctTabs) {
          criteria.dependentAgentAction = true;
          criteria.sameSharedPageGroup = true;
          break;
        }
      }
    }
    if (criteria.dependentAgentAction) break;
  }

  const asks = parsed.filter((event) => event.type === "agent.ask" && event.actorKind === "agent" && event.recipientActorId && event.actorId !== event.recipientActorId);
  const directExchange = asks.find((ask) => parsed.some((reply) => reply.type === "agent.reply"
    && reply.actorKind === "agent"
    && reply.replyTo === ask.eventId
    && reply.actorId === ask.recipientActorId
    && reply.actorId !== ask.actorId));
  if (directExchange) {
    const reply = parsed.find((event) => event.type === "agent.reply" && event.replyTo === directExchange.eventId && event.actorId === directExchange.recipientActorId);
    const relayed = parsed.some((event) => event.type === "human.relay"
      && event.actorKind === "human"
      && (event.relatedEventId === directExchange.eventId || event.relatedEventId === reply?.eventId));
    criteria.noHumanRelay = !relayed;
    criteria.agentQuestionAnswered = !relayed;
  }

  if (!criteria.dependentAgentAction) reasons.push("No cross-agent action has an explicit causal dependency on another agent's action at the same owner-confirmed page group.");
  if (!criteria.agentQuestionAnswered) reasons.push("No direct agent-to-agent ask and linked reply were recorded.");
  if (!criteria.noHumanRelay && criteria.agentQuestionAnswered === false) reasons.push("A human relay appears between the agents or the ask/reply is not directly linked.");
  if (criteria.agentQuestionAnswered && !criteria.noHumanRelay) reasons.push("A human relay event links the ask or reply.");
  if (!criteria.sameSharedPageGroup) reasons.push("The dependent actions are not bound to the same explicitly paired page group across distinct local tabs.");
  return result(criteria, reasons);
}
