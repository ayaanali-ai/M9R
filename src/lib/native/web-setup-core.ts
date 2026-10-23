import { DETECTABLE_AGENT_KINDS, type DetectedAgent, type DetectableAgentKind } from "../agent-detection-core";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { chooseOpenCodeModelFromCatalog } from "./opencode-model-core";

export type WebOpenCodeLayout = "legacy" | "servers";
export type WebSetupBrowser = "chrome" | "edge";
export type WebConfigUninstallMode = "restore-backup" | "remove-managed-entry" | "delete-created-file" | "unchanged";
export type WebExtensionFileAction = "write" | "preserve" | "unchanged" | "delete";

/** Stable unpacked-development identity. The Web Store assigns its own production ID. */
export const WEB_EXTENSION_ID = "mahhaigfogjneccbmbpbedlnkhgdcmhb";
/** Set after the Chrome Web Store assigns the production extension ID. */
export const WEB_STORE_EXTENSION_ID_ENV = "M9R_WEB_STORE_EXTENSION_ID";

/** Prefer the active OpenCode config layout (including the legacy ~/.opencode layout),
 * then XDG/APPDATA fallbacks, with plugins beside the selected config.
 *
 * OpenCode updates can leave both supported config spellings in the same
 * directory. The provider may select either spelling on its next start, so
 * returning only the first file would leave a stale M9R route behind. The
 * selected directory is still a single, deterministic boundary; callers can
 * reconcile every existing config in that directory without touching an
 * unrelated fallback directory.
 */
export function resolveOpenCodeGlobalPaths(input: {
  home: string;
  xdgConfigHome?: string;
  appData?: string;
  exists?: (path: string) => boolean;
}): { configPath: string; configPaths: string[]; pluginDirectory: string } {
  const configHome = input.xdgConfigHome?.trim() || join(input.home, ".config");
  const configDirectory = join(configHome, "opencode");
  const configDirectories = [
    configDirectory,
    ...(input.appData?.trim() ? [join(input.appData.trim(), "opencode")] : []),
    join(input.home, ".opencode"),
  ];
  const supportedNames = ["opencode.jsonc", "opencode.json"] as const;
  const exists = input.exists ?? (() => false);
  const selectedDirectory = configDirectories.find((directory) =>
    supportedNames.some((name) => exists(join(directory, name)))
  ) ?? configDirectory;
  const configPaths = supportedNames
    .map((name) => join(selectedDirectory, name))
    .filter((path) => exists(path));
  const configPath = configPaths[0] ?? join(selectedDirectory, "opencode.json");
  return {
    configPath,
    configPaths: configPaths.length > 0 ? configPaths : [configPath],
    pluginDirectory: join(dirname(configPath), "plugins"),
  };
}

/** Browser-internal setup pages are opened only when the user supplies the explicit opt-in. */
export function shouldOpenBrowserSetup(args: readonly string[]): boolean {
  return args.includes("--open-browser-setup");
}

export const OPENCODE_IDENTITY_PLUGIN_FILENAME = "m9r-identity.js";
/**
 * Legacy M9R entry retained only so upgrades/uninstall can remove an entry
 * written by older installers. Current OpenCode versions auto-discover a
 * managed plugin placed in the global plugins directory; injecting a
 * file-shaped config entry makes newer versions warn that the target must be
 * a directory and can prevent the plugin from loading after an update.
 */
export const OPENCODE_IDENTITY_PLUGIN_CONFIG_ENTRY = `./plugins/${OPENCODE_IDENTITY_PLUGIN_FILENAME}`;

export interface OpenCodeHookInvocation {
  command: string;
  args: readonly string[];
}

/** Prefer the standalone engine so the plugin invokes the same native hook flows as installed hooks. */
export function resolveOpenCodeHookInvocation(input: {
  nodeCommand: string;
  engineExecutable?: string;
  compiledHookPath?: string;
  sourceHookPath?: string;
  sourceNodeArgs?: readonly string[];
  /** OpenCode also polls an active session and acknowledges accepted live prompts. */
  event?: "SessionStart" | "UserPromptSubmit" | "OpenCodePoll" | "OpenCodeDelivered" | "OpenCodeDeliveryFailed" | "OpenCodeExecutionFailed";
}): OpenCodeHookInvocation {
  const event = input.event ?? "SessionStart";
  if (input.engineExecutable?.trim()) {
    return {
      command: input.engineExecutable,
      args: ["m9r-hook", event, "opencode"],
    };
  }
  if (input.compiledHookPath) {
    return {
      command: input.nodeCommand,
      args: [input.compiledHookPath, event, "opencode"],
    };
  }
  if (input.sourceHookPath) {
    return {
      command: input.nodeCommand,
      args: [...(input.sourceNodeArgs ?? []), input.sourceHookPath, event, "opencode"],
    };
  }
  throw new Error(`The M9R OpenCode ${event} hook entry point was not found beside this CLI or in the local M9R installation.`);
}

/** Accept only the additionalContext field returned for a session or prompt-time hook. */
export function extractOpenCodeAdditionalContext(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const hookOutput = (parsed as Record<string, unknown>).hookSpecificOutput;
    if (!hookOutput || typeof hookOutput !== "object" || Array.isArray(hookOutput)) return null;
    const record = hookOutput as Record<string, unknown>;
    return (record.hookEventName === "SessionStart" || record.hookEventName === "UserPromptSubmit"
      || record.hookEventName === "OpenCodePoll" || record.hookEventName === "OpenCodeDelivered"
      || record.hookEventName === "OpenCodeDeliveryFailed" || record.hookEventName === "OpenCodeExecutionFailed")
      && typeof record.additionalContext === "string" && record.additionalContext.length > 0
      ? record.additionalContext
      : null;
  } catch {
    return null;
  }
}

export type OpenCodeIdentityPluginInstallAction = "install" | "upgrade" | "unchanged" | "preserve" | "path-changed";

export function planOpenCodeIdentityPluginInstall(input: {
  targetPath: string;
  currentHash: string | null;
  desiredHash: string;
  ownedPath?: string;
  ownedHash?: string;
}): OpenCodeIdentityPluginInstallAction {
  if (input.ownedPath && input.ownedPath !== input.targetPath) return "path-changed";
  if (input.currentHash === null) return "install";
  if (!input.ownedPath || !input.ownedHash || input.currentHash !== input.ownedHash) return "preserve";
  return input.currentHash === input.desiredHash ? "unchanged" : "upgrade";
}

export type OpenCodeIdentityPluginRemovalAction = "remove" | "already-absent" | "preserve" | "not-owned" | "path-changed";

export function planOpenCodeIdentityPluginRemoval(input: {
  targetPath: string;
  currentHash: string | null;
  ownedPath?: string;
  ownedHash?: string;
}): OpenCodeIdentityPluginRemovalAction {
  if (!input.ownedPath || !input.ownedHash) return "not-owned";
  if (input.ownedPath !== input.targetPath) return "path-changed";
  if (input.currentHash === null) return "already-absent";
  return input.currentHash === input.ownedHash ? "remove" : "preserve";
}

/**
 * Serialize a helper into the standalone OpenCode plugin without carrying
 * bundler-only annotations into the user's runtime. The source is generated
 * from the running TypeScript module, and esbuild can append __name(...) calls
 * to local declarations. Those calls are harmless in the bundled module but
 * undefined in the standalone plugin loaded by OpenCode.
 */
function serializeGeneratedFunction(fn: { toString(): string }): string {
  return fn.toString()
    .replace(/^function /, "function ")
    .replace(/\s*__name\([A-Za-z_$][\w$]*,\s*["'][^"']+["']\);?/g, "");
}

