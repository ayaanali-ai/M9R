import type { MissionRuntimeActivity } from "./mission-runtime-activity";

export interface MissionRuntimeActivityRelay {
  publish(activities: readonly MissionRuntimeActivity[]): Promise<{ published: number; duplicates: number }>;
  subscribe(listener: (activity: MissionRuntimeActivity) => void | Promise<void>): () => void;
}

export interface MissionRuntimeActivityReader {
  listActivities(input: { workspaceId: string; missionId: string; participantId?: string | null; limit?: number }): Promise<MissionRuntimeActivity[]>;
}

/**
 * Deterministic relay seam for Mission Workspace and a future ACP/WebSocket
 * transport. It is deliberately fed only after the durable runtime journal
 * succeeds, and it deduplicates by workspace/activity identity.
 */
export class InMemoryMissionRuntimeActivityRelay implements MissionRuntimeActivityRelay {
  private readonly seen = new Set<string>();
  private readonly activities: MissionRuntimeActivity[] = [];
  private readonly listeners = new Set<(activity: MissionRuntimeActivity) => void | Promise<void>>();

  async publish(activities: readonly MissionRuntimeActivity[]): Promise<{ published: number; duplicates: number }> {
    let published = 0;
    let duplicates = 0;
    for (const activity of activities) {
      const key = `${activity.workspaceId}:${activity.activityId}`;
      if (this.seen.has(key)) {
        duplicates += 1;
        continue;
      }
      this.seen.add(key);
      this.activities.push(activity);
      await Promise.all([...this.listeners].map((listener) => listener(activity)));
      published += 1;
    }
    return { published, duplicates };
  }

  subscribe(listener: (activity: MissionRuntimeActivity) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): MissionRuntimeActivity[] {
    return [...this.activities];
  }

  async listActivities(input: { workspaceId: string; missionId: string; participantId?: string | null; limit?: number }): Promise<MissionRuntimeActivity[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    return this.activities
      .filter((activity) => activity.workspaceId === input.workspaceId && activity.missionId === input.missionId && (input.participantId == null || activity.participantId === input.participantId))
      .slice(-limit)
      .reverse();
  }
}
