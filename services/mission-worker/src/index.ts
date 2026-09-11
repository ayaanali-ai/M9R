import { resolve } from "node:path";
import { supabase } from "../../../src/lib/supabase";
import { isMissionFeatureEnabled } from "../../../src/lib/mission/mission-feature-flags";
import { MissionCollaborationResultBridge } from "../../../src/lib/mission/mission-collaboration-result-bridge";
import { createSupabaseMissionCommandPersistence } from "../../../src/lib/mission/mission-command-persistence";
import { createSupabaseMissionEventReader } from "../../../src/lib/mission/mission-store-supabase";
import { runMissionCommandDurable } from "../../../src/lib/mission/mission-runtime-durable";
import { createSupabaseMissionDispatchSource } from "../../../src/lib/mission/mission-dispatch-source-supabase";
import { createSupabaseMissionSchedulerStore } from "../../../src/lib/mission/mission-scheduler-store-supabase";
import { SupabaseMissionExecutionResultStore } from "../../../src/lib/mission/mission-execution-result-store-supabase";
import { MissionExecutionResultProcessor } from "../../../src/lib/mission/mission-execution-result-processor";
import { SupabaseMissionPendingMessageSource } from "../../../src/lib/mission/mission-pending-message-source";
import { createProductionMissionRuntime } from "../../../src/lib/mission/mission-runtime-production";
import { NodeProcessExecutionHost } from "../../../src/lib/mission/mission-process-host-node";
import { ProviderAdapterRegistry } from "../../../src/lib/mission/mission-provider-registry";
import { CodexProviderAdapter } from "../../../src/lib/mission/mission-provider-adapter-codex";
import { ClaudeCodeProviderAdapter } from "../../../src/lib/mission/mission-provider-adapter-claude-code";
import { DEFAULT_SCHEDULER_POLICY, type LeaseHolder } from "../../../src/lib/mission/mission-scheduler";
import { PROVIDER_CAPABILITIES, type ProviderCapability } from "../../../src/lib/mission/mission-provider-adapter";
import { MissionRelayClient } from "../../../src/lib/mission/mission-relay-client";
import { MissionRelayRuntimeActivityRelay } from "../../../src/lib/mission/mission-relay-activity-relay";
import type { CommandContext, MissionCommand } from "../../../src/lib/mission/mission-commands";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the Mission worker.`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function websocketUrl(value: string): string {
  if (value.startsWith("https://")) return `wss://${value.slice("https://".length)}`;
  if (value.startsWith("http://")) return `ws://${value.slice("http://".length)}`;
  return value;
}

function requiredCapabilities(): ProviderCapability[] {
  const requested = (process.env.MISSION_WORKER_REQUIRED_CAPABILITIES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return requested.filter((value): value is ProviderCapability => (PROVIDER_CAPABILITIES as readonly string[]).includes(value));
}

if (process.env.MISSION_WORKER_ENABLED?.trim().toLowerCase() !== "true") {
  throw new Error("Mission worker is fail-closed. Set MISSION_WORKER_ENABLED=true before starting it.");
}
if (!supabase) throw new Error("Mission worker requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
if (!isMissionFeatureEnabled("runtimeEvents")) throw new Error("Mission worker requires MISSION_RUNTIME_EVENTS_ENABLED=true so activity remains durable and observable.");

const workspaceIds = [...new Set(required("MISSION_WORKSPACE_IDS").split(",").map((value) => value.trim()).filter(Boolean))];
if (workspaceIds.length === 0) throw new Error("MISSION_WORKSPACE_IDS must contain at least one workspace id.");

const repositoryRoot = resolve(process.env.MISSION_REPOSITORY_ROOT?.trim() || process.cwd());
const schedulerStore = createSupabaseMissionSchedulerStore();
const source = createSupabaseMissionDispatchSource(workspaceIds);
const reader = createSupabaseMissionEventReader();
const commandPersistence = createSupabaseMissionCommandPersistence();
const pendingMessageSource = new SupabaseMissionPendingMessageSource(reader);
const holder: LeaseHolder = { kind: "system", id: "scheduler" };
const policy = { ...DEFAULT_SCHEDULER_POLICY };
type DurableCommandInput = { command: MissionCommand; context: CommandContext; idempotencyKey: string; workspaceId: string };
const commandPort = {
  run: async (input: DurableCommandInput) => {
    const result = await runMissionCommandDurable({ reader, persistence: commandPersistence, ...input });
    return { ok: result.ok };
  },
};
const collaborationResultBridge = new MissionCollaborationResultBridge(commandPort);
const executionResultStore = new SupabaseMissionExecutionResultStore(supabase);
const resultProcessor = new MissionExecutionResultProcessor({
  store: executionResultStore,
  commandPort,
  clock: () => new Date().toISOString(),
  retryDelayMs: (retryCount) => Math.min(60_000, 2_000 * 2 ** Math.min(retryCount, 5)),
});

const registry = new ProviderAdapterRegistry();
registry.register(new CodexProviderAdapter());
registry.register(new ClaudeCodeProviderAdapter());
const processHost = new NodeProcessExecutionHost({ hostIdentity: process.env.MISSION_WORKER_HOST_ID?.trim() || `mission-worker-${process.pid}` });

let relayClient: MissionRelayClient | null = null;
let runtimeActivityRelay: MissionRelayRuntimeActivityRelay | undefined;
if (isMissionFeatureEnabled("missionRelay") && process.env.MISSION_RELAY_BRIDGE_TOKEN && process.env.MISSION_RELAY_PUBLIC_URL) {
  relayClient = new MissionRelayClient({
    url: websocketUrl(process.env.MISSION_RELAY_PUBLIC_URL),
    workspaceId: workspaceIds[0],
    credential: process.env.MISSION_RELAY_BRIDGE_TOKEN,
  });
  runtimeActivityRelay = new MissionRelayRuntimeActivityRelay(relayClient);
} else {
  console.warn("Mission worker live Relay mirror is disabled; durable runtime activity remains enabled.");
}

const { worker } = createProductionMissionRuntime({
  executionHost: {
    processHost,
    registry,
    schedulerStore,
    repositoryRef: repositoryRoot,
    requiredCapabilities: requiredCapabilities(),
  },
  dispatch: {
    store: schedulerStore,
    holder,
    policy,
    collaborationResultBridge,
    pendingMessageSource,
  },
  worker: {
    source,
    holder,
    policy,
    candidateBatchSize: positiveInteger("MISSION_WORKER_CANDIDATE_BATCH_SIZE", 25),
    pollIntervalMs: positiveInteger("MISSION_WORKER_POLL_INTERVAL_MS", 5_000),
    resultProcessor,
  },
  runtimeActivityRelay,
});

let stopping = false;
const wait = (ms: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, ms));

async function run(): Promise<void> {
  console.log(`Mission worker supervising ${workspaceIds.length} workspace(s) from ${repositoryRoot}.`);
  while (!stopping) {
    try {
      await worker.runOnce();
    } catch (error) {
      console.error("Mission worker cycle failed; retrying after the bounded delay.", error instanceof Error ? error.message : error);
    }
    if (!stopping) await wait(positiveInteger("MISSION_WORKER_POLL_INTERVAL_MS", 5_000));
  }
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await relayClient?.close().catch(() => {});
  process.exit(0);
}

process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
void run();