/** Build a self-contained OpenCode plugin; parse the hook response before injecting its one trusted field. */
export function buildOpenCodeIdentityPluginSource(
  invocation: OpenCodeHookInvocation,
  promptInvocation?: OpenCodeHookInvocation,
  pollInvocation?: OpenCodeHookInvocation,
  deliveredInvocation?: OpenCodeHookInvocation,
  deliveryFailedInvocation?: OpenCodeHookInvocation,
  executionFailedInvocation?: OpenCodeHookInvocation,
): string {
  const prompt = promptInvocation ?? { command: invocation.command, args: ["m9r-hook", "UserPromptSubmit", "opencode"] };
  const poll = pollInvocation ?? { command: invocation.command, args: ["m9r-hook", "OpenCodePoll", "opencode"] };
  const delivered = deliveredInvocation ?? { command: invocation.command, args: ["m9r-hook", "OpenCodeDelivered", "opencode"] };
  const deliveryFailed = deliveryFailedInvocation ?? { command: invocation.command, args: ["m9r-hook", "OpenCodeDeliveryFailed", "opencode"] };
  const executionFailed = executionFailedInvocation ?? { command: invocation.command, args: ["m9r-hook", "OpenCodeExecutionFailed", "opencode"] };
  const parser = serializeGeneratedFunction(extractOpenCodeAdditionalContext);
  const modelSelector = serializeGeneratedFunction(chooseOpenCodeModelFromCatalog);
  return `import { spawn } from "node:child_process";

const M9R_HOOK_COMMAND = ${JSON.stringify(invocation.command)};
const M9R_HOOK_ARGS = ${JSON.stringify(invocation.args)};
const M9R_HOOK_PROMPT_COMMAND = ${JSON.stringify(prompt.command)};
const M9R_HOOK_PROMPT_ARGS = ${JSON.stringify(prompt.args)};
const M9R_HOOK_POLL_COMMAND = ${JSON.stringify(poll.command)};
const M9R_HOOK_POLL_ARGS = ${JSON.stringify(poll.args)};
const M9R_HOOK_DELIVERED_COMMAND = ${JSON.stringify(delivered.command)};
const M9R_HOOK_DELIVERED_ARGS = ${JSON.stringify(delivered.args)};
const M9R_HOOK_DELIVERY_FAILED_COMMAND = ${JSON.stringify(deliveryFailed.command)};
const M9R_HOOK_DELIVERY_FAILED_ARGS = ${JSON.stringify(deliveryFailed.args)};
const M9R_HOOK_EXECUTION_FAILED_COMMAND = ${JSON.stringify(executionFailed.command)};
const M9R_HOOK_EXECUTION_FAILED_ARGS = ${JSON.stringify(executionFailed.args)};
const M9R_HOOK_TIMEOUT_MS = 5000;
const M9R_MAX_CACHED_SESSIONS = 256;
const M9R_POLL_INTERVAL_MS = 1500;
const M9R_POLL_RETRY_MS = 5000;
const M9R_SESSION_DISCOVERY_INTERVAL_MS = 5000;
const M9R_IDLE_FAILURE_GRACE_MS = 2000;
const M9R_SESSION_BOOTSTRAPS = new Map();
const M9R_SESSION_POLLERS = new Map();
const M9R_SESSION_DIRECTORIES = new Map();
const M9R_SESSION_DISCOVERY_TIMERS = new Map();
const M9R_ACTIVE_TASKS = new Map();

${parser}

${modelSelector}

function runM9rHook(command, args, sessionID, cwd, extra = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let oversized = false;
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(null);
    }, M9R_HOOK_TIMEOUT_MS);
    timeout.unref?.();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length + chunk.length > 262144) {
        oversized = true;
        child.kill();
        finish(null);
        return;
      }
      stdout += chunk;
    });
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(!oversized && code === 0 ? stdout : null));
    child.stdin.once("error", () => finish(null));
    child.stdin.end(JSON.stringify({ session_id: sessionID, cwd, ...extra }));
  });
}

function runM9rSessionStart(sessionID, cwd) {
  return runM9rHook(M9R_HOOK_COMMAND, M9R_HOOK_ARGS, sessionID, cwd);
}

function runM9rPrompt(sessionID, cwd) {
  // No prompt text leaves the plugin: the hook delivers inbox deltas and results for this session only.
  // An empty turn resolves to null, so ordinary prompts cost one local spawn and zero tokens.
  return runM9rHook(M9R_HOOK_PROMPT_COMMAND, M9R_HOOK_PROMPT_ARGS, sessionID, cwd);
}

function runM9rPoll(sessionID, cwd) {
  return runM9rHook(M9R_HOOK_POLL_COMMAND, M9R_HOOK_POLL_ARGS, sessionID, cwd);
}

function runM9rDelivered(sessionID, cwd, taskID) {
  return runM9rHook(M9R_HOOK_DELIVERED_COMMAND, M9R_HOOK_DELIVERED_ARGS, sessionID, cwd, { task_id: taskID });
}

function runM9rDeliveryFailed(sessionID, cwd, taskID, deliveryError) {
  return runM9rHook(M9R_HOOK_DELIVERY_FAILED_COMMAND, M9R_HOOK_DELIVERY_FAILED_ARGS, sessionID, cwd, {
    task_id: taskID,
    delivery_error: deliveryError,
  });
}

function runM9rExecutionFailed(sessionID, cwd, taskID, executionError, detail) {
  return runM9rHook(M9R_HOOK_EXECUTION_FAILED_COMMAND, M9R_HOOK_EXECUTION_FAILED_ARGS, sessionID, cwd, {
    task_id: taskID,
    execution_error: executionError,
    ...(typeof detail === "string" && detail.length > 0 ? { execution_detail: detail.slice(0, 240) } : {}),
  });
}

function parseOpenCodeTask(raw) {
  const context = typeof raw === "string" ? extractOpenCodeAdditionalContext(raw) : null;
  if (!context || context.length > 32768) return null;
  try {
    const task = JSON.parse(context);
    return task && typeof task === "object" && !Array.isArray(task)
      && typeof task.task_id === "string" && /^T\\d{1,12}$/.test(task.task_id)
      && typeof task.prompt === "string" && task.prompt.length > 0 && task.prompt.length <= 24000
      ? task
      : null;
  } catch {
    return null;
  }
}

function parseOpenCodeDeliveryAck(raw, taskID) {
  const context = typeof raw === "string" ? extractOpenCodeAdditionalContext(raw) : null;
  if (!context || context.length > 4096) return false;
  try {
    const ack = JSON.parse(context);
    return ack && typeof ack === "object" && !Array.isArray(ack)
      && ack.accepted === true && ack.task_id === taskID;
  } catch {
    return false;
  }
}

async function settleOpenCodeTask(sessionID, cwd, entry) {
  if (!entry.pendingSettlement) return false;
  const { taskID, outcome } = entry.pendingSettlement;
  const raw = outcome === "accepted"
    ? await runM9rDelivered(sessionID, cwd, taskID).catch(() => null)
    : await runM9rDeliveryFailed(sessionID, cwd, taskID, outcome).catch(() => null);
  if (!parseOpenCodeDeliveryAck(raw, taskID)) return false;
  entry.pendingSettlement = null;
  return true;
}

function eventSessionID(event) {
  const properties = event?.properties;
  return typeof properties?.sessionID === "string" ? properties.sessionID
    : typeof event?.sessionID === "string" ? event.sessionID
    : null;
}

function eventError(event) {
  const error = event?.properties?.error ?? event?.error;
  if (!error) return "";
  if (typeof error === "string") return error.slice(0, 240);
  if (typeof error?.message === "string") return error.message.slice(0, 240);
  if (typeof error?.name === "string") return error.name.slice(0, 240);
  return "provider execution failed";
}

function messageText(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts.filter((part) => part?.type === "text" && typeof part?.text === "string").map((part) => part.text).join("\\n");
}

function sessionHasAssistantResponse(messages, marker) {
  const items = Array.isArray(messages?.data) ? messages.data : Array.isArray(messages) ? messages : [];
  let markerSeen = false;
  for (const item of items) {
    const info = item?.info ?? item;
    const role = info?.role;
    if (role === "user" && messageText(item).includes(marker)) markerSeen = true;
    if (markerSeen && role === "assistant") {
      if (info?.error) return false;
      return true;
    }
  }
  return false;
}

async function reportOpenCodeExecutionFailure(sessionID, cwd, active, error, detail) {
  if (!active || active.reported) return;
  active.reported = true;
  const raw = await runM9rExecutionFailed(sessionID, cwd, active.taskID, error, detail).catch(() => null);
  if (parseOpenCodeDeliveryAck(raw, active.taskID)) {
    if (active.idleTimer) clearTimeout(active.idleTimer);
    M9R_ACTIVE_TASKS.delete(sessionID);
  } else {
    active.reported = false;
  }
}

function inspectOpenCodeIdle(sessionID, cwd, client, active) {
  if (active.idleTimer || active.reported || typeof client?.session?.messages !== "function") return;
  active.idleTimer = setTimeout(async () => {
    active.idleTimer = null;
    if (M9R_ACTIVE_TASKS.get(sessionID) !== active || active.reported) return;
    try {
      const messages = await client.session.messages({ path: { id: sessionID } });
      if (sessionHasAssistantResponse(messages, active.marker)) {
        M9R_ACTIVE_TASKS.delete(sessionID);
        return;
      }
      await reportOpenCodeExecutionFailure(sessionID, cwd, active, "idle_without_response", "OpenCode became idle without an assistant response.");
    } catch {
      // A failed inspection is not evidence that the provider failed. Keep the
      // task active so a later session event or a fresh idle boundary can retry.
    }
  }, M9R_IDLE_FAILURE_GRACE_MS);
  active.idleTimer.unref?.();
}

function openCodeErrorText(value) {
  const error = value?.error ?? value;
  if (typeof error === "string") return error.slice(0, 400).toLowerCase();
  if (error && typeof error === "object") {
    const message = typeof error.message === "string" ? error.message : "";
    const name = typeof error.name === "string" ? error.name : "";
    return (name + " " + message).trim().slice(0, 400).toLowerCase();
  }
  return "";
}

function isOpenCodeRequestShapeError(value) {
  const text = openCodeErrorText(value);
  return text.length > 0 && /(?:invalid|missing|required|unknown|unexpected).*?(?:request|parameter|property|field|argument|body|path|session|directory)|(?:request|parameter|property|field|argument|body|path|sessionid|directory).*?(?:invalid|missing|required|unknown|unexpected)/.test(text);
}

function openCodeSessionTransport(client) {
  const session = client?.session;
  if (typeof session?.promptAsync === "function") {
    return {
      kind: "promptAsync",
      send: async (sessionID, cwd, text, model) => {
        // Current OpenCode SDKs use the flattened v2 request shape. The
        // directory is part of the session boundary; omitting it can make a
        // resumed session look like an unrelated project after an update.
        const modernInput = {
          sessionID,
          directory: cwd,
          ...(model ? { model } : {}),
          parts: [{ type: "text", text }],
        };
        const legacyInput = {
          path: { id: sessionID },
          body: { parts: [{ type: "text", text }], ...(model ? { model } : {}) },
        };
        const sendLegacy = () => session.promptAsync.call(session, legacyInput);
        // A short-lived provider update can leave an older v1-compatible
        // client behind. Only retry the legacy read-validated shape after a
        // deterministic request-validation error; never retry a network or
        // provider failure, because that could create a duplicate user turn.
        try {
          const modern = await session.promptAsync.call(session, modernInput);
          if (modern?.error && isOpenCodeRequestShapeError(modern)) return sendLegacy();
          return modern;
        } catch (error) {
          if (!isOpenCodeRequestShapeError(error)) throw error;
          return sendLegacy();
        }
      },
    };
  }
  if (typeof session?.chat === "function") {
    return {
      kind: "chat",
      send: (sessionID, _cwd, text, model) => session.chat.call(session, sessionID, {
        ...(model ? { providerID: model.providerID, modelID: model.modelID } : {}),
        parts: [{ type: "text", text }],
      }),
    };
  }
  if (typeof session?.prompt === "function") {
    return {
      kind: "prompt",
      send: (sessionID, _cwd, text, model) => session.prompt.call(session, {
        path: { id: sessionID },
        body: { parts: [{ type: "text", text }], ...(model ? { model } : {}) },
      }),
    };
  }
  return null;
}

async function pollOpenCodeSession(sessionID, cwd, client, entry) {
  const transport = openCodeSessionTransport(client);
  if (entry.polling || Date.now() < entry.retryAfter || !transport) return;
  entry.polling = true;
  try {
    if (entry.pendingSettlement) {
      if (!await settleOpenCodeTask(sessionID, cwd, entry)) entry.retryAfter = Date.now() + M9R_POLL_RETRY_MS;
      return;
    }
    const raw = await runM9rPoll(sessionID, cwd).catch(() => null);
    const task = parseOpenCodeTask(raw);
    if (!task) return;

    // OpenCode's own session API creates a real user turn in this session; this is not inbox text awaiting a future prompt.
    // The server atomically claims before exposing this prompt. Never replay it, including after
    // an ambiguous transport failure: replaying could create a duplicate user turn.
    try {
      const active = { taskID: task.task_id, marker: "[M9R " + task.task_id + "]", idleTimer: null, reported: false };
      M9R_ACTIVE_TASKS.set(sessionID, active);
      let model;
      try {
        const providers = typeof client?.config?.providers === "function" ? await client.config.providers() : null;
        model = chooseOpenCodeModelFromCatalog(providers);
      } catch {
        model = null;
      }
      const response = await transport.send(sessionID, cwd, task.prompt, model);
      if (response?.error) {
        // A synchronous rejection is already terminal. Do not leave an active
        // watcher behind that could later misclassify an unrelated idle event
        // as a second provider failure for this task.
        if (active.idleTimer) clearTimeout(active.idleTimer);
        M9R_ACTIVE_TASKS.delete(sessionID);
      }
      entry.pendingSettlement = { taskID: task.task_id, outcome: response?.error ? "session_rejected" : "accepted" };
    } catch {
      const active = M9R_ACTIVE_TASKS.get(sessionID);
      if (active?.idleTimer) clearTimeout(active.idleTimer);
      M9R_ACTIVE_TASKS.delete(sessionID);
      entry.pendingSettlement = { taskID: task.task_id, outcome: "unknown" };
    }

    if (!await settleOpenCodeTask(sessionID, cwd, entry)) entry.retryAfter = Date.now() + M9R_POLL_RETRY_MS;
  } finally {
    entry.polling = false;
  }
}

function startOpenCodePoller(sessionID, cwd, client) {
  if (M9R_SESSION_POLLERS.has(sessionID) || !openCodeSessionTransport(client)) return;
  if (M9R_SESSION_POLLERS.size >= M9R_MAX_CACHED_SESSIONS) {
    const oldest = M9R_SESSION_POLLERS.keys().next().value;
    if (oldest !== undefined) {
      clearInterval(M9R_SESSION_POLLERS.get(oldest)?.timer);
      M9R_SESSION_POLLERS.delete(oldest);
    }
  }
  const entry = { timer: null, polling: false, pendingSettlement: null, retryAfter: 0 };
  entry.timer = setInterval(() => { void pollOpenCodeSession(sessionID, cwd, client, entry); }, M9R_POLL_INTERVAL_MS);
  entry.timer.unref?.();
  M9R_SESSION_POLLERS.set(sessionID, entry);
  void pollOpenCodeSession(sessionID, cwd, client, entry);
}

function stopOpenCodePoller(sessionID) {
  const entry = M9R_SESSION_POLLERS.get(sessionID);
  if (!entry) return;
  clearInterval(entry.timer);
  M9R_SESSION_POLLERS.delete(sessionID);
}

function wakeOpenCodePoller(sessionID, cwd, client) {
  const entry = M9R_SESSION_POLLERS.get(sessionID);
  if (!entry) {
    startOpenCodePoller(sessionID, cwd, client);
    return;
  }
  void pollOpenCodeSession(sessionID, cwd, client, entry);
}

// OpenCode loads a plugin once per server, while a user can keep several
// sessions open. Discover the live sessions at plugin startup and reconcile
// each session's identity before starting its poller, so a task sent from the
// pill is delivered without waiting for the user to type a prompt or say
// "check the M9R inbox". The identity refresh is deliberately idempotent for
// resumed sessions: the native store reuses the existing session claim instead
// of creating a competing claim. The provider's live-session status filters
// out old, closed sessions; the current transform remains the fallback when
// an older SDK does not expose a safe discovery surface.
function openCodeSessionDirectory(session) {
  const location = session?.location;
  if (typeof session?.directory === "string") return session.directory;
  if (typeof session?.cwd === "string") return session.cwd;
  if (typeof location?.directory === "string") return location.directory;
  if (typeof location?.path === "string") return location.path;
  if (typeof session?.project?.directory === "string") return session.project.directory;
  return typeof location === "string" ? location : null;
}

function openCodeSessionList(value) {
  const root = value?.data ?? value;
  if (Array.isArray(root)) return root;
  if (Array.isArray(root?.sessions)) return root.sessions;
  return [];
}

function openCodeStatusFor(value, sessionID) {
  const root = value?.data ?? value;
  if (!root || typeof root !== "object" || Array.isArray(root)) return root ?? null;
  return Object.prototype.hasOwnProperty.call(root, sessionID) ? root[sessionID] : root;
}

function isOpenCodeLiveStatus(value) {
  const status = typeof value === "string" ? value : value?.type ?? value?.status;
  return ["idle", "busy", "retry", "running", "active", "connected"].includes(String(status ?? "").toLowerCase());
}

async function invokeOpenCodeSessionList(list, session, request) {
  try {
    const direct = await list.call(session, request);
    if (!(direct?.error && isOpenCodeRequestShapeError(direct))) return direct;
  } catch (error) {
    if (!isOpenCodeRequestShapeError(error)) return null;
  }

  // Older SDK wrappers exposed the same endpoint through a nested query
  // object. Only use that shape after the provider explicitly rejects the
  // current request shape; a transport or provider failure must not be
  // replayed against another request shape.
  try {
    return await list.call(session, { query: request });
  } catch {
    return null;
  }
}

async function listOpenCodeSessions(cwd, client) {
  const session = client?.session;
  const list = session?.list;
  if (typeof list !== "function") return null;

  // Current OpenCode exposes a provider-wide session list. Do not scope this
  // request to the plugin server's cwd: a single server may own sessions from
  // several projects, and the provider's session record is the authoritative
  // owner of each session directory.
  const providerWide = await invokeOpenCodeSessionList(list, session, { limit: 100 });
  if (providerWide !== null && !(providerWide?.error && isOpenCodeRequestShapeError(providerWide))) {
    return { value: providerWide, directoryScoped: false };
  }

  // Compatibility path for older SDKs that require a directory on the list
  // request. This is intentionally bounded to the server cwd and is marked so
  // callers may safely use that cwd when an older response omits its directory.
  const scoped = await invokeOpenCodeSessionList(list, session, { directory: cwd, limit: 100 });
  return scoped === null ? null : { value: scoped, directoryScoped: true };
}

async function readOpenCodeSessionStatus(sessionID, cwd, client, data) {
  const dataStatus = data?.session?.status;
  if (typeof dataStatus === "function") {
    try {
      const value = await dataStatus.call(data.session, sessionID);
      if (value !== undefined && value !== null) return value;
    } catch {
      // Fall through to the client status surface when available.
    }
  }

  const session = client?.session;
  const status = session?.status;
  if (typeof status !== "function") return null;
  try {
    const modern = await status.call(session, { sessionID, directory: cwd });
    if (modern?.error && isOpenCodeRequestShapeError(modern)) return status.call(session, { query: { directory: cwd } });
    return modern;
  } catch (error) {
    if (!isOpenCodeRequestShapeError(error)) return null;
    return status.call(session, { query: { directory: cwd } }).catch(() => null);
  }
}

async function startKnownOpenCodeSessions(cwd, client, data) {
  try {
    // OpenCode can load the plugin before its session API is ready, and a
    // provider update can briefly replace that API while keeping the process
    // and its sessions alive. Do not make the first failed discovery a
    // permanent loss of automatic delivery.
    const listedResult = await listOpenCodeSessions(cwd, client);
    if (listedResult === null || listedResult.value?.error) return;
    const sessions = openCodeSessionList(listedResult.value);
    for (const session of sessions) {
      const sessionID = session?.id;
      if (typeof sessionID !== "string" || sessionID.length === 0 || session?.time?.archived) continue;
      const sessionCwd = openCodeSessionDirectory(session) ?? (listedResult.directoryScoped ? cwd : null);
      if (!sessionCwd) continue;
      M9R_SESSION_DIRECTORIES.set(sessionID, sessionCwd);
      const status = await readOpenCodeSessionStatus(sessionID, sessionCwd, client, data);
      if (!isOpenCodeLiveStatus(openCodeStatusFor(status, sessionID))) continue;
      // A provider service can hot-reload this plugin without recreating its
      // already-open sessions. Re-publish the session claim before polling so
      // the MCP connection cannot remain transport-connected but anonymous
      // after an M9R or provider update.
      await bootstrapSession(sessionID, sessionCwd);
      startOpenCodePoller(sessionID, sessionCwd, client);
    }
  } catch {
    // A server can be ready before its session endpoint; the active transform
    // will still start a poller for the session that is actually in use.
  } finally {
    // Keep discovery alive while the provider process is resident. This is a
    // bounded local reconciliation loop, not inbox polling: it only asks the
    // provider for its active sessions and starts an M9R poller for sessions
    // that the provider itself reports as live. The timer is unref'd so it
    // cannot keep a shutting-down provider alive.
    scheduleKnownOpenCodeSessions(cwd, client, data);
  }
}

function scheduleKnownOpenCodeSessions(cwd, client, data, delay = M9R_SESSION_DISCOVERY_INTERVAL_MS) {
  if (M9R_SESSION_DISCOVERY_TIMERS.has(cwd)) return;
  const timer = setTimeout(() => {
    M9R_SESSION_DISCOVERY_TIMERS.delete(cwd);
    void startKnownOpenCodeSessions(cwd, client, data);
  }, delay);
  timer.unref?.();
  M9R_SESSION_DISCOVERY_TIMERS.set(cwd, timer);
}

function bootstrapSession(sessionID, cwd) {
  if (typeof cwd === "string" && cwd.length > 0) M9R_SESSION_DIRECTORIES.set(sessionID, cwd);
  const cached = M9R_SESSION_BOOTSTRAPS.get(sessionID);
  if (cached) {
    M9R_SESSION_BOOTSTRAPS.delete(sessionID);
    M9R_SESSION_BOOTSTRAPS.set(sessionID, cached);
    return cached.promise;
  }

  if (M9R_SESSION_BOOTSTRAPS.size >= M9R_MAX_CACHED_SESSIONS) {
    const oldestSettled = [...M9R_SESSION_BOOTSTRAPS.entries()].find(([, entry]) => entry.settled);
    if (!oldestSettled) return Promise.resolve(null);
    M9R_SESSION_BOOTSTRAPS.delete(oldestSettled[0]);
  }

  const entry = { promise: null, settled: false };
  const promise = Promise.resolve()
    .then(() => runM9rSessionStart(sessionID, cwd))
    .then((raw) => typeof raw === "string" ? extractOpenCodeAdditionalContext(raw) : null)
    .catch(() => null)
    .then((context) => {
      entry.settled = true;
      if (context === null && M9R_SESSION_BOOTSTRAPS.get(sessionID) === entry) {
        M9R_SESSION_BOOTSTRAPS.delete(sessionID);
      }
      return context;
    });
  entry.promise = promise;
  M9R_SESSION_BOOTSTRAPS.set(sessionID, entry);
  return promise;
}

async function handleOpenCodeEvent(cwd, client, event) {
  const normalized = event?.details ?? event;
  const sessionID = eventSessionID(normalized);
  if (!sessionID) return;
  const eventDirectory = openCodeSessionDirectory(normalized?.properties?.session ?? normalized?.properties ?? normalized);
  const sessionCwd = eventDirectory ?? M9R_SESSION_DIRECTORIES.get(sessionID) ?? cwd;
  if (typeof sessionCwd === "string" && sessionCwd.length > 0) M9R_SESSION_DIRECTORIES.set(sessionID, sessionCwd);

  // A plugin can remain loaded while OpenCode creates, resumes, or compacts a
  // session. Reconcile those lifecycle boundaries immediately so delivery does
  // not depend on a later user prompt or an explicit inbox check. Compaction
  // deliberately refreshes the hook card: the native store treats the repeat
  // as a trusted continuation and reuses the existing claim instead of
  // issuing a competing provider identity.
  if (normalized?.type === "session.created" || normalized?.type === "session.compacted") {
    if (normalized.type === "session.compacted") M9R_SESSION_BOOTSTRAPS.delete(sessionID);
    await bootstrapSession(sessionID, sessionCwd);
    wakeOpenCodePoller(sessionID, sessionCwd, client);
    return;
  }

  if (normalized?.type === "session.deleted") {
    stopOpenCodePoller(sessionID);
    M9R_SESSION_BOOTSTRAPS.delete(sessionID);
    M9R_SESSION_DIRECTORIES.delete(sessionID);
    const deleted = M9R_ACTIVE_TASKS.get(sessionID);
    if (deleted) await reportOpenCodeExecutionFailure(sessionID, sessionCwd, deleted, "session_deleted", "OpenCode session was deleted before the M9R task completed.");
    return;
  }

  const active = M9R_ACTIVE_TASKS.get(sessionID);
  if (!active) return;
  if (normalized?.type === "session.error") {
    await reportOpenCodeExecutionFailure(sessionID, sessionCwd, active, "provider_execution_failed", eventError(normalized));
    return;
  }
  if (normalized?.type === "message.updated" && normalized?.properties?.info?.role === "assistant" && normalized?.properties?.info?.error) {
    await reportOpenCodeExecutionFailure(sessionID, sessionCwd, active, "provider_execution_failed", eventError(normalized));
    return;
  }
  if (normalized?.type === "session.idle") inspectOpenCodeIdle(sessionID, sessionCwd, client, active);
}

async function setupM9rOpenCodeV2(ctx = {}) {
  const cwd = typeof ctx?.location?.directory === "string" && ctx.location.directory.length > 0
    ? ctx.location.directory
    : typeof ctx?.directory === "string" && ctx.directory.length > 0
      ? ctx.directory
      : process.cwd();
  const client = ctx?.client ?? ctx;
  const legacy = await M9rIdentity({ directory: cwd, client, data: ctx?.data });

  if (typeof ctx?.session?.hook === "function") {
    await ctx.session.hook("context", async (event) => {
      const sessionID = event?.sessionID;
      if (typeof sessionID !== "string" || sessionID.length === 0) return;
      const output = { system: [] };
      await legacy["experimental.chat.system.transform"]({ sessionID }, output);
      if (!Array.isArray(event?.system)) return;
      for (const context of output.system) {
        if (typeof context === "string" && context.length > 0) event.system.push({ type: "text", text: context });
      }
    });
  }

  const subscribe = ctx?.event?.subscribe;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  if (typeof subscribe === "function") {
    try {
      const stream = await subscribe.call(ctx.event, controller ? { signal: controller.signal } : undefined);
      if (stream && typeof stream[Symbol.asyncIterator] === "function") {
        void (async () => {
          try {
            for await (const event of stream) await handleOpenCodeEvent(cwd, client, event);
          } catch {
            // Event delivery is advisory; the session hook remains the source of truth for task work.
          }
        })();
      }
    } catch {
      // A server can expose the V2 event stream after setup; do not block prompt handling on it.
    }
  }

  return () => {
    controller?.abort();
    for (const timer of M9R_SESSION_DISCOVERY_TIMERS.values()) clearTimeout(timer);
    M9R_SESSION_DISCOVERY_TIMERS.clear();
    for (const entry of M9R_SESSION_POLLERS.values()) clearInterval(entry.timer);
    M9R_SESSION_POLLERS.clear();
    M9R_SESSION_BOOTSTRAPS.clear();
    M9R_SESSION_DIRECTORIES.clear();
  };
}

export const M9rIdentity = async ({ directory, client, data } = {}) => {
  const cwd = typeof directory === "string" && directory.length > 0 ? directory : process.cwd();
  void startKnownOpenCodeSessions(cwd, client, data);
  return {
  event: async ({ event } = {}) => {
    await handleOpenCodeEvent(cwd, client, event);
  },
  "experimental.chat.system.transform": async (input, output) => {
    const sessionID = input?.sessionID;
    if (typeof sessionID !== "string" || sessionID.length === 0) return;
    const sessionCwd = M9R_SESSION_DIRECTORIES.get(sessionID) ?? cwd;
    const context = await bootstrapSession(sessionID, sessionCwd);
    if (context !== null && Array.isArray(output?.system)) output.system.push(context);
    // Prompt-time delivery: inbox deltas and answers for this session, like other providers' prompt hooks.
    // Fail-silent by design: a broken or slow hook must never block, slow, or pollute the turn.
    const promptContext = await runM9rPrompt(sessionID, sessionCwd)
      .then((raw) => typeof raw === "string" ? extractOpenCodeAdditionalContext(raw) : null)
      .catch(() => null);
    if (promptContext !== null && Array.isArray(output?.system)) output.system.push(promptContext);
    startOpenCodePoller(sessionID, sessionCwd, client);
  },
  };
};

const M9rOpenCodePlugin = {
  id: "m9r-identity",
  setup: setupM9rOpenCodeV2,
  server: M9rIdentity,
};

export default M9rOpenCodePlugin;
`;
}

