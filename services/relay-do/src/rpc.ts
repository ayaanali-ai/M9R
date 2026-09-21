import type { MissionRelayServiceOptions } from "../../../src/lib/mission/mission-relay-service";
import type { Env } from "./env";

const RPC_TIMEOUT_MS = 15_000;

/**
 * Every database-backed operation of the Relay is one call to the web app. The web side runs the very
 * same functions the container Relay ran in-process (`createProductionMissionRelayOptions`), so
 * error messages and results are unchanged; a failed op is rethrown as an Error and the service turns
 * it into the same `relay.error` it always did.
 */
export function webRpcOptions(env: Env): MissionRelayServiceOptions {
  async function call<T>(op: string, input: unknown): Promise<T> {
    const response = await env.WEB.fetch(env.WEB_RPC_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${env.RELAY_INTERNAL_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ op, input }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    type RpcBody = { ok?: boolean; result?: unknown; error?: { message?: string } };
    const body: RpcBody | null = await response.json().then((value) => value as RpcBody, () => null);
    if (!response.ok && response.status !== 200) throw new Error(body?.error?.message ?? `Relay backend unavailable (${response.status}).`);
    if (!body?.ok) throw new Error(body?.error?.message ?? "Relay request failed.");
    return body.result as T;
  }
  return {
    authenticator: { authenticate: (input) => call("authenticate", input) },
    loadMissionSnapshot: (input) => call("loadMissionSnapshot", input),
    loadWorkspaceSnapshot: (input) => call("loadWorkspaceSnapshot", input),
    postMessage: (input) => call("postMessage", input),
    postWorkspaceMessage: (input) => call("postWorkspaceMessage", input),
    receiveWorkspaceTiming: async (input) => { await call("receiveWorkspaceTiming", input); },
    acknowledgeDelivery: async (input) => { await call("acknowledgeDelivery", input); },
    receiveRuntimeEvent: (input) => call("receiveRuntimeEvent", input),
    receiveBridgeHeartbeat: async (input) => { await call("receiveBridgeHeartbeat", input); },
    resolvePtyOwnerHuman: (agentConnectionId) => call("resolvePtyOwnerHuman", { agentConnectionId }),
  };
}
