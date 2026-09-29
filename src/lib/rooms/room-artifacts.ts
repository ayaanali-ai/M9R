export interface RoomArtifactEvent {
  id: string;
  sequence: number | string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface RoomArtifact {
  id: string;
  title: string;
  content: string;
  eventId: string;
  sequence: number;
}

/** Fold the append-only artifact snapshots into the current ordered room documents. */
export function projectRoomArtifacts(events: readonly RoomArtifactEvent[]): RoomArtifact[] {
  const artifacts = new Map<string, RoomArtifact>();
  for (const event of events) {
    if (event.kind !== "artifact" || !["created", "updated"].includes(String(event.payload.type))) continue;
    const id = typeof event.payload.artifactId === "string" ? event.payload.artifactId : "";
    const title = typeof event.payload.title === "string" ? event.payload.title : "";
    const content = typeof event.payload.content === "string" ? event.payload.content : null;
    const sequence = Number(event.sequence);
    if (!id || !title || content === null || !Number.isSafeInteger(sequence) || sequence < 0) continue;
    const prior = artifacts.get(id);
    if (prior && prior.sequence >= sequence) continue;
    artifacts.set(id, { id, title, content, eventId: event.id, sequence });
  }
  return [...artifacts.values()].sort((left, right) => left.sequence - right.sequence);
}