/** One canonical allow-list source for setup, bundled broker, and the CLI broker. */
export function webExtensionAllowlist(input: {
  developmentId?: string;
  storeId?: string;
} = {}): string[] {
  const developmentId = input.developmentId ?? WEB_EXTENSION_ID;
  const storeId = input.storeId ?? process.env[WEB_STORE_EXTENSION_ID_ENV]?.trim();
  if (!/^[a-p]{32}$/.test(developmentId)) throw new Error("The M9R development extension ID is invalid.");
  if (storeId && !/^[a-p]{32}$/.test(storeId)) throw new Error(`${WEB_STORE_EXTENSION_ID_ENV} must be a valid 32-character Chromium extension ID.`);
  return [...new Set([developmentId, ...(storeId ? [storeId] : [])])];
}

export function extensionIdFromManifestKey(key: string): string {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return digest.replace(/[0-9a-f]/g, (character) => String.fromCharCode(97 + Number.parseInt(character, 16)));
}

export interface WebMcpCommand {
  command: string;
  args: readonly string[];
  m9rHome: string;
  brokerPort?: number;
}

export function resolveWebMcpRuntime(input: {
  nodeCommand: string;
  installedEngine?: string;
  currentEngine?: string;
  compiledMcp?: string;
  sourceMcp?: string;
  sourceNodeArgs?: readonly string[];
}): Pick<WebMcpCommand, "command" | "args"> {
  if (input.installedEngine) return { command: input.installedEngine, args: ["mcp"] };
  if (input.currentEngine) return { command: input.currentEngine, args: ["mcp"] };
  if (input.compiledMcp) return { command: input.nodeCommand, args: [input.compiledMcp] };
  if (input.sourceMcp) return { command: input.nodeCommand, args: [...(input.sourceNodeArgs ?? []), input.sourceMcp] };
  throw new Error("M9R's MCP entry point was not found beside this CLI or in the local M9R installation.");
}

