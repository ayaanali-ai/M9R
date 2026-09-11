import { isMissionFeatureEnabled, type MissionFeatureFlagEnvironment } from "./mission-feature-flags";
import { createSupabaseMissionRuntimeEventJournal } from "./mission-runtime-event-store-supabase";
import type { MissionRuntimeEventJournal } from "./mission-runtime-event";
import type { MissionRuntimeActivityRelay } from "./mission-runtime-activity-relay";
import { MissionDispatchRuntime, type MissionDispatchRuntimeConfig } from "./mission-dispatch-runtime";
import { MissionRuntimeWorker, type MissionRuntimeWorkerConfig } from "./mission-runtime-worker";
import { RealExecutionHost, type RealExecutionHostConfig } from "./mission-real-execution-host";
import type { MissionExecutionResultStore } from "./mission-execution-result-store";
import { MissionAcceptedResultService } from "./mission-accepted-result-service";
import type { MissionExecutionResultProcessor } from "./mission-execution-result-processor";

/**
 * Production composition for the existing one-shot Mission circuit.
 *
 * The process host is supplied by the local/supervised runtime. The factory
 * never forwards a Supabase client, service key, or server credential into a
 * provider invocation; the provider sees only the bounded assignment and its
 * isolated worktree.
 */
export interface MissionRuntimeProductionConfig {
  executionHost: RealExecutionHostConfig;
  dispatch: Omit<MissionDispatchRuntimeConfig, "host" | "processHost" | "runtimeEventJournal" | "acceptedResultBoundary" | "runtimeActivityRelay">;
  worker: Omit<MissionRuntimeWorkerConfig, "runtime" | "schedulerStore">;
  runtimeEventJournal?: MissionRuntimeEventJournal;
  runtimeActivityRelay?: MissionRuntimeActivityRelay;
  executionResultStore?: MissionExecutionResultStore;
  resultProcessor?: MissionExecutionResultProcessor;
  environment?: MissionFeatureFlagEnvironment;
}

export function createProductionMissionRuntime(config: MissionRuntimeProductionConfig): {
  host: RealExecutionHost;
  runtime: MissionDispatchRuntime;
  worker: MissionRuntimeWorker;
} {
  const host = new RealExecutionHost(config.executionHost);
  const runtimeEventJournal = config.runtimeEventJournal
    ?? (isMissionFeatureEnabled("runtimeEvents", config.environment) ? createSupabaseMissionRuntimeEventJournal() : undefined);
  const acceptedResultBoundary = config.executionResultStore ? new MissionAcceptedResultService(config.executionResultStore) : undefined;
  const runtime = new MissionDispatchRuntime({
    ...config.dispatch,
    host,
    processHost: config.executionHost.processHost,
    runtimeEventJournal,
    acceptedResultBoundary,
    runtimeActivityRelay: config.runtimeActivityRelay,
  });
  const worker = new MissionRuntimeWorker({
    ...config.worker,
    runtime,
    schedulerStore: config.dispatch.store,
    resultProcessor: config.resultProcessor,
  });
  return { host, runtime, worker };
}
