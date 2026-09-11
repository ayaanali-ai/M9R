"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import WatchfloorOps from "@/components/product/WatchfloorOps";
import ConversationPanel, { type WorkspaceStep } from "@/components/product/ConversationPanel";
import {
  selectCurrentRun,
  type AgentView,
  type WsRule,
} from "@/lib/agent-workspace-data";
import type { RunPassport } from "@/lib/run-passport-service";
import type { AgentApprovalCenter } from "@/lib/agent-approval-center";
import { watchfloorHref } from "@/lib/run-navigation";
import { MobileAgentRail, ConnectCeremony, ControlStrip } from "@/components/product/agent-workspace/strip-board";
import { WorkspaceDrawer, ApprovalCenter } from "@/components/product/agent-workspace/approval-center";
import { HeroRun } from "@/components/product/agent-workspace/run-panels";
import { AssignmentPanel } from "@/components/product/agent-workspace/preflight";
import { LiveFileView, WhispersPanel, DraftsPanel, ChannelPeoplePanel, LiveSessionsPanel } from "@/components/product/agent-workspace/files-panel";
import { KeyMap, byLastSeen, agentForRun, type Selected, type RunZone } from "@/components/product/agent-workspace/shared";

/**
 * AgentWorkspaceClient — the chat surface.
 * ----------------------------------------------------------------------------
 * The operating surface where agents work under supervision. Two zones the
 * structure itself teaches: Agent Activity (dock + the live run process in the
 * center) and Human Decision (the Approval Center drawer). All displayed data
 * is run-linked and owner-scoped; unlinked historical records stay stored for
 * audit but out of the normal floor.
 *
 * Subcomponents live in ./agent-workspace/* (approval-center, run-panels,
 * preflight, strip-board, handoff, shared) — this file wires state/data and
 * renders them. This is the only file external code imports from.
 */

const LIVE_REFRESH_INTERVAL_MS = 2_000;
const IDLE_REFRESH_INTERVAL_MS = 10_000;

const WHISPER_PRESENCE_POLL_INTERVAL_MS = 60_000;