export interface WebSetupInput {
  detected: readonly DetectedAgent[];
  selectedAgents: readonly string[];
  engineCommand: string;
  mcpArgs: readonly string[];
  m9rHome: string;
  configPaths: Partial<Record<DetectableAgentKind, string>>;
  extensionPath: string;
  browsers: readonly WebSetupBrowser[];
  extensionId: string;
}

export interface WebSetupPlan {
  selectedAgents: DetectableAgentKind[];
  agentFiles: Array<{ agent: DetectableAgentKind; path: string; layout?: WebOpenCodeLayout }>;
  extensionPath: string;
  browsers: WebSetupBrowser[];
  allowedExtensionIds: string[];
  m9rHome: string;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

const AGENT_LABELS: Record<DetectableAgentKind, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export function selectWebSetupAgents(detected: readonly DetectedAgent[], requested?: readonly string[]): DetectableAgentKind[] {
  const available = new Set(detected.map((agent) => agent.kind));
  const selected = requested === undefined ? DETECTABLE_AGENT_KINDS.filter((kind) => available.has(kind)) : [...new Set(requested)];
  for (const value of selected) {
    if (!(DETECTABLE_AGENT_KINDS as readonly string[]).includes(value)) throw new Error(`Unknown agent "${value}". Choose claude-code, codex, or opencode.`);
    const kind = value as DetectableAgentKind;
    if (!available.has(kind)) throw new Error(`${AGENT_LABELS[kind]} was requested but not found on PATH.`);
  }
  if (selected.length === 0) throw new Error("No installed agents selected. Install Claude Code, Codex, or OpenCode, then run setup again.");
  return selected as DetectableAgentKind[];
}

/** OpenCode 2.x moved local servers from `mcp.<name>` into `mcp.servers.<name>`. */
export function webOpenCodeLayout(versionLine: string | undefined): WebOpenCodeLayout {
  const match = versionLine?.match(/(?:^|\s)v?(\d+)\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?/i);
  return match && Number(match[1]) >= 2 ? "servers" : "legacy";
}

export function buildClaudeMcpAddArgs(command: WebMcpCommand): string[] {
  return [
    "mcp", "add", "--scope", "user", "--transport", "stdio", "m9r",
    "--env", `M9R_HOME=${command.m9rHome}`,
    "--env", `M9R_WEB_BROKER_PORT=${command.brokerPort ?? 47821}`,
    "--", command.command, ...command.args,
  ];
}

export function buildClaudeMcpRemoveArgs(): string[] {
  return ["mcp", "remove", "m9r", "--scope", "user"];
}

/** PowerShell single-quoted literals preserve Windows paths and shell metacharacters as ordinary argument text. */
export function buildPowerShellInvocation(binary: string, args: readonly string[]): string {
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const invocation = `& ${[binary, ...args].map(literal).join(" ")}`;
  return `$ErrorActionPreference = 'Stop'; ${invocation}; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`;
}

/** Human-readable equivalent of a native CLI argv vector for the setup preview. */
export function formatCommandPreview(binary: string, args: readonly string[]): string {
  return [binary, ...args].map((value) => /\s|["']/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value).join(" ");
}

export function planWebSetup(input: WebSetupInput): WebSetupPlan {
  if (!isAbsolutePath(input.engineCommand) || !isAbsolutePath(input.m9rHome) || !isAbsolutePath(input.extensionPath)) throw new Error("The engine command, extension path, and M9R_HOME must be absolute paths.");
  const selectedAgents = selectWebSetupAgents(input.detected, input.selectedAgents);
  const detected = new Map(input.detected.map((agent) => [agent.kind, agent]));
  const agentFiles = selectedAgents.map((agent) => {
    const path = input.configPaths[agent];
    if (!path || !isAbsolutePath(path)) throw new Error(`No absolute user config path was resolved for ${AGENT_LABELS[agent]}.`);
    return {
      agent,
      path,
      ...(agent === "opencode" ? { layout: webOpenCodeLayout(detected.get(agent)?.versionLine) } : {}),
    };
  });
  if (!/^[a-p]{32}$/.test(input.extensionId)) throw new Error("The browser extension ID is invalid.");
  return {
    selectedAgents,
    agentFiles,
    extensionPath: input.extensionPath,
    browsers: [...new Set(input.browsers)],
    allowedExtensionIds: webExtensionAllowlist({ developmentId: input.extensionId }),
    m9rHome: input.m9rHome,
  };
}

/** Selects a non-destructive uninstall action from hashes, never by comparing or printing user config contents. */
export function webConfigUninstallMode(input: {
  existedBefore: boolean;
  currentHash: string | null;
  installedHash: string | null;
}): WebConfigUninstallMode {
  if (!input.installedHash || !input.currentHash) return "unchanged";
  if (input.currentHash !== input.installedHash) return "remove-managed-entry";
  return input.existedBefore ? "restore-backup" : "delete-created-file";
}

/** Update only files still matching M9R's prior hash; never claim or overwrite untracked/user-edited files. */
export function webExtensionFileAction(input: {
  currentHash: string | null;
  installedHash: string | null;
  desiredHash?: string | null;
}): WebExtensionFileAction {
  if (input.currentHash === null) return input.desiredHash ? "write" : "unchanged";
  if (!input.installedHash || input.currentHash !== input.installedHash) return "preserve";
  if (!input.desiredHash) return "delete";
  return input.currentHash === input.desiredHash ? "unchanged" : "write";
}

export type ManagedWebExtensionSourceFile = { relativePath: string; desiredHash: string };
export type ManagedWebExtensionInstalledFile = { relativePath: string; installedHash: string };
export type ManagedWebExtensionRefreshPlan = {
  relativePath: string;
  desiredHash: string | null;
  installedHash: string | null;
  currentHash: string | null;
  action: WebExtensionFileAction;
};

/** Plan an extension-only refresh without claiming or overwriting untracked/user-edited files. */
export function planManagedWebExtensionRefresh(input: {
  sourceFiles: readonly ManagedWebExtensionSourceFile[];
  installedFiles: readonly ManagedWebExtensionInstalledFile[];
  currentHashes: ReadonlyMap<string, string | null>;
}): ManagedWebExtensionRefreshPlan[] {
  const normalizeRelativePath = (raw: string): string => {
    const path = raw.replace(/\\/g, "/");
    const segments = path.split("/");
    if (!path || path.startsWith("/") || /^[a-z]:/i.test(path) || segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error(`Unsafe managed extension relative path: ${raw}`);
    }
    return segments.join("/");
  };
  const installed = new Map<string, string>();
  for (const file of input.installedFiles) {
    const path = normalizeRelativePath(file.relativePath);
    if (installed.has(path)) throw new Error(`Duplicate managed extension path: ${path}`);
    installed.set(path, file.installedHash);
  }
  const seen = new Set<string>();
  const plan: ManagedWebExtensionRefreshPlan[] = input.sourceFiles.map((file) => {
    const relativePath = normalizeRelativePath(file.relativePath);
    if (seen.has(relativePath)) throw new Error(`Duplicate extension source path: ${relativePath}`);
    seen.add(relativePath);
    if (!file.desiredHash) throw new Error(`Missing desired hash for extension source path: ${relativePath}`);
    const currentHash = input.currentHashes.get(relativePath) ?? null;
    const installedHash = installed.get(relativePath) ?? null;
    const action = webExtensionFileAction({ currentHash, installedHash, desiredHash: file.desiredHash });
    if (action === "delete") throw new Error(`Unexpected delete action for extension source path: ${relativePath}`);
    return { relativePath, desiredHash: file.desiredHash, installedHash, currentHash, action };
  });
  // A packaged extension can remove a file between releases. Only remove it
  // when the installed copy still matches the hash M9R recorded; changed or
  // user-added files remain untouched and are no longer managed.
  for (const [relativePath, installedHash] of installed) {
    if (seen.has(relativePath)) continue;
    const currentHash = input.currentHashes.get(relativePath) ?? null;
    const action = webExtensionFileAction({ currentHash, installedHash, desiredHash: null });
    plan.push({ relativePath, desiredHash: null, installedHash, currentHash, action });
  }
  return plan;
}

export function parseWebSetupList(raw: string, valid: readonly string[], label: string): string[] {
  const values = [...new Set(raw.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean))];
  const invalid = values.find((value) => !valid.includes(value));
  if (invalid) throw new Error(`Unknown ${label} "${invalid}". Choose ${valid.join(", ")}.`);
  return values;
}

export function codexWebMcpBlock(command: WebMcpCommand): string {
  const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return [
    "# m9r-web-managed (maintained by M9R web setup)",
    "[mcp_servers.m9r]",
    `command = ${quote(command.command)}`,
    `args = [${command.args.map(quote).join(", ")}]`,
    "startup_timeout_sec = 30.0",
    "",
    "[mcp_servers.m9r.env]",
    `M9R_HOME = ${quote(command.m9rHome)}`,
    `M9R_WEB_BROKER_PORT = ${quote(String(command.brokerPort ?? 47821))}`,
    `M9R_PROVIDER = ${quote("codex")}`,
  ].join("\n");
}

interface TomlSection { title: string; start: number; end: number; headerStart: number }

function tomlSections(text: string): TomlSection[] {
  const sections: TomlSection[] = [];
  const headers: Array<{ title: string; start: number; headerStart: number }> = [];
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let offset = 0;
  for (const line of lines) {
    const match = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?(?:\r?\n)?$/);
    if (match) headers.push({ title: match[1]!.trim(), start: offset, headerStart: offset });
    offset += line.length;
  }
  for (let i = 0; i < headers.length; i += 1) {
    const current = headers[i]!;
    sections.push({ ...current, end: headers[i + 1]?.start ?? text.length });
  }
  return sections;
}

const OWN_CODEX_SECTIONS = new Set(["mcp_servers.m9r", "mcp_servers.m9r.env"]);

function managedCodexRange(text: string): { start: number; end: number } | null {
  const sections = tomlSections(text);
  const owned = sections.filter((section) => OWN_CODEX_SECTIONS.has(section.title));
  if (owned.length === 0) return null;
  let start = Math.min(...owned.map((section) => section.start));
  const marker = "# m9r-web-managed (maintained by M9R web setup)";
  const prefix = text.slice(0, start);
  const markerStart = prefix.lastIndexOf(marker);
  if (markerStart >= 0 && /^\s*$/.test(prefix.slice(markerStart + marker.length))) start = markerStart;
  return { start, end: Math.max(...owned.map((section) => section.end)) };
}

export function mergeCodexWebMcp(existing: string, command: WebMcpCommand): string {
  const block = codexWebMcpBlock(command);
  const owned = managedCodexRange(existing);
  if (!owned) {
    const separator = existing.length === 0 ? "" : existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return `${existing}${separator}${block}\n`;
  }
  const before = existing.slice(0, owned.start);
  const after = existing.slice(owned.end);
  const separator = before.length > 0 && !before.endsWith("\n\n") ? "\n" : "";
  return `${before}${separator}${block}\n${after}`;
}

export function removeCodexWebMcp(existing: string): string {
  const owned = managedCodexRange(existing);
  if (!owned) return existing;
  return `${existing.slice(0, owned.start)}${existing.slice(owned.end)}`.replace(/\n{3,}/g, "\n\n");
}

interface JsoncProperty { key: string; keyStart: number; value: JsoncNode; commaStart?: number }
interface JsoncNode { kind: "object" | "array" | "scalar"; start: number; end: number; openOffset?: number; closeOffset?: number; properties?: JsoncProperty[]; items?: JsoncNode[] }

class JsoncReader {
  private index = 0;
  private readonly source: string;
  constructor(source: string) { this.source = source; }

