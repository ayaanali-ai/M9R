/**
 * Starts the local M9R owner broker. The desktop runtime uses the authenticated
 * owner pipe and native desktop/browser routes; the legacy browser-extension
 * transport is intentionally not enabled by this production entry point.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createLocalStore, defaultStoreRoot } from "@/lib/native/local-store";
import { createTaskDesktopStageService } from "@/lib/native/task-desktop-stage";
import { writeWebActivity } from "@/lib/native/feed-writer";
import { apiKeyLaunchBlock } from "@/lib/native/vendor-launch-core";
import { loadAgentsConfig, projectRoomId } from "@/lib/native/web-live-sessions";
import { createManagedProviderOwner } from "@/lib/native/managed-provider-owner";
import { createWebUiBridge } from "@/lib/native/web-ui-bridge";
import { createPageNotesStore } from "@/lib/native/page-notes-store";
import { pullCloudNotes, pushCloudNote } from "@/lib/native/cloud-memory";
import { launchDesktopOverlayIfNeeded, readDesktopPillRunning } from "@/lib/native/desktop-pill-presence";
import { DEFAULT_BROKER_PORT, brokerKeyPath, ownerPipePath } from "@/lib/native/web-broker-paths";
import { loadOrCreateBrokerKey, startWebBroker } from "@/lib/native/web-broker-server";
import type { StageApprovalRequest } from "@/lib/native/web-broker-core";
import { createWebAuthority } from "@/lib/native/web-authority-core";
import { createWebAuthorityStore } from "@/lib/native/web-authority-store";
import { clearDesktopPillState, writeDesktopPillState } from "@/lib/native/desktop-pill-state";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const homeIndex = args.indexOf("--home");
  if (homeIndex >= 0 && args[homeIndex + 1]) process.env.M9R_HOME = args[homeIndex + 1];
  const portIndex = args.indexOf("--port");
  if (portIndex >= 0 && args[portIndex + 1]) process.env.M9R_WEB_BROKER_PORT = args[portIndex + 1];
  const projectRootIndex = args.indexOf("--project-root");
  if (projectRootIndex >= 0 && args[projectRootIndex + 1]) process.env.M9R_PROJECT_ROOT = args[projectRootIndex + 1];
  const projectRoot = resolve(process.env.M9R_PROJECT_ROOT?.trim() || process.cwd());
  process.env.M9R_PROJECT_ROOT = projectRoot;
  const root = defaultStoreRoot(homedir(), process.env);
  const colorStore = createLocalStore(root);
  const key = loadOrCreateBrokerKey(brokerKeyPath(root));
  const ownerId = process.env.M9R_OWNER_ID?.trim() || "local-machine";
  const authorityStore = createWebAuthorityStore(root);
  const authority = createWebAuthority({ ownerId });
  authority.restore(authorityStore.load());
  const port = Number(process.env.M9R_WEB_BROKER_PORT) || DEFAULT_BROKER_PORT;
  // The in-page pill: agents the owner types to, one M9R-owned connection per agent and folder.
  const pageNotes = createPageNotesStore(root);
  // A note saved from the pill lands in the same project-room memory agents read at session start.
  const ui = createWebUiBridge({
    colorFor: (handle) => colorStore.colorFor(handle),
    onChange: () => {
      try { writeDesktopPillState(root, ui.snapshot()); } catch { /* the pill keeps its last good state */ }
    },
    saveNote: (text) => {
      const result = pageNotes.append({ room: projectRoomId(projectRoot), agent: "you", text, source: "agent" });
      if (result.ok) void pushCloudNote(root, text); // best effort: also appears in the team's dashboard when this machine is connected
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },
  });
  // Keep a local copy of the team's saved notes fresh for the agents' session prompts (no-op until `m9r cloud connect`).
  void pullCloudNotes(root);
  setInterval(() => void pullCloudNotes(root), 5 * 60_000).unref();
  // A real POST /web/shutdown (m9r web restart, or any owner-triggered restart) must stop this whole process, not just
  // close the HTTP socket, or the unref'd-less feed timer below keeps Node running forever with nothing left listening.
  let requestShutdown: () => Promise<void> = async () => {};
  // The stage service is built before the broker that owns the approval list, so it reads the route lazily:
  // money-gated stage clicks hold for the owner through the same pill approvals as web actions.
  const stageApprovals: { requestApproval?: (request: StageApprovalRequest) => Promise<boolean> } = {};
  // One owner-owned store instance is shared by the broker, stage service, and M9R-owned provider supervisor.
  // Restricted MCP child processes use the broker's narrow token-checked write endpoint instead of taking the
  // state.lock directory themselves; the owner-only store ACL stays intact.
  const store = createLocalStore(root);
  const taskStages = createTaskDesktopStageService({ store, approvals: () => stageApprovals.requestApproval ? { requestApproval: stageApprovals.requestApproval } : undefined });
  const sessionOwner: { current?: ReturnType<typeof createManagedProviderOwner> } = {};
  const broker = await startWebBroker({ key, port, taskStages, agentMcpStore: store,
    onAgentTaskCreated: (token, taskId) => { void taskStages.primeCursor(token, taskId); },
    deliverOwnerTask: (taskId) => sessionOwner.current
      ? sessionOwner.current.deliverOwnerTask(taskId)
      : { ok: false, error: "M9R-owned provider supervisor is not ready" },
    ownerId, authority, authorityStore, modeFile: join(root, "room-mode.txt"), ownerPipePath: ownerPipePath(root), ui, loopGuard: { repeat: 3, budget: 120, windowMs: 10 * 60_000 }, onShutdownRequested: () => requestShutdown() });
  stageApprovals.requestApproval = (request) => broker.requestStageApproval(request);
  // The broker already autostarts at login; piggyback the desktop pill's launch onto that same moment
  // while launchDesktopOverlayIfNeeded's process check prevents duplicate overlays.
  launchDesktopOverlayIfNeeded(root);
  const config = loadAgentsConfig(root, { cwd: projectRoot });
  const providerSessions = createManagedProviderOwner({
    agents: config.agents, storeRoot: root, repoRoot: projectRoot, brokerPort: broker.port,
    store, onEvent: (event) => ui.onSessionEvent(event),
  });
  sessionOwner.current = providerSessions;
  ui.attachSessions(providerSessions);
  writeDesktopPillState(root, ui.snapshot());
  // The broker is the M9R owner boundary for the desktop path. Restore every
  // configured logical provider connection as soon as the broker is alive so
  // the pill does not depend on a provider app, a provider hook, or an inbox
  // read to make the first task usable after sign-in/reboot. Each provider is
  // isolated: one missing CLI/login must not prevent the other connections or
  // the owner broker from coming up.
  void providerSessions.start().then((startup) => {
    for (const failure of startup.failures) {
      process.stderr.write(`M9R managed provider @${failure.handle} did not start: ${failure.error}\n`);
    }
    try { writeDesktopPillState(root, ui.snapshot()); } catch { /* the broker remains usable */ }
  }).catch((error: unknown) => {
    process.stderr.write(`M9R managed provider startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  });
  // Keep the snapshot a live ownership signal. If the broker crashes, the
  // overlay rejects the stale file and returns to its compatibility feed
  // instead of displaying state whose owner pipe no longer exists.
  const pillStateTimer = setInterval(() => {
    try { writeDesktopPillState(root, ui.snapshot()); } catch { /* the last state remains readable */ }
  }, 2_000);
  pillStateTimer.unref();
  process.stdout.write(`M9R web broker listening on 127.0.0.1:${broker.port}\n`);
  process.stdout.write(`Project root: ${projectRoot}\n`);
  process.stdout.write(`Agents (${config.source === "default" ? "defaults; add agents.json to your M9R folder to change" : config.source}): ${config.agents.map((a) => `@${a.handle} (${a.provider}, ${a.folder})`).join(", ")}\n`);
  for (const problem of config.problems) process.stdout.write(`  note: ${problem}\n`);
  const blocked = apiKeyLaunchBlock(process.env, false);
  if (blocked) process.stdout.write(`  warning: agents will not start. ${blocked}\n`);
  // A separately persisted, redacted web-surface feed beside the native feed; never mutates feed.json.
  let lastWeb = "";
  const webTimer = setInterval(() => {
    const body = JSON.stringify(ui.recentWeb());
    if (body === lastWeb) return;
    lastWeb = body;
    try { writeWebActivity(root, ui.recentWeb()); } catch { /* the pill feed is optional */ }
  }, 1000);
  // One pill at a time: the desktop pill beats a heartbeat file; while it is running the in-page pill steps aside.
  const presenceTimer = setInterval(() => ui.setDesktopPill(readDesktopPillRunning(root)), 2000);
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    clearInterval(webTimer); clearInterval(presenceTimer); clearInterval(pillStateTimer); ui.close(); clearDesktopPillState(root);
    // Keep the broker listener alive until stage/runtime cleanup finishes. The authenticated
    // shutdown caller uses listener closure as its signal that owned resources have drained.
    stopPromise = (async () => {
      await providerSessions.shutdown();
      await taskStages.close();
      await broker.close();
    })().catch((error: unknown) => {
      // A failed drain must leave the broker available so an authenticated retry can
      // attempt cleanup again. Keeping a rejected promise here would make every later
      // shutdown request fail without re-running the stage close operation.
      stopPromise = undefined;
      throw error;
    });
    return stopPromise;
  };
  const requestStop = (): Promise<void> => {
    const operation = stop();
    void operation.then(() => process.exit(0), (error) => {
      process.stderr.write(`M9R web broker shutdown did not complete: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    return operation;
  };
  requestShutdown = requestStop;
  process.on("SIGINT", () => { void requestStop(); });
  process.on("SIGTERM", () => { void requestStop(); });
}

// A single failed background write must not take the owner's broker down in the middle of a demo.
process.on("uncaughtException", (error) => { process.stderr.write(`M9R web broker: recovered from an unexpected error: ${error instanceof Error ? error.message : String(error)}
`); });
process.on("unhandledRejection", (error) => { process.stderr.write(`M9R web broker: recovered from an unhandled rejection: ${error instanceof Error ? error.message : String(error)}
`); });

main().catch((error) => {
  process.stderr.write(`M9R web broker failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
