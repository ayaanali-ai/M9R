import type { MissionRuntimeActivity } from "./mission-runtime-activity";
import type { MissionRuntimeActivityRelay } from "./mission-runtime-activity-relay";
import { MissionRelayClient } from "./mission-relay-client";

/**
 * Worker-side live activity mirror. The durable runtime journal remains the
 * source of truth; Relay publication is best-effort fan-out after that write
 * and never changes execution or lease outcomes.
 */
export class MissionRelayRuntimeActivityRelay implements MissionRuntimeActivityRelay {
  private readonly seen = new Set<string>();
  private readonly listeners = new Set<(activity: MissionRuntimeActivity) => void | Promise<void>>();
  private readonly client: MissionRelayClient;

  constructor(client: MissionRelayClient) {
    this.client = client;
  }

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
      await this.client.publishRuntimeActivity({ workspaceId: activity.workspaceId, missionId: activity.missionId, activity });
      await Promise.all([...this.listeners].map((listener) => listener(activity)));
      published += 1;
    }
    return { published, duplicates };
  }

  subscribe(listener: (activity: MissionRuntimeActivity) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