  parse(): JsoncNode {
    this.skipTrivia();
    const value = this.readValue();
    this.skipTrivia();
    if (this.index !== this.source.length) throw new Error("unexpected content after JSON value");
    return value;
  }

  private skipTrivia(): void {
    while (this.index < this.source.length) {
      if (/\s/.test(this.source[this.index]!)) { this.index += 1; continue; }
      if (this.source.startsWith("//", this.index)) {
        this.index += 2;
        while (this.index < this.source.length && this.source[this.index] !== "\n") this.index += 1;
        continue;
      }
      if (this.source.startsWith("/*", this.index)) {
        const end = this.source.indexOf("*/", this.index + 2);
        if (end < 0) throw new Error("unterminated JSONC comment");
        this.index = end + 2;
        continue;
      }
      break;
    }
  }

  private readString(): string {
    const start = this.index;
    if (this.source[this.index] !== '"') throw new Error("object keys must be quoted strings");
    this.index += 1;
    while (this.index < this.source.length) {
      const char = this.source[this.index]!;
      if (char === "\\") { this.index += 2; continue; }
      this.index += 1;
      if (char === '"') return JSON.parse(this.source.slice(start, this.index)) as string;
    }
    throw new Error("unterminated JSON string");
  }

  private readValue(): JsoncNode {
    this.skipTrivia();
    const start = this.index;
    const char = this.source[this.index];
    if (char === "{") return this.readObject();
    if (char === "[") return this.readArray();
    if (char === '"') { this.readString(); return { kind: "scalar", start, end: this.index }; }
    const match = this.source.slice(this.index).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!match) throw new Error("expected a JSON value");
    this.index += match[0].length;
    return { kind: "scalar", start, end: this.index };
  }

