"use client";

import type { ReactNode } from "react";
import type { AgentView } from "@/lib/agent-workspace-data";
import type { AgentUsageView } from "@/lib/agent-usage";
import type { ProviderAccountUsage } from "@/lib/provider-account-usage";
import type { RunPassport } from "@/lib/run-passport-service";

/**
 * The ad-hoc/legacy live-sessions floor (per-agent 5H/7D usage measured
 * against human-set budgets) has been removed: M9R does not call
 * provider APIs for session usage or rate limits, so that view could only
 * ever show numbers the operator typed in, never a real limit. The
 * follow-on observed-provider-usage panel (ObservedUsageTelemetry) has
 * also been removed per design direction: no usage telemetry panel on
 * the Watchfloor at all (see docs/design D0).
 */
export default function WatchfloorOps({ forcedMode, authorizationStrip }: {
  /** Legacy design-bench inputs remain accepted so old reference pages keep compiling. */
  agents?: AgentView[];
  usage?: AgentUsageView[];
  providerUsage?: ProviderAccountUsage[];
  passports?: RunPassport[];
  pendingDecisions?: number;
  selectedKey?: string;
  onSelectAgent?: (key: string) => void;
  onSelectRun?: (runId: string) => void;
  runId?: string | null;
  forcedMode?: "day" | "night";
  authorizationStrip?: ReactNode;
}) {
  if (!authorizationStrip) return null;

  return (
    <section className="wf-floor" data-mode={forcedMode} aria-label="Agent operations">
      {authorizationStrip}
    </section>
  );
}
