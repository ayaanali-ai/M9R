import { Container, getContainer } from "@cloudflare/containers";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";

export interface Env {
  MISSION_WORKER_CONTAINER: DurableObjectNamespace<MissionWorkerContainer>;
  NEXT_PUBLIC_SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  MISSION_RELAY_PUBLIC_URL: string;
  MISSION_RELAY_BRIDGE_TOKEN: string;
  MISSION_WORKSPACE_IDS: string;
  MISSION_REPOSITORY_ROOT: string;
  MISSION_REPOSITORY_ID: string;
  MISSION_WORKER_REQUIRED_CAPABILITIES: string;
  MISSION_WORKER_HOST_ID: string;
  MISSION_WORKER_CANDIDATE_BATCH_SIZE: string;
  MISSION_WORKER_POLL_INTERVAL_MS: string;
  MISSION_RUNTIME_EVENTS_ENABLED: string;
  MISSION_WORKER_INSTANCE_ID: string;
  MISSION_WORKER_CONTROL_TOKEN?: string;
}

const WORKER_INSTANCE_ID = "m9r-worker-staging";

export class MissionWorkerContainer extends Container {
  sleepAfter = "24h";
  enableInternet = true;

  override async onStart(): Promise<void> {
    console.log("[MissionWorkerContainer] Container started");
  }

  override async onStop(): Promise<void> {
    console.log("[MissionWorkerContainer] Container stopping gracefully");
  }

  override async onError(error: unknown): Promise<void> {
    console.error("[MissionWorkerContainer] Container error:", error);
  }

  override async onActivityExpired(): Promise<void> {
    console.log("[MissionWorkerContainer] Activity expired check - keeping alive for background worker");
    // Do not call stop()/destroy() - keeps container alive indefinitely
  }
}

function definedEnv(vars: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(vars).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""));
}

async function getWorkerContainer(env: Env) {
  return getContainer(env.MISSION_WORKER_CONTAINER, WORKER_INSTANCE_ID);
}

async function startWorkerIfNeeded(env: Env): Promise<void> {
  const container = await getWorkerContainer(env);

  try {
    await container.start({
        envVars: definedEnv({
          MISSION_WORKER_ENABLED: env.MISSION_WORKER_ENABLED,
          MISSION_RUNTIME_EVENTS_ENABLED: env.MISSION_RUNTIME_EVENTS_ENABLED,
          MISSION_RELAY_PUBLIC_URL: env.MISSION_RELAY_PUBLIC_URL,
          MISSION_RELAY_BRIDGE_TOKEN: env.MISSION_RELAY_BRIDGE_TOKEN,
          MISSION_WORKSPACE_IDS: env.MISSION_WORKSPACE_IDS,
          MISSION_REPOSITORY_ROOT: env.MISSION_REPOSITORY_ROOT,
          MISSION_REPOSITORY_ID: env.MISSION_REPOSITORY_ID,
          MISSION_WORKER_REQUIRED_CAPABILITIES: env.MISSION_WORKER_REQUIRED_CAPABILITIES,
          MISSION_WORKER_HOST_ID: env.MISSION_WORKER_HOST_ID,
          MISSION_WORKER_CANDIDATE_BATCH_SIZE: env.MISSION_WORKER_CANDIDATE_BATCH_SIZE,
          MISSION_WORKER_POLL_INTERVAL_MS: env.MISSION_WORKER_POLL_INTERVAL_MS,
          NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
        }),
        enableInternet: true,
    });
    console.log("[MissionWorker] Container started and ready");
  } catch (e) {
    console.error("[MissionWorker] Failed to start container:", e);
    throw e;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      const state = await (await getWorkerContainer(env)).getState();
      return new Response(JSON.stringify({ status: state.status }), { status: state.status === "running" || state.status === "healthy" ? 200 : 503, headers: { "content-type": "application/json" } });
    }

    if (url.pathname === "/internal/start" || url.pathname === "/internal/stop") {
      const expected = env.MISSION_WORKER_CONTROL_TOKEN;
      if (!expected || request.headers.get("authorization") !== `Bearer ${expected}`) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
      }
    }

    if (request.method === "POST" && url.pathname === "/internal/start") {
      await startWorkerIfNeeded(env);
      return new Response(JSON.stringify({ started: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (request.method === "POST" && url.pathname === "/internal/stop") {
      const container = await getWorkerContainer(env);
      await container.stop();
      return new Response(JSON.stringify({ stopped: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    if (event.cron === "*/5 * * * *") {
      await startWorkerIfNeeded(env);
    }
  },
} satisfies ExportedHandler<Env>;