  private readObject(): JsoncNode {
    const start = this.index++;
    const properties: JsoncProperty[] = [];
    this.skipTrivia();
    while (this.source[this.index] !== "}") {
      if (this.index >= this.source.length) throw new Error("unterminated object");
      const keyStart = this.index;
      const key = this.readString();
      this.skipTrivia();
      if (this.source[this.index++] !== ":") throw new Error("expected colon after object key");
      const value = this.readValue();
      const property: JsoncProperty = { key, keyStart, value };
      this.skipTrivia();
      if (this.source[this.index] === ",") { property.commaStart = this.index++; this.skipTrivia(); }
      properties.push(property);
      if (this.source[this.index] === "}") break;
      if (property.commaStart === undefined) throw new Error("expected comma between object properties");
    }
    if (this.source[this.index] !== "}") throw new Error("unterminated object");
    const closeOffset = this.index++;
    return { kind: "object", start, end: this.index, openOffset: start, closeOffset, properties };
  }

  private readArray(): JsoncNode {
    const start = this.index++;
    const items: JsoncNode[] = [];
    this.skipTrivia();
    while (this.source[this.index] !== "]") {
      if (this.index >= this.source.length) throw new Error("unterminated array");
      items.push(this.readValue());
      this.skipTrivia();
      if (this.source[this.index] === ",") { this.index += 1; this.skipTrivia(); }
      else if (this.source[this.index] !== "]") throw new Error("expected comma between array values");
    }
    const closeOffset = this.index++;
    return { kind: "array", start, end: this.index, openOffset: start, closeOffset, items };
  }
}

