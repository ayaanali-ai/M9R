import { MISSION_RELAY_MAX_PAYLOAD_BYTES } from "./mission-relay-protocol";

const WORKSPACE_SNAPSHOT_TARGET_BYTES = MISSION_RELAY_MAX_PAYLOAD_BYTES - 512;
const MAX_REACTIONS_PER_MESSAGE = 20;

export interface BoundedWorkspaceSnapshotInput {
  conversation: Record<string, unknown>;
  messages: readonly Record<string, unknown>[];
  participants: readonly string[];
  activity: readonly Record<string, unknown>[];
  cursor: string | null;
  incremental: boolean;
}

export interface BoundedWorkspaceSnapshot {
  conversation: Record<string, unknown>;
  messages: Record<string, unknown>[];
  participants: string[];
  activity: Record<string, unknown>[];
  cursor: string | null;
  incremental: boolean;
}

function utf8ByteLength(value: string): number {
  return typeof Buffer !== "undefined" ? Buffer.byteLength(value, "utf8") : new TextEncoder().encode(value).byteLength;
}

function fits(value: BoundedWorkspaceSnapshot): boolean {
  return utf8ByteLength(JSON.stringify(value)) <= WORKSPACE_SNAPSHOT_TARGET_BYTES;
}

/**
 * Keep relay snapshots below the protocol budget without dropping the oldest
 * unseen message. The caller advances the cursor from the last message that
 * actually made it into this page, so a later reconnect can continue paging.
 */
export function buildBoundedWorkspaceSnapshot(input: BoundedWorkspaceSnapshotInput): BoundedWorkspaceSnapshot {
  const snapshot: BoundedWorkspaceSnapshot = {
    conversation: input.conversation,
    messages: [],
    participants: [...input.participants],
    activity: [],
    cursor: input.cursor,
    incremental: input.incremental,
  };

  for (const message of input.messages) {
    const reactions = Array.isArray(message.reactions) ? message.reactions.slice(0, MAX_REACTIONS_PER_MESSAGE) : [];
    const candidate = { ...message, reactions };
    const withReactions = [...snapshot.messages, candidate];
    snapshot.messages = withReactions;
    if (!fits(snapshot)) {
      snapshot.messages = [...snapshot.messages.slice(0, -1), { ...candidate, reactions: [] }];
      if (!fits(snapshot)) {
        snapshot.messages = snapshot.messages.slice(0, -1);
        break;
      }
    }
  }

  for (const item of input.activity) {
    const candidate = [...snapshot.activity, item];
    snapshot.activity = candidate;
    if (!fits(snapshot)) {
      snapshot.activity = snapshot.activity.slice(0, -1);
      break;
    }
  }

  return snapshot;
}
