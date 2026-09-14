"use client";

/**
 * Surfaces the machine-level CLI connection as its own visible signal,
 * distinct from per-agent connection state. Per-agent chips (Codex/Claude
 * Code/OpenCode) already show live status; nothing showed whether the local
 * M9R CLI/runtime itself was ever connected on any machine at all --
 * confirmed as a real gap when a user assumed agents connect directly to
 * M9R, not realizing the CLI has to run first. `agentStatus.agents` is
 * now keeps durable registrations in the list and separates them from
 * fresh heartbeat leases (see loadAgentStatusSummary). A missing heartbeat
 * is therefore a reconnecting state, not a new-setup state.
 *
 * Deliberately informational only, shown only when actually disconnected --
 * locked in explicitly rather than assumed: no gating of other dashboard
 * actions, and no permanent chip cluttering the UI while things are healthy.
 */
export default function MachineConnectionBanner({ hasLiveConnection, hasRegisteredConnection, reviewerDemo }: { hasLiveConnection: boolean; hasRegisteredConnection: boolean; reviewerDemo: boolean }) {
  if (hasLiveConnection || reviewerDemo) return null;
  if (hasRegisteredConnection) {
    return (
      <div className="machine-connection-banner" role="status" data-state="reconnecting">
        <div className="machine-connection-banner-text">
          <strong>Registered agents are offline and reconnecting.</strong>
          <span>Your agent registrations are still intact. M9R will keep them visible and resume when a runtime heartbeat returns. No new approval is required.</span>
        </div>
        <code className="machine-connection-banner-command">npx m9r-cli terminal runtime</code>
      </div>
    );
  }
  return (
    <div className="machine-connection-banner" role="status">
      <div className="machine-connection-banner-text">
        <strong>No agent runtime is currently reaching this workspace.</strong>
        <span>This usually means the M9R CLI hasn&apos;t been connected on any machine yet, or it stopped running. Run this once in the repository you control:</span>
      </div>
      <code className="machine-connection-banner-command">npx m9r-cli init</code>
    </div>
  );
}
