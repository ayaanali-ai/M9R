"use client";

import { ChevronLeft, SquareTerminal, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { TerminalPane } from "./TerminalPane";
import { ChromeButton } from "@/components/ui/chrome-button";
import type { RelayFrame } from "@/lib/mission/mission-relay-protocol";
import type { PtySessionStatus } from "@/lib/mission/mission-pty-protocol";

/**
 * The chat ⇄ terminal toggle's terminal side, per item 21's spec: a view on
 * the same channel, not a separate page. Tiles one pane per live session in
 * this room -- "room" is just the current channel, so there's no separate
 * room switcher here the way Mosaic's cross-channel UI needs one.
 *
 * Deliberately does not open its own relay connection. ConversationPanel
 * already holds the one live socket for this channel (chat, presence, steps,
 * huddles all ride it); a second one would double the Relay's per-connection
 * auth and heartbeat cost for zero benefit. sendFrame/subscribeFrames are the
 * seam onto that existing connection.
 *
 * Item #28 Part B: dragging a pane's link handle onto another pane merges
 * the two into a shared Room -- confirmed frame-by-frame against the real
 * reference demo, this links two already-independent, already-running
 * sessions (never invites a new one, never merges the underlying shells).
 * v1 here is deliberately scoped to sessions already tiled in this same
 * channel; cross-channel linking needs a target picker across channels that
 * doesn't exist anywhere else in this app yet, so it's a follow-up, not part
 * of proving the mechanism.
 */

export interface PtyRoomSession {
  sessionId: string;
  title?: string;
  status: PtySessionStatus;
  ownerParticipantId: string;
  /** Default true. See PtySharePayload -- the owner-controlled Sharing toggle. */
  shared: boolean;
  /** Whether the current viewer owns this pane -- only the owner may toggle Sharing. */
  isOwner: boolean;
  /** Resolved display name of the owner, e.g. "Ayaan's Claude Code". */
  ownerLabel?: string;
  /** Provider key, so each pane carries its own mark rather than being told apart by text alone. */
  agentKey?: string;
  /** Other live sessions this one has been linked into a shared Room with. */
  linkedSessionIds: string[];
}

export interface TerminalWorkspaceProps {
  channelLabel: string;
  sessions: PtyRoomSession[];
  sendFrame(type: "pty.input" | "pty.resize" | "pty.close" | "pty.share" | "pty.request" | "pty.link" | "pty.unlink", payload: Record<string, unknown>): boolean;
  subscribeFrames(listener: (frame: RelayFrame) => void): () => void;
  onBackToChat(): void;
}

interface LinkLine {
  originX: number;
  originY: number;
  x: number;
  y: number;
}

export function TerminalWorkspace({ channelLabel, sessions, sendFrame, subscribeFrames, onBackToChat }: TerminalWorkspaceProps) {
  // Exited sessions are kept out of the tiled grid but not silently lost --
  // this is the same "was it ever announced" distinction pty.state already
  // carries, just filtered for what's worth taking up screen space.
  const live = useMemo(() => sessions.filter((session) => session.status === "running"), [sessions]);
  // Item #28 Part A: opening a terminal is now a real, explicit human
  // action (never auto-opened per provider the moment a channel loads --
  // see owner-pty-runtime.ts), so the button to do it only makes sense
  // once, for whichever viewer doesn't already have their own live pane
  // here. Someone else's terminal already being open in this room has no
  // bearing on whether THIS viewer has theirs.
  const hasOwnSession = live.some((session) => session.isOwner);

  function requestTerminal() {
    sendFrame("pty.request", {});
  }

  // Part B: group already-linked sessions into one shared Room wrapper.
  // A session with no links renders exactly as before -- grouping is purely
  // additive, so linking never changes how an unlinked pane looks.
  const groups = useMemo(() => {
    const byId = new Map(live.map((session) => [session.sessionId, session]));
    const visited = new Set<string>();
    const result: PtyRoomSession[][] = [];
    for (const session of live) {
      if (visited.has(session.sessionId)) continue;
      const stack = [session.sessionId];
      const group: PtyRoomSession[] = [];
      visited.add(session.sessionId);
      while (stack.length > 0) {
        const id = stack.pop()!;
        const current = byId.get(id);
        if (!current) continue;
        group.push(current);
        for (const linkedId of current.linkedSessionIds) {
          if (!visited.has(linkedId) && byId.has(linkedId)) {
            visited.add(linkedId);
            stack.push(linkedId);
          }
        }
      }
      result.push(group);
    }
    return result;
  }, [live]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragFromRef = useRef<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [line, setLine] = useState<LinkLine | null>(null);
  const [hoveredTargetId, setHoveredTargetId] = useState<string | null>(null);

  function handleLinkDragStart(sessionId: string, event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    const originX = event.clientX - (rect?.left ?? 0);
    const originY = event.clientY - (rect?.top ?? 0);
    dragFromRef.current = sessionId;
    setLine({ originX, originY, x: originX, y: originY });
    setDragActive(true);
  }

  useEffect(() => {
    if (!dragActive) return;
    function targetIdAt(clientX: number, clientY: number): string | null {
      const el = document.elementFromPoint(clientX, clientY);
      const target = el?.closest("[data-terminal-session-id]") as HTMLElement | null;
      return target?.dataset.terminalSessionId ?? null;
    }
    function onMove(event: PointerEvent) {
      const rect = containerRef.current?.getBoundingClientRect();
      setLine((current) => current ? { ...current, x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) } : current);
      const targetId = targetIdAt(event.clientX, event.clientY);
      setHoveredTargetId(targetId && targetId !== dragFromRef.current ? targetId : null);
    }
    function onUp(event: PointerEvent) {
      const targetId = targetIdAt(event.clientX, event.clientY);
      const fromSessionId = dragFromRef.current;
      if (fromSessionId && targetId && targetId !== fromSessionId) {
        sendFrame("pty.link", { sessionId: fromSessionId, targetSessionId: targetId });
      }
      dragFromRef.current = null;
      setDragActive(false);
      setLine(null);
      setHoveredTargetId(null);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragActive, sendFrame]);

  function unlinkOwnSessionFrom(group: PtyRoomSession[]) {
    const own = group.find((session) => session.isOwner);
    if (!own) return;
    for (const targetSessionId of own.linkedSessionIds) {
      sendFrame("pty.unlink", { sessionId: own.sessionId, targetSessionId });
    }
  }

  return (
    <div className="wf-chat-terminal-workspace" ref={containerRef}>
      <header className="wf-chat-header">
        <div className="min-w-0">
          <h2>{channelLabel} — Terminal</h2>
          <p>{live.length === 0 ? "No live terminal sessions in this channel yet." : `${live.length} live session${live.length === 1 ? "" : "s"}`}</p>
        </div>
        <div className="wf-chat-actions">
          {/* The one primary action on this screen -- opening your own real
              shell is a bigger deal than any of the quiet secondary controls
              around it, so it's the one chrome moment here, same rule as the
              chat composer's Send button. */}
          {!hasOwnSession && (
            <ChromeButton onClick={requestTerminal}>
              <SquareTerminal size={14} aria-hidden style={{ marginRight: 6 }} />
              Open my terminal here
            </ChromeButton>
          )}
          {/* A real back control, not the 30x30 icon-toggle class stretched
              around a word -- this is the only way out of the terminal view,
              so it reads as a labelled action with a direction. */}
          <button type="button" className="wf-term-back" onClick={onBackToChat}>
            <ChevronLeft size={15} aria-hidden />
            <span>Back to chat</span>
          </button>
        </div>
      </header>

      {live.length === 0 ? (
        /* Not a bare sentence on black: the empty state shows the shape of the
           thing that's missing, so the surface reads as "nothing running yet"
           rather than "this feature is unfinished." */
        <div className="wf-chat-terminal-empty">
          <div className="wf-term-empty__frame" aria-hidden>
            <span className="wf-term-empty__bar">
              <i /><i /><i />
            </span>
            <code className="wf-term-empty__lines">
              <span className="wf-term-empty__prompt">$</span>
              <span className="wf-term-empty__caret" />
            </code>
          </div>
          <strong>No terminal running here yet</strong>
          <p>Click &ldquo;Open my terminal here&rdquo; to start a real shell on your own machine, shared with this room.</p>
        </div>
      ) : (
        <div className="wf-chat-terminal-grid" data-count={Math.min(live.length, 4)}>
          {groups.map((group) => {
            const linked = group.length > 1;
            const panes = group.map((session) => (
              <div
                key={session.sessionId}
                data-terminal-session-id={session.sessionId}
                data-link-target={hoveredTargetId === session.sessionId ? "true" : undefined}
                className="wf-term-pane-slot"
              >
                <TerminalPane
                  sessionId={session.sessionId}
                  title={session.title}
                  sendFrame={sendFrame}
                  subscribeFrames={subscribeFrames}
                  isOwner={session.isOwner}
                  shared={session.shared}
                  ownerLabel={session.ownerLabel}
                  onLinkDragStart={session.isOwner ? (event) => handleLinkDragStart(session.sessionId, event) : undefined}
                />
              </div>
            ));
            if (!linked) return panes;
            return (
              <div key={`room-${group[0].sessionId}`} className="wf-term-room-group">
                <div className="wf-term-room-group__header">
                  <Users size={13} aria-hidden />
                  <span>Room · {group.length} people</span>
                  {group.some((session) => session.isOwner) && (
                    <button type="button" className="wf-term-room-group__unlink" onClick={() => unlinkOwnSessionFrom(group)}>
                      Unlink
                    </button>
                  )}
                </div>
                <div className="wf-term-room-group__panes">{panes}</div>
              </div>
            );
          })}
        </div>
      )}

      {line ? (
        <svg className="wf-term-link-overlay" aria-hidden>
          <path
            className="wf-term-link-overlay__path"
            d={`M ${line.originX} ${line.originY} Q ${(line.originX + line.x) / 2} ${Math.min(line.originY, line.y) - 60} ${line.x} ${line.y}`}
          />
          <circle className="wf-term-link-overlay__dot" cx={line.x} cy={line.y} r={5} />
        </svg>
      ) : null}
    </div>
  );
}
