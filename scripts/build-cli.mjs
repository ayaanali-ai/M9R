// Build the distributable M9R CLI from the TypeScript source.
//
// Single source of truth: src/lib/m9r-cli-core.ts + scripts/m9r-cli.ts
// are transpiled (type-strip only, no bundling) into cli/dist/*.js as ESM, with
// the `@/` alias rewritten to a relative import and a shebang on the entry.
//
// Run from anywhere: paths resolve from this file, not the cwd. Used by
// `npm run build:cli` and by the cli package's `prepack` hook before `npm pack`.

import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(repoRoot, "cli", "dist");

const SHEBANG = "#!/usr/bin/env node\n";

function transpile(tsSource) {
  return ts.transpileModule(tsSource, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      // Keep output clean; we are not bundling or down-leveling modules.
      removeComments: false,
    },
  }).outputText;
}

function build() {
  // cli/dist is generated and ignored. Clear it first so deleted source
  // modules cannot survive into a new tarball as stale release content.
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 1. Bootstrap core — pure string/path logic; its only "@/" import is
  //    type-only and is erased by transpilation.
  const bootstrapTs = readFileSync(resolve(repoRoot, "src/lib/oathlock-bootstrap-core.ts"), "utf8");
  writeFileSync(resolve(outDir, "oathlock-bootstrap-core.js"), transpile(bootstrapTs));

  // 2. Adapter contract — pure protocol/capability data used by `doctor`.
  // Ship it with the CLI so the distributable never depends on the app's `@/`
  // alias or repository source tree at runtime.
  const adapterContractTs = readFileSync(resolve(repoRoot, "src/lib/adapter-contract.ts"), "utf8");
  writeFileSync(resolve(outDir, "adapter-contract.js"), transpile(adapterContractTs));

  // `m9r connect` agent-CLI detection -- pure logic, no `@/` imports of its own.
  const agentDetectionTs = readFileSync(resolve(repoRoot, "src/lib/agent-detection-core.ts"), "utf8");
  writeFileSync(resolve(outDir, "agent-detection-core.js"), transpile(agentDetectionTs));

  // Item #35 cross-agent session capture -- setup-core (pure, no `@/` imports)
  // and the drain-side core (imports session-redaction.ts).
  const captureSetupCoreTs = readFileSync(resolve(repoRoot, "src/lib/cross-agent-capture-setup-core.ts"), "utf8");
  writeFileSync(resolve(outDir, "cross-agent-capture-setup-core.js"), transpile(captureSetupCoreTs));
  const captureCoreTs = readFileSync(resolve(repoRoot, "src/lib/cross-agent-capture-core.ts"), "utf8");
  const captureCoreJs = transpile(captureCoreTs)
    .replace(/["']@\/lib\/session-redaction["']/g, '"./session-redaction.js"')
    .replace(/["']@\/lib\/memory-distill-core["']/g, '"./memory-distill-core.js"');
  writeFileSync(resolve(outDir, "cross-agent-capture-core.js"), captureCoreJs);
  const distillTs = readFileSync(resolve(repoRoot, "src/lib/memory-distill-core.ts"), "utf8");
  writeFileSync(resolve(outDir, "memory-distill-core.js"), transpile(distillTs).replace(/["']@\/lib\/session-redaction["']/g, '"./session-redaction.js"'));
  const opencodeBackfillTs = readFileSync(resolve(repoRoot, "src/lib/opencode-capture-backfill-core.ts"), "utf8");
  const opencodeBackfillJs = transpile(opencodeBackfillTs)
    .replace(/["']@\/lib\/cross-agent-capture-core["']/g, '"./cross-agent-capture-core.js"');
  writeFileSync(resolve(outDir, "opencode-capture-backfill-core.js"), opencodeBackfillJs);

  const providerAdapterConfigTs = readFileSync(resolve(repoRoot, "packages/runtime-core/src/provider-adapter-config.ts"), "utf8");
  writeFileSync(resolve(outDir, "provider-adapter-config.js"), transpile(providerAdapterConfigTs));

  const agentJoinTs = readFileSync(resolve(repoRoot, "src/lib/agent-join.ts"), "utf8");
  writeFileSync(resolve(outDir, "agent-join.js"), transpile(agentJoinTs));

  const redactionTs = readFileSync(resolve(repoRoot, "src/lib/session-redaction.ts"), "utf8");
  writeFileSync(resolve(outDir, "session-redaction.js"), transpile(redactionTs));

  const formatEnumLabelTs = readFileSync(resolve(repoRoot, "src/lib/format-enum-label.ts"), "utf8");
  writeFileSync(resolve(outDir, "format-enum-label.js"), transpile(formatEnumLabelTs));

  // Usage normalization — import-free cost/token extraction used by the
  // provider adapters. Shipped so the distributable stays self-contained.
  const usageNormalizationTs = readFileSync(resolve(repoRoot, "src/lib/usage-normalization.ts"), "utf8");
  writeFileSync(resolve(outDir, "usage-normalization.js"), transpile(usageNormalizationTs));

  const agentTaskRoutingTs = readFileSync(resolve(repoRoot, "src/lib/agent-task-routing.ts"), "utf8");
  writeFileSync(resolve(outDir, "agent-task-routing.js"), transpile(agentTaskRoutingTs));

  const residentActivityJournalTs = readFileSync(resolve(repoRoot, "src/lib/resident-activity-journal.ts"), "utf8");
  const residentActivityJournalJs = transpile(residentActivityJournalTs)
    .replace(/['"]@\/lib\/session-redaction['"]/g, '"./session-redaction.js"')
    .replace(/['"]@\/lib\/format-enum-label['"]/g, '"./format-enum-label.js"')
    .replace(/['"]@\/lib\/agent-join['"]/g, '"./agent-join.js"')
    .replace(/['"]@\/lib\/provider-adapter-config['"]/g, '"./provider-adapter-config.js"');
  writeFileSync(resolve(outDir, "resident-activity-journal.js"), residentActivityJournalJs);

  const residentWriteIsolationTs = readFileSync(resolve(repoRoot, "src/lib/resident-write-isolation.ts"), "utf8");
  writeFileSync(resolve(outDir, "resident-write-isolation.js"), transpile(residentWriteIsolationTs));

  const providerAdaptersTs = readFileSync(resolve(repoRoot, "src/lib/resident-provider-adapters.ts"), "utf8");
  const providerAdaptersJs = transpile(providerAdaptersTs)
    .replace(/['"]@\/lib\/session-redaction['"]/g, '"./session-redaction.js"')
    .replace(/['"]@\/lib\/usage-normalization['"]/g, '"./usage-normalization.js"')
    .replace(/['"]@\/lib\/agent-task-routing['"]/g, '"./agent-task-routing.js"')
    .replace(/['"]@\/lib\/provider-adapter-config['"]/g, '"./provider-adapter-config.js"')
    .replace(/['"]@\/lib\/resident-write-isolation['"]/g, '"./resident-write-isolation.js"');
  writeFileSync(resolve(outDir, "resident-provider-adapters.js"), providerAdaptersJs);

  const residentCoreTs = readFileSync(resolve(repoRoot, "src/lib/oathlock-resident-core.ts"), "utf8");
  const residentCoreJs = transpile(residentCoreTs)
    .replace(/['"]@\/lib\/resident-provider-adapters['"]/g, '"./resident-provider-adapters.js"')
    .replace(/['"]@\/lib\/agent-task-routing['"]/g, '"./agent-task-routing.js"')
    .replace(/['"]@\/lib\/resident-activity-journal['"]/g, '"./resident-activity-journal.js"')
    .replace(/['"]@\/lib\/format-enum-label['"]/g, '"./format-enum-label.js"')
    .replace(/['"]@\/lib\/agent-join['"]/g, '"./agent-join.js"')
    .replace(/['"]@\/lib\/provider-adapter-config['"]/g, '"./provider-adapter-config.js"')
    .replace(/['"]@\/lib\/resident-write-isolation['"]/g, '"./resident-write-isolation.js"');
  writeFileSync(resolve(outDir, "oathlock-resident-core.js"), residentCoreJs);

  const residentServicePlanTs = readFileSync(resolve(repoRoot, "src/lib/resident-service-plan.ts"), "utf8");
  writeFileSync(resolve(outDir, "resident-service-plan.js"), transpile(residentServicePlanTs));

  const residentSupervisorTs = readFileSync(resolve(repoRoot, "src/lib/resident-supervisor.ts"), "utf8");
  writeFileSync(resolve(outDir, "resident-supervisor.js"), transpile(residentSupervisorTs));

  const residentProfileSourceTs = readFileSync(resolve(repoRoot, "src/lib/resident-profile-source.ts"), "utf8");
  writeFileSync(resolve(outDir, "resident-profile-source.js"), transpile(residentProfileSourceTs));

  const windowsServiceTs = readFileSync(resolve(repoRoot, "src/lib/oathlock-windows-service.ts"), "utf8");
  writeFileSync(resolve(outDir, "oathlock-windows-service.js"), transpile(windowsServiceTs));

  const autostartTs = readFileSync(resolve(repoRoot, "src/lib/oathlock-autostart.ts"), "utf8");
  writeFileSync(resolve(outDir, "oathlock-autostart.js"), transpile(autostartTs));

  const watchdogTs = readFileSync(resolve(repoRoot, "src/lib/oathlock-watchdog.ts"), "utf8");
  writeFileSync(resolve(outDir, "oathlock-watchdog.js"), transpile(watchdogTs));

  // Mission ACP Bridge — the autonomous @mention-triggered agent chain
  // (dev-mcp-server.ts's send_message/submit_evidence, real ACP sessions,
  // the Mission Relay client). Previously deliberately excluded from this
  // whitelist (see local-mission-bridge-runner.ts's own comment, now
  // out of date) so it only ever ran from a full monorepo checkout via tsx
  // -- meaning a real npx-installed user got the raw terminal bridge but
  // never autonomous mention-triggered work. Every file below was traced
  // for its actual (non-type-only) runtime imports before being added; type-
  // only imports (mission-domain.ts, mission-process-host.ts,
  // mission-runtime-activity.ts, mission-relay-service.ts, interactive-
  // provider-adapter.ts) are erased by transpilation and deliberately not
  // shipped, since none of them are needed at runtime and several would
  // have pulled in far more (mission-process-host -> mission-scheduler-
  // store, which is Supabase-backed and has no place in a distributable
  // CLI). If that assumption is ever wrong for one of them, the failure
  // mode is a loud, immediate "Cannot find module" naming the exact file.
  const missionProtocolVersionsTs = readFileSync(resolve(repoRoot, "src/lib/mission/mission-protocol-versions.ts"), "utf8");
  writeFileSync(resolve(outDir, "mission-protocol-versions.js"), transpile(missionProtocolVersionsTs));

  const missionFeatureFlagsTs = readFileSync(resolve(repoRoot, "src/lib/mission/mission-feature-flags.ts"), "utf8");
  writeFileSync(resolve(outDir, "mission-feature-flags.js"), transpile(missionFeatureFlagsTs));

  const bridgeProtocolTs = readFileSync(resolve(repoRoot, "src/lib/bridge/bridge-protocol.ts"), "utf8");
  const bridgeProtocolJs = transpile(bridgeProtocolTs)
    .replace(/['"]@\/lib\/mission\/mission-protocol-versions['"]/g, '"./mission-protocol-versions.js"');
  writeFileSync(resolve(outDir, "bridge-protocol.js"), bridgeProtocolJs);

  const missionProviderAdapterTs = readFileSync(resolve(repoRoot, "src/lib/mission/mission-provider-adapter.ts"), "utf8");
  const missionProviderAdapterJs = transpile(missionProviderAdapterTs)
    .replace(/['"]\.\/mission-process-host['"]/g, '"./mission-process-host.js"')
    .replace(/['"]\.\/mission-runtime-activity['"]/g, '"./mission-runtime-activity.js"');
  writeFileSync(resolve(outDir, "mission-provider-adapter.js"), missionProviderAdapterJs);

  const interactiveProviderAdapterTs = readFileSync(resolve(repoRoot, "src/lib/bridge/interactive-provider-adapter.ts"), "utf8");
  const interactiveProviderAdapterJs = transpile(interactiveProviderAdapterTs)
    .replace(/['"]@\/lib\/mission\/mission-provider-adapter['"]/g, '"./mission-provider-adapter.js"')
    .replace(/['"]@\/lib\/mission\/mission-process-host['"]/g, '"./mission-process-host.js"');
  writeFileSync(resolve(outDir, "interactive-provider-adapter.js"), interactiveProviderAdapterJs);

  const bridgeSessionRegistryTs = readFileSync(resolve(repoRoot, "src/lib/bridge/bridge-session-registry.ts"), "utf8");
  const bridgeSessionRegistryJs = transpile(bridgeSessionRegistryTs)
    .replace(/['"]@\/lib\/mission\/mission-provider-adapter['"]/g, '"./mission-provider-adapter.js"')
    .replace(/['"]\.\/interactive-provider-adapter['"]/g, '"./interactive-provider-adapter.js"');
  writeFileSync(resolve(outDir, "bridge-session-registry.js"), bridgeSessionRegistryJs);

  const missionRelayProtocolTs = readFileSync(resolve(repoRoot, "src/lib/mission/mission-relay-protocol.ts"), "utf8");
  writeFileSync(resolve(outDir, "mission-relay-protocol.js"), transpile(missionRelayProtocolTs));

  const devMcpServerTs = readFileSync(resolve(repoRoot, "src/lib/bridge/dev-mcp-server.ts"), "utf8");
  const chatEvidenceSchemaTs = readFileSync(resolve(repoRoot, "src/lib/bridge/chat-evidence-schema.ts"), "utf8");
  writeFileSync(resolve(outDir, "chat-evidence-schema.js"), transpile(chatEvidenceSchemaTs));
  // Real, live-caught bug: dev-mcp-server.ts was refactored (item #32 phase 2)
  // to import its governed tool implementations (read_file/str_replace/tree/
  // rg/git_read/send_message) from governed-agent-tools.ts, but this build
  // script was never updated to bundle that new sibling file or rewrite the
  // new "@/lib/bridge/governed-agent-tools" import -- so the compiled/
  // published dev-mcp-server.js threw ERR_MODULE_NOT_FOUND for "@/lib" the
  // instant Codex/OpenCode/Claude Code tried to spawn it, silently reporting
  // send_message (and every other dev tool) as unavailable to the model.
  // governed-agent-tools.ts only imports Node builtins, so it can be copied
  // through verbatim with no further rewriting needed.
  const governedAgentToolsTs = readFileSync(resolve(repoRoot, "src/lib/bridge/governed-agent-tools.ts"), "utf8");
  writeFileSync(resolve(outDir, "governed-agent-tools.js"), transpile(governedAgentToolsTs));
  const devMcpServerJs = transpile(devMcpServerTs)
    .replace(/['"]@\/lib\/bridge\/chat-evidence-schema['"]/g, '"./chat-evidence-schema.js"')
    .replace(/['"]@\/lib\/bridge\/governed-agent-tools['"]/g, '"./governed-agent-tools.js"');
  writeFileSync(resolve(outDir, "dev-mcp-server.js"), devMcpServerJs);

  const acpProviderRegistryTs = readFileSync(resolve(repoRoot, "src/lib/bridge/acp-provider-registry.ts"), "utf8");
  const acpProviderRegistryJs = transpile(acpProviderRegistryTs)
    .replace(/['"]\.\/interactive-provider-adapter['"]/g, '"./interactive-provider-adapter.js"')
    .replace(/['"]\.\/acp-stdio-adapter['"]/g, '"./acp-stdio-adapter.js"')
    .replace(/['"]\.\/codex-app-server-adapter['"]/g, '"./codex-app-server-adapter.js"');
  writeFileSync(resolve(outDir, "acp-provider-registry.js"), acpProviderRegistryJs);

  const codexAppServerClientTs = readFileSync(resolve(repoRoot, "src/lib/bridge/codex-app-server-client.ts"), "utf8");
  writeFileSync(resolve(outDir, "codex-app-server-client.js"), transpile(codexAppServerClientTs));

  const codexAppServerAdapterTs = readFileSync(resolve(repoRoot, "src/lib/bridge/codex-app-server-adapter.ts"), "utf8");
  const codexAppServerAdapterJs = transpile(codexAppServerAdapterTs)
    .replace(/['"]@\/lib\/mission\/mission-provider-adapter['"]/g, '"./mission-provider-adapter.js"')
    .replace(/['"]@\/lib\/session-redaction['"]/g, '"./session-redaction.js"')
    .replace(/['"]\.\/acp-stdio-adapter['"]/g, '"./acp-stdio-adapter.js"')
    .replace(/['"]\.\/codex-app-server-client['"]/g, '"./codex-app-server-client.js"')
    .replace(/['"]\.\/interactive-provider-adapter['"]/g, '"./interactive-provider-adapter.js"');
  writeFileSync(resolve(outDir, "codex-app-server-adapter.js"), codexAppServerAdapterJs);

  const acpStdioAdapterTs = readFileSync(resolve(repoRoot, "src/lib/bridge/acp-stdio-adapter.ts"), "utf8");
  const acpStdioAdapterJs = transpile(acpStdioAdapterTs)
    .replace(/['"]@\/lib\/mission\/mission-feature-flags['"]/g, '"./mission-feature-flags.js"')
    .replace(/['"]@\/lib\/mission\/mission-provider-adapter['"]/g, '"./mission-provider-adapter.js"')
    .replace(/['"]@\/lib\/session-redaction['"]/g, '"./session-redaction.js"')
    .replace(/['"]@\/lib\/provider-adapter-config['"]/g, '"./provider-adapter-config.js"')
    .replace(/['"]\.\/interactive-provider-adapter['"]/g, '"./interactive-provider-adapter.js"');
  writeFileSync(resolve(outDir, "acp-stdio-adapter.js"), acpStdioAdapterJs);

  const acpClientTs = readFileSync(resolve(repoRoot, "src/lib/bridge/acp-client.ts"), "utf8");
  const acpClientJs = transpile(acpClientTs)
    .replace(/['"]@\/lib\/mission\/mission-feature-flags['"]/g, '"./mission-feature-flags.js"')
    .replace(/['"]@\/lib\/mission\/mission-provider-adapter['"]/g, '"./mission-provider-adapter.js"')
    .replace(/['"]\.\/bridge-session-registry['"]/g, '"./bridge-session-registry.js"')
    .replace(/['"]\.\/interactive-provider-adapter['"]/g, '"./interactive-provider-adapter.js"')
    .replace(/['"]\.\/acp-provider-registry['"]/g, '"./acp-provider-registry.js"');
  writeFileSync(resolve(outDir, "acp-client.js"), acpClientJs);

  const missionEvidenceReporterTs = readFileSync(resolve(repoRoot, "src/lib/bridge/mission-evidence-reporter.ts"), "utf8");
  const missionEvidenceReporterJs = transpile(missionEvidenceReporterTs)
    .replace(/['"]\.\/acp-client['"]/g, '"./acp-client.js"')
    .replace(/['"]@\/lib\/mission\/mission-domain['"]/g, '"./mission-domain.js"');
  writeFileSync(resolve(outDir, "mission-evidence-reporter.js"), missionEvidenceReporterJs);

  const missionRelayClientTs = readFileSync(resolve(repoRoot, "src/lib/mission/mission-relay-client.ts"), "utf8");
  const missionRelayClientJs = transpile(missionRelayClientTs)
    .replace(/['"]\.\.\/bridge\/acp-client['"]/g, '"./acp-client.js"')
    .replace(/['"]\.\.\/bridge\/interactive-provider-adapter['"]/g, '"./interactive-provider-adapter.js"')
    .replace(/['"]\.\/mission-relay-protocol['"]/g, '"./mission-relay-protocol.js"')
    .replace(/['"]\.\/mission-provider-adapter['"]/g, '"./mission-provider-adapter.js"')
    .replace(/['"]\.\/mission-runtime-activity['"]/g, '"./mission-runtime-activity.js"')
    .replace(/['"]\.\/mission-relay-service['"]/g, '"./mission-relay-service.js"');
  writeFileSync(resolve(outDir, "mission-relay-client.js"), missionRelayClientJs);

  const workspacePromptQueueTs = readFileSync(resolve(repoRoot, "src/lib/bridge/workspace-prompt-queue.ts"), "utf8");
  writeFileSync(resolve(outDir, "workspace-prompt-queue.js"), transpile(workspacePromptQueueTs));

  const workspaceTurnTimingTs = readFileSync(resolve(repoRoot, "src/lib/bridge/workspace-turn-timing.ts"), "utf8");
  writeFileSync(resolve(outDir, "workspace-turn-timing.js"), transpile(workspaceTurnTimingTs));

  const deliveryStateTs = readFileSync(resolve(repoRoot, "src/lib/delivery-state.ts"), "utf8");
  writeFileSync(resolve(outDir, "delivery-state.js"), transpile(deliveryStateTs));

  const resultTruncationTs = readFileSync(resolve(repoRoot, "src/lib/bridge/result-truncation.ts"), "utf8");
  writeFileSync(resolve(outDir, "result-truncation.js"), transpile(resultTruncationTs));

  const restartRecoveryTs = readFileSync(resolve(repoRoot, "src/lib/bridge/restart-recovery.ts"), "utf8");
  writeFileSync(resolve(outDir, "restart-recovery.js"), transpile(restartRecoveryTs));

  const deliveryLedgerTs = readFileSync(resolve(repoRoot, "src/lib/bridge/delivery-ledger.ts"), "utf8");
  writeFileSync(resolve(outDir, "delivery-ledger.js"), transpile(deliveryLedgerTs).replace(/['"]\.\.\/delivery-state['"]/g, '"./delivery-state.js"'));

  // Native front door (setup, uninstall, send, and the tiny hook entry). Modules import each other as "./x", which ESM
  // needs as "./x.js"; every module this list ships must be listed here or the CLI breaks at runtime.
  for (const name of ["mention-core", "inbox-core", "approval-core", "approval-commands", "feed-core", "feed-writer", "memory-hint-core", "memory-command", "codex-delivery-core", "codex-liveness", "codex-delivery", "local-store", "hook-handler", "install-core", "onboarding-steps", "native-commands"]) {
    const source = readFileSync(resolve(repoRoot, `src/lib/native/${name}.ts`), "utf8");
    const js = transpile(source).replace(/from\s+["']\.\/([a-z-]+)["']/g, 'from "./$1.js"').replace(/["']@\/lib\/memory-distill-core["']/g, '"./memory-distill-core.js"');
    writeFileSync(resolve(outDir, `${name}.js`), js);
  }
  const hookEntryTs = readFileSync(resolve(repoRoot, "scripts/m9r-hook.ts"), "utf8");
  writeFileSync(resolve(outDir, "m9r-hook.js"), transpile(hookEntryTs).replace(/["']@\/lib\/native\/([a-z-]+)["']/g, '"./$1.js"'));

  const missionParticipantIdsTs = readFileSync(resolve(repoRoot, "src/lib/mission/mission-participant-ids.ts"), "utf8");
  writeFileSync(resolve(outDir, "mission-participant-ids.js"), transpile(missionParticipantIdsTs));

  const workspaceCursorTs = readFileSync(resolve(repoRoot, "src/lib/mission/workspace-cursor.ts"), "utf8");
  writeFileSync(resolve(outDir, "workspace-cursor.js"), transpile(workspaceCursorTs));

  // The local Bridge renews the same authenticated presence lease used by
  // the server-side router. Ship its protocol constants with the CLI rather
  // than leaving the generated Bridge import pointed at the monorepo source.
  const agentHeartbeatTs = readFileSync(resolve(repoRoot, "src/lib/agent-heartbeat.ts"), "utf8");
  writeFileSync(resolve(outDir, "agent-heartbeat.js"), transpile(agentHeartbeatTs));
  // bridge-runtime imports conversation-routing (and, through it, agent-presence).
  // Ship both flattened next to it; without them every provider bridge crashes on
  // ERR_MODULE_NOT_FOUND the moment the packaged CLI starts it.
  const agentPresenceTs = readFileSync(resolve(repoRoot, "src/lib/agent-presence.ts"), "utf8");
  writeFileSync(resolve(outDir, "agent-presence.js"), transpile(agentPresenceTs));
  const conversationRoutingTs = readFileSync(resolve(repoRoot, "src/lib/conversation-routing.ts"), "utf8");
  writeFileSync(
    resolve(outDir, "conversation-routing.js"),
    transpile(conversationRoutingTs)
      .replace(/['"]@\/lib\/provider-adapter-config['"]/g, '"./provider-adapter-config.js"')
      .replace(/['"]@\/lib\/agent-presence['"]/g, '"./agent-presence.js"'),
  );
  const bridgeRuntimeTs = readFileSync(resolve(repoRoot, "services/mission-bridge/src/bridge-runtime.ts"), "utf8");
  const bridgeRuntimeJs = transpile(bridgeRuntimeTs)
    .replace(/['"]\.\.\/\.\.\/\.\.\/src\/lib\/bridge\/bridge-protocol['"]/g, '"./bridge-protocol.js"')
    .replace(/['"]\.\.\/\.\.\/\.\.\/src\/lib\/bridge\/acp-client['"]/g, '"./acp-client.js"')
    .replace(/['"]\.\.\/\.\.\/\.\.\/src\/lib\/bridge\/mission-evidence-reporter['"]/g, '"./mission-evidence-reporter.js"')
    .replace(/['"]\.\.\/\.\.\/\.\.\/src\/lib\/mission\/mission-provider-adapter['"]/g, '"./mission-provider-adapter.js"')
    .replace(/['"]\.\.\/\.\.\/\.\.\/src\/lib\/mission\/mission-feature-flags['"]/g, '"./mission-feature-flags.js"')
    .replace(/['"]\.\.\/\.\.\/\.\.\/src\/lib\/agent-heartbeat['"]/g, '"./agent-heartbeat.js"')
    .replace(/['"]\.\.\/\.\.\/\.\.\/src\/lib\/conversation-routing['"]/g, '"./conversation-routing.js"')
    .replace(/['"]\.\.\/\.\.\/\.\.\/src\/lib\/mission\/mission-relay-client['"]/g, '"./mission-relay-client.js"')
    .replace('"../../../src/lib/bridge/workspace-turn-timing"', '"./workspace-turn-timing.js"')
    .replace('"../../../src/lib/bridge/delivery-ledger"', '"./delivery-ledger.js"')
    .replace('"../../../src/lib/bridge/restart-recovery"', '"./restart-recovery.js"')
    .replace('"../../../src/lib/bridge/result-truncation"', '"./result-truncation.js"')
    .replace('"../../../src/lib/delivery-state"', '"./delivery-state.js"')
    .replace('"../../../src/lib/mission/mission-participant-ids"', '"./mission-participant-ids.js"')
    .replace('"../../../src/lib/mission/workspace-cursor"', '"./workspace-cursor.js"')
    .replace(/['"]\.\.\/\.\.\/\.\.\/src\/lib\/bridge\/workspace-prompt-queue['"]/g, '"./workspace-prompt-queue.js"')
    // Dynamic import (inside ensureTerminalPane), not a static one -- this
    // one was missing from the rewrite list entirely. Confirmed live: the
    // packaged CLI crashed every provider the moment OATHLOCK_TERMINAL_PANES
    // was actually turned on (ERR_MODULE_NOT_FOUND, wrong relative path once
    // the file it's computed from moved into cli/dist/), meaning terminal
    // panes have never actually run end-to-end through the real CLI build.
    .replace(/['"]\.\.\/\.\.\/\.\.\/src\/lib\/mission\/mission-pty-runtime['"]/g, '"./mission-pty-runtime.js"');
  const bridgeRuntimeWithProviderConfig = bridgeRuntimeJs
    .replace(/['"]\.\.\/\.\.\/\.\.\/src\/lib\/provider-adapter-config['"]/g, '"./provider-adapter-config.js"');
  writeFileSync(resolve(outDir, "bridge-runtime.js"), bridgeRuntimeWithProviderConfig);

  // mission-pty-runtime's own dependency chain -- mission-pty-host and
  // mission-pty-protocol are same-directory sibling imports that stay valid
  // relative imports once all three land flattened in the same outDir, so
  // only the top-level file's own import (rewritten above) needs a rule.
  const missionPtyProtocolTs = readFileSync(resolve(repoRoot, "src/lib/mission/mission-pty-protocol.ts"), "utf8");
  writeFileSync(resolve(outDir, "mission-pty-protocol.js"), transpile(missionPtyProtocolTs));
  // Node's native ESM loader (unlike a bundler or ts-node) requires an
  // explicit extension on a relative specifier -- "./mission-pty-protocol"
  // resolves fine under TypeScript/Next.js but throws ERR_MODULE_NOT_FOUND
  // here, confirmed live. Same reason every other file in this script gets
  // its imports rewritten; these two just also need the plain co-located
  // case handled, not only the "../../../src/..." case.
  const missionPtyHostTs = readFileSync(resolve(repoRoot, "src/lib/mission/mission-pty-host.ts"), "utf8");
  const missionPtyHostJs = transpile(missionPtyHostTs)
    .replace('"./mission-pty-protocol"', '"./mission-pty-protocol.js"');
  writeFileSync(resolve(outDir, "mission-pty-host.js"), missionPtyHostJs);
  const missionPtyRuntimeTs = readFileSync(resolve(repoRoot, "src/lib/mission/mission-pty-runtime.ts"), "utf8");
  const missionPtyRuntimeJs = transpile(missionPtyRuntimeTs)
    .replace('"./mission-pty-host"', '"./mission-pty-host.js"')
    .replace('"./mission-pty-protocol"', '"./mission-pty-protocol.js"')
    .replace('"./mission-relay-protocol"', '"./mission-relay-protocol.js"');
  writeFileSync(resolve(outDir, "mission-pty-runtime.js"), missionPtyRuntimeJs);

  // Item #28 Part A owner terminal runtime — dynamically imported from
  // m9r-cli.ts's startTerminalRuntime(), so it never showed up as a static
  // import for the entry rewrite below to catch; needs its own rule here.
  const ownerPtyRuntimeTs = readFileSync(resolve(repoRoot, "src/lib/mission/owner-pty-runtime.ts"), "utf8");
  const ownerPtyRuntimeJs = transpile(ownerPtyRuntimeTs)
    .replace('"./mission-relay-client"', '"./mission-relay-client.js"')
    .replace('"./mission-pty-runtime"', '"./mission-pty-runtime.js"');
  writeFileSync(resolve(outDir, "owner-pty-runtime.js"), ownerPtyRuntimeJs);

  // Item #11/#29 local memory exporter — same dynamic-import situation as
  // owner-pty-runtime.js above. Now redacts every transcript through
  // session-redaction.ts (item #35's capture-pipeline hardening) before
  // writing it to disk, so it gained one real "@/" import.
  const memoryExportCoreTs = readFileSync(resolve(repoRoot, "src/lib/memory-export-core.ts"), "utf8");
  const memoryExportCoreJs = transpile(memoryExportCoreTs)
    .replace(/["']@\/lib\/session-redaction["']/g, '"./session-redaction.js"')
    .replace(/["']@\/lib\/cross-agent-capture-core["']/g, '"./cross-agent-capture-core.js"');
  writeFileSync(resolve(outDir, "memory-export-core.js"), memoryExportCoreJs);

  // Item #9 Phase 1a — resident-served real files, no Tauri needed.
  const missionFsProtocolTs = readFileSync(resolve(repoRoot, "src/lib/mission/mission-fs-protocol.ts"), "utf8");
  const missionFsProtocolJs = transpile(missionFsProtocolTs)
    .replace('"./mission-pty-protocol"', '"./mission-pty-protocol.js"');
  writeFileSync(resolve(outDir, "mission-fs-protocol.js"), missionFsProtocolJs);

  const fsTreeHostTs = readFileSync(resolve(repoRoot, "src/lib/bridge/fs-tree-host.ts"), "utf8");
  const fsTreeHostJs = transpile(fsTreeHostTs)
    .replace('"../mission/mission-fs-protocol"', '"./mission-fs-protocol.js"');
  writeFileSync(resolve(outDir, "fs-tree-host.js"), fsTreeHostJs);

  const ownerFsRuntimeTs = readFileSync(resolve(repoRoot, "src/lib/mission/owner-fs-runtime.ts"), "utf8");
  const ownerFsRuntimeJs = transpile(ownerFsRuntimeTs)
    .replace('"./mission-relay-client"', '"./mission-relay-client.js"')
    .replace('"../bridge/fs-tree-host"', '"./fs-tree-host.js"')
    .replace('"./mission-fs-protocol"', '"./mission-fs-protocol.js"');
  writeFileSync(resolve(outDir, "owner-fs-runtime.js"), ownerFsRuntimeJs);

  const localMissionBridgeBootstrapTs = readFileSync(resolve(repoRoot, "src/lib/bridge/local-mission-bridge-bootstrap.ts"), "utf8");
  const localMissionBridgeBootstrapJs = transpile(localMissionBridgeBootstrapTs)
    .replace(/['"]\.\.\/\.\.\/\.\.\/services\/mission-bridge\/src\/bridge-runtime['"]/g, '"./bridge-runtime.js"')
    .replace(/['"]\.\.\/provider-adapter-config['"]/g, '"./provider-adapter-config.js"')
    .replace(/['"]\.\.\/oathlock-watchdog['"]/g, '"./oathlock-watchdog.js"')
    .replace(/['"]\.\.\/oathlock-cli-core['"]/g, '"./oathlock-cli-core.js"');
  writeFileSync(resolve(outDir, "local-mission-bridge-bootstrap.js"), localMissionBridgeBootstrapJs);

  const localMissionBridgeRunnerTs = readFileSync(resolve(repoRoot, "src/lib/bridge/local-mission-bridge-runner.ts"), "utf8");
  const localMissionBridgeRunnerJs = transpile(localMissionBridgeRunnerTs)
    .replace(/['"]\.\/local-mission-bridge-bootstrap['"]/g, '"./local-mission-bridge-bootstrap.js"')
    .replace(/['"]\.\.\/resident-supervisor['"]/g, '"./resident-supervisor.js"');
  writeFileSync(resolve(outDir, "local-mission-bridge-runner.js"), localMissionBridgeRunnerJs);

  // Local terminal bridge — packaged with the CLI so users can launch literal
  // provider terminals with `oathlock terminal bridge` from any repository.
  const terminalProtocolTs = readFileSync(resolve(repoRoot, "packages/runtime-core/src/local-terminal-protocol.ts"), "utf8");
  writeFileSync(resolve(outDir, "local-terminal-protocol.js"), transpile(terminalProtocolTs));

  const terminalLauncherTs = readFileSync(resolve(repoRoot, "src/lib/local-terminal-runtime-launcher.ts"), "utf8");
  const terminalLauncherJs = transpile(terminalLauncherTs)
    .replace(/['"]@\/lib\/local-terminal-protocol['"]/g, '"./local-terminal-protocol.js"');
  writeFileSync(resolve(outDir, "local-terminal-runtime-launcher.js"), terminalLauncherJs);

  const terminalBridgeCoreTs = readFileSync(resolve(repoRoot, "src/lib/local-terminal-bridge-core.ts"), "utf8");
  const terminalBridgeCoreJs = transpile(terminalBridgeCoreTs)
    .replace(/['"]@\/lib\/local-terminal-protocol['"]/g, '"./local-terminal-protocol.js"');
  writeFileSync(resolve(outDir, "local-terminal-bridge-core.js"), terminalBridgeCoreJs);

  const terminalSessionTs = readFileSync(resolve(repoRoot, "src/lib/local-terminal-session-manager.ts"), "utf8");
  const terminalSessionJs = transpile(terminalSessionTs)
    .replace(/['"]@\/lib\/local-terminal-bridge-core['"]/g, '"./local-terminal-bridge-core.js"')
    .replace(/['"]@\/lib\/resident-activity-journal['"]/g, '"./resident-activity-journal.js"');
  writeFileSync(resolve(outDir, "local-terminal-session-manager.js"), terminalSessionJs);

  const localProviderWorkspacePageTs = readFileSync(resolve(repoRoot, "src/lib/local-provider-workspace-page.ts"), "utf8");
  const localProviderWorkspacePageJs = transpile(localProviderWorkspacePageTs)
    .replace(/['"]@\/lib\/local-terminal-protocol['"]/g, '"./local-terminal-protocol.js"')
    .replace(/['"]@\/lib\/provider-adapter-config['"]/g, '"./provider-adapter-config.js"');
  writeFileSync(resolve(outDir, "local-provider-workspace-page.js"), localProviderWorkspacePageJs);

  const terminalBridgeTs = readFileSync(resolve(repoRoot, "scripts/oathlock-terminal-bridge.ts"), "utf8");
  const terminalBridgeJs = transpile(terminalBridgeTs)
    .replace(/['"]\.\.\/src\/lib\/local-terminal-bridge-core['"]/g, '"./local-terminal-bridge-core.js"')
    .replace(/['"]\.\.\/src\/lib\/local-terminal-session-manager['"]/g, '"./local-terminal-session-manager.js"')
    .replace(/['"]\.\.\/src\/lib\/resident-activity-journal['"]/g, '"./resident-activity-journal.js"')
    .replace(/['"]\.\.\/src\/lib\/resident-supervisor['"]/g, '"./resident-supervisor.js"')
    .replace(/['"]\.\.\/src\/lib\/local-terminal-protocol['"]/g, '"./local-terminal-protocol.js"')
    .replace(/['"]\.\.\/src\/lib\/local-provider-workspace-page['"]/g, '"./local-provider-workspace-page.js"')
    .replace(/['"]\.\.\/src\/lib\/provider-adapter-config['"]/g, '"./provider-adapter-config.js"');
  writeFileSync(resolve(outDir, "oathlock-terminal-bridge.js"), terminalBridgeJs);

  // 3. Core — node-only imports plus app aliases rewritten to shipped files.
  const coreTs = readFileSync(resolve(repoRoot, "src/lib/oathlock-cli-core.ts"), "utf8");
  const coreJs = transpile(coreTs)
    .replace(/["']@\/lib\/oathlock-bootstrap-core["']/g, '"./oathlock-bootstrap-core.js"')
    .replace(/["']@\/lib\/adapter-contract["']/g, '"./adapter-contract.js"')
    .replace(/["']@\/lib\/provider-adapter-config["']/g, '"./provider-adapter-config.js"')
    .replace(/["']@\/lib\/agent-detection-core["']/g, '"./agent-detection-core.js"')
    .replace(/["']@\/lib\/cross-agent-capture-setup-core["']/g, '"./cross-agent-capture-setup-core.js"')
    .replace(/["']@\/lib\/agent-heartbeat["']/g, '"./agent-heartbeat.js"')
    .replace(/["']@\/lib\/native\/native-commands["']/g, '"./native-commands.js"')
    .replace(/["']@\/lib\/native\/memory-command["']/g, '"./memory-command.js"');
  writeFileSync(resolve(outDir, "oathlock-cli-core.js"), coreJs);

  // 4. Entry — rewrite the "@/lib/oathlock-cli-core" alias to a relative import,
  //    then prepend the shebang so it runs as a bin.
  const entryTs = readFileSync(resolve(repoRoot, "scripts/m9r-cli.ts"), "utf8");
  let entryJs = transpile(entryTs).replace(
    /["']@\/lib\/oathlock-cli-core["']/g,
    '"./oathlock-cli-core.js"',
  );
  entryJs = entryJs.replace(
    /["']@\/lib\/oathlock-resident-core["']/g,
    '"./oathlock-resident-core.js"',
  );
  entryJs = entryJs.replace(
    /["']@\/lib\/resident-service-plan["']/g,
    '"./resident-service-plan.js"',
  );
  entryJs = entryJs.replace(
    /["']@\/lib\/local-terminal-runtime-launcher["']/g,
    '"./local-terminal-runtime-launcher.js"',
  );
  entryJs = entryJs.replace(
    /["']@\/lib\/resident-supervisor["']/g,
    '"./resident-supervisor.js"',
  );
  entryJs = entryJs.replace(
    /["']@\/lib\/resident-profile-source["']/g,
    '"./resident-profile-source.js"',
  );
  entryJs = entryJs.replace(
    /["']@\/lib\/oathlock-windows-service["']/g,
    '"./oathlock-windows-service.js"',
  );
  entryJs = entryJs.replace(
    /["']@\/lib\/oathlock-autostart["']/g,
    '"./oathlock-autostart.js"',
  );
  entryJs = entryJs.replace(
    /["']@\/lib\/oathlock-watchdog["']/g,
    '"./oathlock-watchdog.js"',
  );
  entryJs = entryJs.replace(
    /["']@\/lib\/cross-agent-capture-core["']/g,
    '"./cross-agent-capture-core.js"',
  );
  entryJs = entryJs.replace(
    /["']@\/lib\/local-terminal-protocol["']/g,
    '"./local-terminal-protocol.js"',
  );
  entryJs = entryJs.replace(
    /["']@\/lib\/provider-adapter-config["']/g,
    '"./provider-adapter-config.js"',
  );
  entryJs = entryJs.replace(
    /["']\.\/oathlock-terminal-bridge["']/g,
    '"./oathlock-terminal-bridge.js"',
  );
  entryJs = entryJs.replace(
    /["']\.\.\/src\/lib\/mission\/owner-pty-runtime["']/g,
    '"./owner-pty-runtime.js"',
  );
  entryJs = entryJs.replace(
    /["']\.\.\/src\/lib\/mission\/owner-fs-runtime["']/g,
    '"./owner-fs-runtime.js"',
  );
  entryJs = entryJs.replace(
    /["']\.\.\/src\/lib\/memory-export-core["']/g,
    '"./memory-export-core.js"',
  );
  entryJs = entryJs.replace(
    /["']\.\.\/src\/lib\/cross-agent-capture-core["']/g,
    '"./cross-agent-capture-core.js"',
  );
  entryJs = entryJs.replace(
    /["']\.\.\/src\/lib\/opencode-capture-backfill-core["']/g,
    '"./opencode-capture-backfill-core.js"',
  );
  if (!entryJs.startsWith(SHEBANG)) entryJs = SHEBANG + entryJs;
  const entryPath = resolve(outDir, "m9r.js");
  writeFileSync(entryPath, entryJs);
  // Keep the historical `oathlock` executable as a compatibility alias while
  // `m9r-cli` is the primary package/bin name. It must be the same compiled
  // entry rather than a wrapper that reintroduces source-relative imports.
  writeFileSync(resolve(outDir, "oathlock.js"), entryJs);
  // Best-effort executable bit (npm also sets this on install).
  try {
    chmodSync(entryPath, 0o755);
  } catch {
    /* non-POSIX filesystem — npm handles the bit at install time */
  }

  // A running resident/bridge process has no way to know a rebuild happened
  // out from under it -- confirmed live tonight: a process that had been
  // running for hours after several rebuilds kept silently executing its
  // original stale code with zero signal, and the only way to notice was
  // manually diffing process start times against git history. Stamping the
  // build time here is what buildFreshnessCheck() (oathlock-cli-core.ts)
  // compares its own startup-captured value against on every poll cycle.
  writeFileSync(resolve(outDir, "build-info.json"), JSON.stringify({ builtAt: new Date().toISOString() }, null, 2) + "\n");

  console.log(`Built CLI -> ${outDir}`);
}

build();
