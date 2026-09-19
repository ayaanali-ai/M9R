import { Container, getContainer } from "@cloudflare/containers";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";

export interface Env {
  MISSION_BRIDGE_CONTAINER: DurableObjectNamespace<MissionBridgeContainer>;
  ACP_BRIDGE_ENABLED: string;
  MISSION_DEV_MCP_TOOLS_ENABLED: string;
  MISSION_ACP_SESSIONS_JSON: string;
  MISSION_WORKSPACE_ID: string;
  MISSION_APP_PUBLIC_URL: string;
  MISSION_RELAY_PUBLIC_URL: string;
  MISSION_RELAY_BRIDGE_TOKEN: string;
  MISSION_AGENT_TOKEN: string;
  MISSION_BRIDGE_INSTANCE_ID: string;
  MISSION_REPOSITORY_ROOT: string;
  MISSION_REPOSITORY_ID: string;
  PORT: string;
}

const BRIDGE_INSTANCE_ID = "m9r-bridge-staging";

export class MissionBridgeContainer extends Container {
  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = "24h";
  enableInternet = true;

  override async onStart(): Promise<void> {
    console.log("[MissionBridgeContainer] Container started");
  }

  override async onStop(): Promise<void> {
    console.log("[MissionBridgeContainer] Container stopping gracefully");
  }

  override async onError(error: unknown): Promise<void> {
    console.error("[MissionBridgeContainer] Container error:", error);
  }

  override async onActivityExpired(): Promise<void> {
    console.log("[MissionBridgeContainer] Activity expired check - keeping alive for stateful Bridge");
    // Do not call stop()/destroy() - keeps container alive indefinitely
  }
}

function definedEnv(vars: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(vars).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""));
}

async function getBridgeContainer(env: Env) {
  return getContainer(env.MISSION_BRIDGE_CONTAINER, BRIDGE_INSTANCE_ID);
}

async function ensureBridgeStarted(env: Env): Promise<void> {
  const container = await getBridgeContainer(env);

  try {
    await container.startAndWaitForPorts({
      startOptions: {
        envVars: definedEnv({
          ACP_BRIDGE_ENABLED: env.ACP_BRIDGE_ENABLED,
          MISSION_DEV_MCP_TOOLS_ENABLED: env.MISSION_DEV_MCP_TOOLS_ENABLED,
          MISSION_ACP_SESSIONS_JSON: env.MISSION_ACP_SESSIONS_JSON,
          MISSION_WORKSPACE_ID: env.MISSION_WORKSPACE_ID,
          MISSION_APP_PUBLIC_URL: env.MISSION_APP_PUBLIC_URL,
          MISSION_RELAY_PUBLIC_URL: env.MISSION_RELAY_PUBLIC_URL,
          MISSION_RELAY_BRIDGE_TOKEN: env.MISSION_RELAY_BRIDGE_TOKEN,
          MISSION_AGENT_TOKEN: env.MISSION_AGENT_TOKEN,
          MISSION_REPOSITORY_ROOT: env.MISSION_REPOSITORY_ROOT,
          MISSION_REPOSITORY_ID: env.MISSION_REPOSITORY_ID,
          PORT: "8080",
        }),
        enableInternet: true,
      },
    });
    console.log("[MissionBridge] Container started and ready");
  } catch (e) {
    console.error("[MissionBridge] Failed to start container:", e);
    throw e;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    await ensureBridgeStarted(env);
    const container = await getBridgeContainer(env);

    return container.fetch(request);
  },
} satisfies ExportedHandler<Env>;