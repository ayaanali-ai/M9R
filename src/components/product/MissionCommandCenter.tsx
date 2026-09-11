"use client";

import { useState } from "react";
import MissionConversationWorkspace from "./MissionConversationWorkspace";
import type { MissionSummaryDto } from "@/lib/mission/mission-application-service";

const tabs = [
  { id: "workspace", label: "Mission Workspace" },
  { id: "conversation", label: "Conversation" },
] as const;

type TabId = (typeof tabs)[number]["id"];

export default function MissionCommandCenter({
  missionId,
  mission,
  viewerUserId,
}: {
  missionId: string;
  mission: MissionSummaryDto;
  viewerUserId: string | null;
}) {
  const [activeTab, setActiveTab] = useState<TabId>("workspace");

  return (
    <section className="mt-6 overflow-hidden rounded-[var(--ol-radius-lg)] border border-[color:var(--ol-border-subtle)] bg-[color:var(--ol-surface-1)]">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[color:var(--ol-border-subtle)] px-5 py-4">
        <div className="min-w-0">
          <p className="ol-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--ol-text-muted)]">Mission Command Center</p>
          <h2 className="mt-1 truncate text-lg font-semibold text-[color:var(--ol-text-primary)]">{mission.objective}</h2>
          <p className="mt-1 text-xs text-[color:var(--ol-text-muted)]">{mission.repository} · {mission.state}</p>
        </div>
        <nav aria-label="Mission views" className="flex items-center gap-1 rounded-md border border-[color:var(--ol-border-subtle)] p-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              aria-current={activeTab === tab.id ? "page" : undefined}
              className={`rounded px-3 py-1.5 text-xs font-medium transition ${activeTab === tab.id
                ? "bg-[color:var(--ol-surface-2)] text-[color:var(--ol-text-primary)]"
                : "text-[color:var(--ol-text-muted)] hover:text-[color:var(--ol-text-primary)]"}`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === "workspace" ? (
        <div className="grid gap-4 p-5 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="State" value={mission.state} />
          <Metric label="Assignments" value={String(Object.values(mission.assignmentSummary).reduce((sum, count) => sum + count, 0))} />
          <Metric label="Evidence" value={String(mission.evidenceSummary.total)} />
          <Metric label="Open findings" value={String(mission.openFindingsCount)} />
        </div>
      ) : (
        <MissionConversationWorkspace missionId={missionId} workspaceId={mission.workspaceId} mission={mission} viewerUserId={viewerUserId} />
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[color:var(--ol-border-subtle)] bg-[color:var(--ol-surface-2)] px-4 py-3">
      <p className="ol-mono text-[10px] uppercase tracking-[0.16em] text-[color:var(--ol-text-muted)]">{label}</p>
      <p className="mt-2 text-sm font-medium text-[color:var(--ol-text-primary)]">{value}</p>
    </div>
  );
}
