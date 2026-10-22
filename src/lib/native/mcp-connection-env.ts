export interface M9rMcpConnectionConfig {
  provider?: string;
  bindingId?: string;
  processId?: number;
  /** Optional provider-supplied canonical session id; private host metadata only. */
  sessionId?: string;
}

function positiveProcessId(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/**
 * Reads the provider binding inputs once, before a stdio supervisor starts.
 *
 * The top-level supervisor may use its immediate provider-parent PID as a
 * recovery selector even when the provider name is present. The worker must
 * never infer ownership from its own supervisor parent; it receives the
 * already-resolved PID explicitly through `mcpWorkerEnvironment` instead.
 * `bindConnectionForProcess` still requires exactly one durable claim for
 * that PID, so this never falls back to choosing an arbitrary provider
 * session.
 */
export function readM9rMcpConnectionConfig(
  env: Record<string, string | undefined>,
  parentProcessId?: number,
): M9rMcpConnectionConfig {
  const provider = env.M9R_PROVIDER?.trim() || undefined;
  const bindingId = env.M9R_CONNECTION_BINDING_ID?.trim() || undefined;
  const explicitProcessId = positiveProcessId(env.M9R_CONNECTION_PROCESS_ID);
  const rawSessionId = env.M9R_PROVIDER_SESSION_ID?.trim() || env.M9R_SESSION_ID?.trim();
  const sessionId = rawSessionId && rawSessionId.length <= 256 && !/[\u0000-\u001f\u007f]/.test(rawSessionId)
    ? rawSessionId : undefined;
  const isWorker = env.M9R_MCP_WORKER === "1";
  const processId = explicitProcessId
    ?? (!isWorker && !bindingId ? positiveProcessId(parentProcessId) : undefined);
  return {
    ...(provider ? { provider } : {}),
    ...(bindingId ? { bindingId } : {}),
    ...(processId ? { processId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

/**
 * Carries the already-resolved connection identity across the private MCP
 * supervisor boundary. Do not rely only on an enumerable process.env spread:
 * the explicit fields make the compiled/SEA worker contract inspectable and
 * keep reconnect behavior independent of a provider-specific launcher.
 */
export function mcpWorkerEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  connection: M9rMcpConnectionConfig,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    M9R_MCP_WORKER: "1",
    ...(connection.provider ? { M9R_PROVIDER: connection.provider } : {}),
    ...(connection.bindingId ? { M9R_CONNECTION_BINDING_ID: connection.bindingId } : {}),
    ...(connection.processId ? { M9R_CONNECTION_PROCESS_ID: String(connection.processId) } : {}),
    ...(connection.sessionId ? { M9R_PROVIDER_SESSION_ID: connection.sessionId } : {}),
  };
}