export default function AgentWorkspaceClient({
  agents,
  viewerUserId,
  workspaceId,
  approvalRules,
  approvalCenter,
  passports,
  initialHasWhispers,
}: {
  agents: AgentView[];
  viewerUserId?: string | null;
  workspaceId?: string | null;
  approvalRules: WsRule[];
  approvalCenter: AgentApprovalCenter;
  passports: RunPassport[];
  initialHasWhispers?: boolean;
}) {
  // Whispers is real but usually empty -- the toggle only shows when there's
  // something to show. Server-seeded (see page.tsx) so it's correct on first
  // paint, then refreshed on a light 60s poll against the cheap
  // whisper-activity endpoint -- not the conversations firehose the panel's
  // own message list used to use.
  const [hasWhispers, setHasWhispers] = useState(Boolean(initialHasWhispers));
  useEffect(() => {
    let cancelled = false;
    function poll() {
      fetch("/api/dashboard/whisper-activity", { cache: "no-store" })
        .then((res) => res.json())
        .then((data: { totalCount30d?: number }) => {
          if (!cancelled) setHasWhispers((data.totalCount30d ?? 0) > 0);
        })
        .catch(() => { /* keep the last known value on a transient failure */ });
    }
    const id = window.setInterval(poll, WHISPER_PRESENCE_POLL_INTERVAL_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  // Agent selection is URL state (?agent=) so the sidebar picker, the floor
  // dock, and shared links are one system (see DESIGN.md).
  const searchParams = useSearchParams();
  const rawAgent = (searchParams.get("agent") ?? "all").trim();
  const selectedAgentId = agents.find((agent) => agent.id === rawAgent)?.id
    ?? agents.find((agent) => agent.key === rawAgent)?.id
    ?? null;
  const selected: Selected = selectedAgentId ?? "all";
  const [focusRequest, setFocusRequest] = useState<{ runId: string; zone: RunZone; nonce: number } | null>(null);
  // This surface is messaging-only now (D0): Activity and Decisions no longer
  // have their own tabs -- both live in this one right drawer, switched by
  // mode. The "run" drawer is the live run process only now: the Run
  // Passport document it used to embed, and the standalone
  // /dashboard/runs/[id] page it linked to, were both cut. Memory and Ready
  // for Review used to be drawer modes too (full-screen modal overlays) --
  // both moved into the one side-panel slot below, opened from header icons
  // instead of a buried "more actions" menu, per explicit direction: Files
  // and Ready for Review should be icons where search/Inbox used to be, and
  // both should open "in the side panel properly," not a separate overlay.
  // Memory's own drawer trigger was dropped outright (not relocated) --
  // Memory stays fully reachable from the primary nav's own Memory page.
  const [drawerMode, setDrawerMode] = useState<"run" | null>(null);
  const drawerTriggerRef = useRef<HTMLElement | null>(null);
  // One side-panel slot, one mode at a time -- Files and Ready for Review
  // used to be two independent, inconsistent mechanisms (a persistent rail
  // vs. a full-screen drawer). Collapse state persists per-browser so a
  // human who closes it stays closed, same as the old rail's own behavior.
  // Files and Activity tabs were removed outright (items #24/#25) -- Files
  // was a low-value raw file browser (the separate Live Code / LiveFileView
  // surface, opened via ?file=, is untouched and still reachable by direct
  // link even without the rail); Activity just dumped raw events with no
  // synthesis.
  type SidePanelMode = "review" | "whispers" | "drafts" | "people" | "live" | null;
  const [sidePanelMode, setSidePanelMode] = useState<SidePanelMode>(null);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("ol-side-panel-mode");
      // This effect hydrates browser-only panel preference state after SSR.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (stored === "review" || stored === "whispers" || stored === "drafts" || stored === "people" || stored === "live") setSidePanelMode(stored);
      else if (stored === "") setSidePanelMode(null);
    } catch { /* localStorage can throw in a private/locked-down browser -- default stays closed */ }
  }, []);
  function toggleSidePanel(mode: "review" | "whispers" | "drafts" | "people" | "live") {
    setSidePanelMode((current) => {
      const next = current === mode ? null : mode;
      try { window.localStorage.setItem("ol-side-panel-mode", next ?? ""); } catch { /* best-effort */ }
      return next;
    });
  }
  // Fed by ConversationPanel's existing relay subscription (no second relay
  // connection) -- see files-panel.tsx's own doc comment on why this is
  // scoped to the currently selected channel, not the whole workspace.
  const [liveFileSteps, setLiveFileSteps] = useState<WorkspaceStep[]>([]);
  // Which file is promoted into the main pane is URL state (?file=), the same
  // precedent ?agent= and ?conversation= already set on this surface: the rail
  // that switches it, the pane that renders it, and a link someone pastes into
  // a channel are then one system. File paths are opaque and can be absolute
  // Windows paths, so they always travel encodeURIComponent'd and are read
  // back decoded by URLSearchParams -- no path parsing anywhere.
  const openFilePath = searchParams.get("file");
  function selectFile(filePath: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (filePath) params.set("file", filePath); else params.delete("file");
    const query = params.toString();
    router.replace(query ? `/dashboard/agents?${query}` : "/dashboard/agents", { scroll: false });
  }
  function openDrawer(mode: "run") {
    drawerTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDrawerMode(mode);
  }
  function closeDrawer() {
    setDrawerMode(null);
    drawerTriggerRef.current?.focus();
    drawerTriggerRef.current = null;
  }
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() => {
    const requestedRun = searchParams.get("run")?.trim();
    if (requestedRun && agents.some((agent) => agent.runs.some((run) => run.id === requestedRun))) {
      return requestedRun;
    }
    const initialRuns = agents.flatMap((agent) => agent.runs).sort(byLastSeen);
    return initialRuns[0]?.id ?? null;
  });
  const router = useRouter();
  const [refreshPending, startRefreshTransition] = useTransition();
  const pendingDecisions = approvalCenter.counts.total;
  const prevPendingRef = useRef(pendingDecisions);
  const hasLiveRun = agents.some((agent) =>
    selectCurrentRun(agent.runs, { agentConnected: agent.connected }) !== null,
  );
  const hasLiveActivity = hasLiveRun || pendingDecisions > 0;

  // Liveness: the floor refreshes itself while visible, keeps relative times
  // ticking, badges the tab title, and (opt-in) notifies on new decisions.
  //
  // router.refresh() re-fetches this route's full Server Component payload,
  // which measured 3-5s round trip against real workspace data -- well over
  // the 2s "live" cadence. A plain setInterval doesn't know that, so it kept
  // firing a new refresh before the last one landed: overlapping in-flight
  // requests piled up (visible as a burst in the network log, not the
  // documented interval) and starved the page's other pollers. Wrapping the
  // call in useTransition and self-scheduling the *next* tick only once
  // refreshPending drops back to false makes one refresh finish before the
  // next is requested, so the real cadence never runs faster than the server
  // can actually answer.
  const refreshPendingRef = useRef(refreshPending);
  useEffect(() => {
    refreshPendingRef.current = refreshPending;
  }, [refreshPending]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleNext = (delay: number) => {
      if (cancelled) return;
      timer = setTimeout(tick, delay);
    };
    function tick() {
      if (cancelled) return;
      if (document.visibilityState === "visible" && !refreshPendingRef.current) {
        startRefreshTransition(() => router.refresh());
      }
      scheduleNext(hasLiveActivity ? LIVE_REFRESH_INTERVAL_MS : IDLE_REFRESH_INTERVAL_MS);
    }
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible" && !refreshPendingRef.current) {
        startRefreshTransition(() => router.refresh());
      }
    };
    scheduleNext(hasLiveActivity ? LIVE_REFRESH_INTERVAL_MS : IDLE_REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshWhenVisible);
    };
  }, [hasLiveActivity, router]);

  useEffect(() => {
    document.title = pendingDecisions > 0
      ? `(${pendingDecisions}) M9R`
      : "M9R";
    return () => {
      document.title = "M9R";
    };
  }, [pendingDecisions]);

  useEffect(() => {
    if (
      pendingDecisions > prevPendingRef.current &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      new Notification("M9R: decision waiting", {
        body: `${pendingDecisions} human decision${pendingDecisions === 1 ? "" : "s"} waiting for review.`,
      });
    }
    prevPendingRef.current = pendingDecisions;
  }, [pendingDecisions]);

  // Completion detection: notify when a run that was live on a previous
  // refresh transitions to submitted/completed (its evidence arrived).
  const runStatusSnapshot = useMemo(
    () => agents.flatMap((agent) => agent.runs.map((run) => ({ id: run.id, status: run.status.toLowerCase(), title: run.task_title, label: agent.label }))),
    [agents],
  );
  const prevRunStatusRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const prev = prevRunStatusRef.current;
    const finished = runStatusSnapshot.filter((run) =>
      (run.status === "completed" || run.status === "submitted") &&
      prev.has(run.id) && prev.get(run.id) !== run.status &&
      !["completed", "submitted"].includes(prev.get(run.id) ?? ""),
    );
    prevRunStatusRef.current = new Map(runStatusSnapshot.map((run) => [run.id, run.status]));
    if (finished.length > 0 && typeof Notification !== "undefined" && Notification.permission === "granted") {
      for (const run of finished) {
        new Notification(`M9R: ${run.label} finished`, {
          body: run.title ? `"${run.title}" is ready for review.` : "A run finished and is ready for review.",
        });
      }
    }
  }, [runStatusSnapshot]);

  const selectedAgent = selected === "all" ? null : agents.find((a) => a.id === selected) ?? null;
  const allRuns = useMemo(() => agents.flatMap((a) => a.runs).sort(byLastSeen), [agents]);
  const visibleRuns = selectedAgent ? selectedAgent.runs : allRuns;
  const resolvedSelectedRunId = visibleRuns.some((run) => run.id === selectedRunId)
    ? selectedRunId
    : visibleRuns[0]?.id ?? null;
  const selectedRun = visibleRuns.find((run) => run.id === resolvedSelectedRunId) ?? null;
  const selectedRunAgent = selectedRun ? agentForRun(agents, selectedRun) : selectedAgent;
  const selectedPassport = passports.find((passport) => passport.run_id === resolvedSelectedRunId) ?? null;
  const currentRun = selectedAgent
    ? selectCurrentRun(selectedAgent.runs, { agentConnected: selectedAgent.connected })
    : null;
  // Every agent's live run counts as "current" for strip-bay placement.
  const currentRunIds = useMemo(() => new Set(
    agents
      .map((agent) => selectCurrentRun(agent.runs, { agentConnected: agent.connected })?.id)
      .filter((id): id is string => Boolean(id)),
  ), [agents]);
  const newestVisibleRunId = visibleRuns[0]?.id ?? null;
  const previousNewestRunIdRef = useRef(newestVisibleRunId);
  useEffect(() => {
    const previousNewestRunId = previousNewestRunIdRef.current;
    previousNewestRunIdRef.current = newestVisibleRunId;
    if (
      newestVisibleRunId &&
      newestVisibleRunId !== previousNewestRunId &&
      currentRunIds.has(newestVisibleRunId)
    ) {
      setSelectedRunId(newestVisibleRunId);
      const owner = agentForRun(agents, visibleRuns[0]);
      router.replace(watchfloorHref(owner?.id ?? selected, newestVisibleRunId), { scroll: false });
    }
  }, [agents, currentRunIds, newestVisibleRunId, router, selected, visibleRuns]);
  function selectAgent(next: Selected) {
    const nextRuns = next === "all"
      ? allRuns
      : agents.find((agent) => agent.id === next)?.runs ?? [];
    const nextRunId = nextRuns[0]?.id ?? null;
    router.replace(watchfloorHref(next, nextRunId), { scroll: false });
    setSelectedRunId(nextRunId);
  }

  // Operator keys: j/k walk the ledger, Enter opens the run drawer, a opens
  // the Approval Center, ? shows the map.
  const [keyMapOpen, setKeyMapOpen] = useState(false);
  const focusNonceRef = useRef(0);
  const keyStateRef = useRef({ runs: visibleRuns, selectedRunId: resolvedSelectedRunId, drawerOpen: drawerMode !== null });

  useEffect(() => {
    keyStateRef.current = { runs: visibleRuns, selectedRunId: resolvedSelectedRunId, drawerOpen: drawerMode !== null };
  }, [visibleRuns, resolvedSelectedRunId, drawerMode]);

  /** Select a run and open the Run Detail drawer on its evidence zone. */
  function focusRun(runId: string, zone: RunZone) {
    const run = allRuns.find((candidate) => candidate.id === runId);
    const owner = run ? agentForRun(agents, run) : selectedAgent;
    router.replace(watchfloorHref(owner?.id ?? selected, runId), { scroll: false });
    setSelectedRunId(runId);
    focusNonceRef.current += 1;
    setFocusRequest({ runId, zone, nonce: focusNonceRef.current });
    openDrawer("run");
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const { runs, selectedRunId: current, drawerOpen } = keyStateRef.current;
      if (event.key === "?" ) {
        setKeyMapOpen((open) => !open);
        return;
      }
      if (event.key === "Escape") {
        setKeyMapOpen(false);
        return;
      }
      if (drawerOpen) return;
      if (event.key === "a") {
        toggleSidePanel("review");
      } else if (event.key === "j" || event.key === "k") {
        if (runs.length === 0) return;
        const index = Math.max(0, runs.findIndex((run) => run.id === current));
        const next = runs[Math.min(runs.length - 1, Math.max(0, index + (event.key === "j" ? 1 : -1)))];
        if (next) setSelectedRunId(next.id);
      } else if (event.key === "Enter" && current) {
        // Enter used to open the standalone Run Passport page; with that
        // surface gone it opens the same run drawer j/k walks.
        focusRun(current, "evidence");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // The key handler intentionally reads the current focus helper through this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, router, selectedAgent]);

  return (
    <div className="wf-board">
      {/* Agent selection lives in the sidebar (?agent= URL state); a compact
          mobile rail keeps it reachable when the sidebar is off-screen. */}
      <MobileAgentRail agents={agents} selected={selected} onSelect={selectAgent} />

      <div className="wf-layout">
      <div className="wf-main min-w-0">
        <ControlStrip agent={selectedAgent} />

        <WatchfloorOps />

        {/* Permission requests and evidence submissions now render as inline
            approve/reject cards in the message feed itself (ConversationPanel),
            same as evidence requests, findings, and rule drafts -- no separate
            top-of-page banner needed any more.

            Live Code: when a file is open (?file=), LiveFileView renders as
            a third grid column (filePanel, see .wf-chat-file-slot) beside
            chat, not a takeover -- chat and the composer stay fully visible
            and usable while a real-time Monaco view of the file shows on
            the right, decorated with whichever agent's real edit last
            touched it. The Files rail/tab itself was removed (item #24) --
            this view is now reachable only via a direct ?file= link (e.g.
            from a diff or step reference elsewhere), not from its own
            navigation surface.
            WatchfloorOps needs no such call: it renders null unless given an
            authorizationStrip, which this surface never passes. */}
        <ConversationPanel
          agents={agents}
          workspaceId={workspaceId ?? agents[0]?.workspaceId ?? null}
          viewerUserId={viewerUserId ?? null}
          onFileStep={(step) => setLiveFileSteps((current) => [...current, step].slice(-300))}
          // The Change Wall (Option A step 12) now renders INSIDE
          // ConversationPanel's own wf-chat-shell grid (via this prop) rather
          // than as a separate outer sibling -- that split used to mean two
          // independent bordered boxes with two independent height budgets
          // and mismatched internal scrollbars, confirmed ugly live. One
          // shared shell, one shared height, still not a full-viewport
          // app-shell -- the page itself keeps scrolling normally, per the
          // standing prior decision recorded in .wf-chat-shell's own comment
          // in globals.css.
          sidePanel={sidePanelMode === "review" ? (
            <>
              <div className="wf-files-rail-header">
                <span>Ready for Review</span>
                <button type="button" className="wf-files-rail-collapse" onClick={() => toggleSidePanel("review")} aria-label="Collapse review panel">×</button>
              </div>
              <div className="wf-review-panel-body scrollbar-thin">
                <ApprovalCenter
                  center={approvalCenter}
                  approvals={approvalCenter.approvals}
                  selected="all"
                  agents={agents}
                  approvalRules={approvalRules}
                  passports={passports}
                  runs={allRuns}
                  onOpenRun={(runId, zone) => {
                    toggleSidePanel("review");
                    focusRun(runId, zone);
                  }}
                />
              </div>
            </>
          ) : sidePanelMode === "whispers" ? (
            <WhispersPanel agents={agents} onClose={() => toggleSidePanel("whispers")} />
          ) : sidePanelMode === "drafts" ? (
            <DraftsPanel conversationId={searchParams.get("conversation")} agents={agents} onClose={() => toggleSidePanel("drafts")} />
          ) : sidePanelMode === "people" ? (
            <ChannelPeoplePanel conversationId={searchParams.get("conversation")} onClose={() => toggleSidePanel("people")} />
          ) : sidePanelMode === "live" ? (
            <LiveSessionsPanel agents={agents} onClose={() => toggleSidePanel("live")} />
          ) : null}
          onOpenReview={() => toggleSidePanel("review")}
          reviewActive={sidePanelMode === "review"}
          pendingReviewCount={approvalCenter.counts.total}
          onOpenWhispers={hasWhispers ? () => toggleSidePanel("whispers") : undefined}
          whispersActive={sidePanelMode === "whispers"}
          onOpenDrafts={() => toggleSidePanel("drafts")}
          draftsActive={sidePanelMode === "drafts"}
          onOpenPeople={() => toggleSidePanel("people")}
          peopleActive={sidePanelMode === "people"}
          onOpenLive={() => toggleSidePanel("live")}
          liveActive={sidePanelMode === "live"}
          filePanel={openFilePath ? (
            <LiveFileView
              agents={agents}
              filePath={openFilePath}
              liveSteps={liveFileSteps}
              onBack={() => selectFile(null)}
            />
          ) : null}
        />
      </div>

      {/* The "waiting on you" bar (StripBoard) used to render here. Removed:
          it was showing runs in the evidence/approval review stage, which is
          exactly the same condition evidenceApproval/passportApproval/
          missingEvidenceApproval already cover in agent-approval-center.ts --
          already counted into approvalCenter.counts.total and already
          reachable through the Approval Center button above. It was a
          genuinely redundant surface eating a fixed share of this
          non-scrolling shell's height budget for information shown twice. */}

      {drawerMode === "run" && (
        <WorkspaceDrawer
          kicker="Agent Activity"
          title={selectedAgent?.label ?? "Run Detail"}
          description="Connect, assign, and review the active agent run."
          onClose={closeDrawer}
        >
          {selectedAgent && !selectedAgent.connected && <ConnectCeremony agent={selectedAgent} />}
          {selectedAgent?.connected && selectedAgent.connectionId && (
            <AssignmentPanel key={`assignment-${selectedAgent.connectionId}`} agent={selectedAgent} />
          )}
          <HeroRun
            key={`${resolvedSelectedRunId ?? "no-run"}:${focusRequest?.runId === resolvedSelectedRunId ? focusRequest.nonce : 0}`}
            run={selectedRun}
            agent={selectedRunAgent}
            fallbackAgent={selectedAgent}
            passport={selectedPassport}
            isCurrentRun={Boolean(selectedRun && currentRun && selectedRun.id === currentRun.id)}
            initialZone={focusRequest?.runId === resolvedSelectedRunId ? focusRequest.zone : null}
          />
        </WorkspaceDrawer>
      )}

      </div>

      {keyMapOpen && <KeyMap onClose={() => setKeyMapOpen(false)} />}
    </div>
  );
}