function parseJsonc(source: string): JsoncNode {
  try { return new JsoncReader(source).parse(); }
  catch (error) { throw new Error(`OpenCode config is invalid JSONC (${error instanceof Error ? error.message : "parse error"}); it was not changed.`); }
}

function objectProperty(node: JsoncNode, key: string): JsoncProperty | undefined {
  return node.kind === "object" ? node.properties?.find((property) => property.key === key) : undefined;
}

function indentAt(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  return source.slice(lineStart, offset).match(/^\s*/)?.[0] ?? "";
}

function setJsoncProperty(source: string, node: JsoncNode, key: string, value: unknown): string {
  if (node.kind !== "object" || node.closeOffset === undefined) throw new Error("OpenCode config parent is not an object; it was not changed.");
  const existing = objectProperty(node, key);
  const serialized = JSON.stringify(value, null, 2);
  if (existing) return source.slice(0, existing.value.start) + serialized + source.slice(existing.value.end);
  const properties = node.properties ?? [];
  const parentIndent = indentAt(source, node.closeOffset);
  const childIndent = `${parentIndent}  `;
  const formatted = `\n${childIndent}${JSON.stringify(key)}: ${serialized}`;
  if (properties.length === 0) {
    return source.slice(0, node.closeOffset) + formatted + `\n${parentIndent}` + source.slice(node.closeOffset);
  }
  const last = properties[properties.length - 1]!;
  if (last.commaStart !== undefined) {
    const at = last.commaStart + 1;
    return source.slice(0, at) + formatted + source.slice(at);
  }
  return source.slice(0, last.value.end) + `,${formatted}` + source.slice(last.value.end);
}

