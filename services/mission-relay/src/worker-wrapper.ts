import { Container, getContainer } from "@cloudflare/containers";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";

export interface Env {
  MISSION_RELAY_CONTAINER: DurableObjectNamespace<MissionRelayContainer>;
  MISSION_RELAY_TOKEN_SECRET: string;
  NEXT_PUBLIC_SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  MISSION_RELAY_PUBLIC_URL: string;
  MISSION_RELAY_INSTANCE_ID: string;
  M9R_JEV_MODE?: string;
  TYPESAFE_API_KEY?: string;
}

const RELAY_INSTANCE_ID = "m9r-relay-staging";

export class MissionRelayContainer extends Container {
  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = "24h";
  enableInternet = true;

  override async onStart(): Promise<void> {
    console.log("[MissionRelayContainer] Container started");
  }

  override async onStop(): Promise<void> {
    console.log("[MissionRelayContainer] Container stopping gracefully");
  }

  override async onError(error: unknown): Promise<void> {
    console.error("[MissionRelayContainer] Container error:", error);
  }

  override async onActivityExpired(): Promise<void> {
    console.log("[MissionRelayContainer] Activity expired check - keeping alive for stateful Relay");
    // Do not call stop()/destroy() - keeps container alive indefinitely
  }
}

async function getRelayContainer(env: Env) {
  return getContainer(env.MISSION_RELAY_CONTAINER, RELAY_INSTANCE_ID);
}

function respondJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function authorizedBearer(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  const digest = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [expected, supplied] = await Promise.all([digest(`Bearer ${secret}`), digest(request.headers.get("authorization") ?? "")]);
  return crypto.subtle.timingSafeEqual(expected, supplied);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const container = await getRelayContainer(env);

    // Container env vars are fixed at start, so rotating a secret needs a restart.
    if (request.method === "POST" && new URL(request.url).pathname === "/internal/restart") {
      if (!(await authorizedBearer(request, env.MISSION_RELAY_TOKEN_SECRET))) return respondJson(401, { error: "unauthorized" });
      await container.destroy();
      return respondJson(200, { restarting: true });
    }

    try {
      await container.startAndWaitForPorts({
        startOptions: {
          envVars: {
            MISSION_RELAY_TOKEN_SECRET: env.MISSION_RELAY_TOKEN_SECRET,
            NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
            SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
            MISSION_RELAY_PUBLIC_URL: env.MISSION_RELAY_PUBLIC_URL,
            MISSION_RELAY_HOST: "0.0.0.0",
            MISSION_RELAY_PORT: "8080",
            ...(env.M9R_JEV_MODE ? { M9R_JEV_MODE: env.M9R_JEV_MODE } : {}),
            ...(env.TYPESAFE_API_KEY ? { TYPESAFE_API_KEY: env.TYPESAFE_API_KEY } : {}),
          },
          enableInternet: true,
        },
      });
    } catch (e) {
      console.error("[Worker] Failed to start Relay container:", e);
      return respondJson(503, { error: "Relay container unavailable" });
    }

    // The container enforces its own auth on /internal/* and on WebSocket upgrades,
    // so forward the original request (headers, body, upgrade) untouched.
    return container.fetch(request);
  },
} satisfies ExportedHandler<Env>;