function jsoncArrayItemText(source: string, item: JsoncNode): string {
  return source.slice(item.start, item.end).trim();
}

/** Remove only the M9R-owned plugin entry, preserving every other plugin and comment. */
function removeOpenCodePluginEntry(source: string, root: JsoncNode, key: "plugin" | "plugins"): string {
  const plugin = objectProperty(root, key);
  if (!plugin || plugin.value.kind !== "array" || plugin.value.openOffset === undefined || plugin.value.closeOffset === undefined) return source;
  const items = plugin.value.items ?? [];
  const index = items.findIndex((item) => jsoncArrayItemText(source, item) === JSON.stringify(OPENCODE_IDENTITY_PLUGIN_CONFIG_ENTRY));
  if (index < 0) return source;
  if (items.length === 1) return source.slice(0, plugin.value.start) + "[]" + source.slice(plugin.value.end);
  if (index === 0) {
    const comma = source.indexOf(",", items[0]!.end);
    if (comma < 0 || comma > plugin.value.closeOffset) return source;
    return source.slice(0, items[0]!.start) + source.slice(comma + 1);
  }
  return source.slice(0, items[index - 1]!.end) + source.slice(items[index]!.end);
}

/**
 * Reconcile the M9R plugin entry left by older installers. OpenCode now
 * auto-discovers files in the global plugins directory, so the active setup
 * must not add a fragile file path to `plugins`/`plugin`. Removing only our
 * old entry leaves every user plugin and comment untouched.
 */
function addOpenCodeIdentityPluginEntry(source: string): string {
  return removeOpenCodeIdentityPluginEntry(source);
}

/** Remove M9R's entry from both config spellings without touching user entries. */
function removeOpenCodeIdentityPluginEntry(source: string): string {
  for (const key of ["plugins", "plugin"] as const) {
    source = removeOpenCodePluginEntry(source, parseJsonc(source), key);
  }
  return source;
}

function removeJsoncProperty(source: string, node: JsoncNode, key: string): string {
  const properties = node.properties ?? [];
  const index = properties.findIndex((property) => property.key === key);
  if (index < 0) return source;
  const property = properties[index]!;
  if (index < properties.length - 1) {
    const end = property.commaStart;
    if (end === undefined) throw new Error("OpenCode config property delimiters are invalid; it was not changed.");
    return source.slice(0, property.keyStart) + source.slice(end + 1);
  }
  if (index > 0) {
    const separator = properties[index - 1]!.commaStart;
    if (separator === undefined) throw new Error("OpenCode config property delimiters are invalid; it was not changed.");
    return source.slice(0, separator) + source.slice(property.value.end);
  }
  return source.slice(0, property.keyStart) + source.slice(property.value.end);
}

function mcpTarget(node: JsoncNode, layout: WebOpenCodeLayout): { parent: JsoncNode; key: string } {
  const mcpProperty = objectProperty(node, "mcp");
  if (!mcpProperty) return { parent: node, key: "mcp" };
  if (mcpProperty.value.kind !== "object") throw new Error("OpenCode config `mcp` must be an object; it was not changed.");
  if (layout === "legacy") return { parent: mcpProperty.value, key: "m9r" };
  const servers = objectProperty(mcpProperty.value, "servers");
  if (!servers) return { parent: mcpProperty.value, key: "servers" };
  if (servers.value.kind !== "object") throw new Error("OpenCode config `mcp.servers` must be an object; it was not changed.");
  return { parent: servers.value, key: "m9r" };
}

/** Remove M9R's entry from the config spelling that is inactive for this OpenCode release. */
function removeOpenCodeStaleMcpEntry(source: string, root: JsoncNode, activeLayout: WebOpenCodeLayout): string {
  const mcp = objectProperty(root, "mcp")?.value;
  if (!mcp || mcp.kind !== "object") return source;
  if (activeLayout === "servers") return removeJsoncProperty(source, mcp, "m9r");
  const servers = objectProperty(mcp, "servers")?.value;
  return servers?.kind === "object" ? removeJsoncProperty(source, servers, "m9r") : source;
}

function openCodeEntry(command: WebMcpCommand): Record<string, unknown> {
  return {
    type: "local",
    command: [command.command, ...command.args],
    environment: { M9R_HOME: command.m9rHome, M9R_WEB_BROKER_PORT: String(command.brokerPort ?? 47821), M9R_PROVIDER: "opencode" },
    // OpenCode does not treat a configured MCP server as on by default; omitting this leaves
    // the server registered but never actually started, so none of its tools ever appear --
    // confirmed live (the real symptom this fixes, not a defensive guess).
    enabled: true,
  };
}

export function mergeOpenCodeWebMcp(existing: string, layout: WebOpenCodeLayout, command: WebMcpCommand, includeIdentityPlugin = false): string {
  let source = existing.trim() ? existing : "{}\n";
  let root = parseJsonc(source);
  if (root.kind !== "object") throw new Error("OpenCode config root must be an object; it was not changed.");
  let mcp = objectProperty(root, "mcp");
  if (!mcp) {
    source = setJsoncProperty(source, root, "mcp", {});
    root = parseJsonc(source);
    mcp = objectProperty(root, "mcp");
  }
  if (!mcp || mcp.value.kind !== "object") throw new Error("OpenCode config `mcp` must be an object; it was not changed.");
  if (layout === "servers" && !objectProperty(mcp.value, "servers")) {
    source = setJsoncProperty(source, mcp.value, "servers", {});
    root = parseJsonc(source);
    mcp = objectProperty(root, "mcp");
  }
  if (!mcp || mcp.value.kind !== "object") throw new Error("OpenCode config `mcp` must be an object; it was not changed.");
  const target = mcpTarget(root, layout);
  source = setJsoncProperty(source, target.parent, target.key, layout === "servers" && target.key === "servers" ? { m9r: openCodeEntry(command) } : openCodeEntry(command));
  source = removeOpenCodeStaleMcpEntry(source, parseJsonc(source), layout);
  if (!includeIdentityPlugin) return source;
  return addOpenCodeIdentityPluginEntry(source);
}

export function removeOpenCodeWebMcp(existing: string, layout: WebOpenCodeLayout, removeIdentityPlugin = false): string {
  if (!existing.trim()) return existing;
  let source = existing;
  let root = parseJsonc(source);
  if (removeIdentityPlugin) {
    source = removeOpenCodeIdentityPluginEntry(source);
    root = parseJsonc(source);
  }
  if (root.kind !== "object") return existing;
  const mcp = objectProperty(root, "mcp")?.value;
  if (!mcp || mcp.kind !== "object") return source;
  if (layout === "legacy") return removeJsoncProperty(source, mcp, "m9r");
  const servers = objectProperty(mcp, "servers")?.value;
  return servers?.kind === "object" ? removeJsoncProperty(source, servers, "m9r") : source;
}
