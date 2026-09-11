"use client";

// xterm ships its own stylesheet; without it the renderer measures character
// cells wrong and the terminal paints as overlapping text.
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { PersonMark } from "@/components/product/WorkspaceUI";
import {
  PTY_INPUT_MAX_CHUNK_BYTES,
  chunkPtyBytes,
  decodePtyBytes,
  type PtySessionStatus,
} from "@/lib/mission/mission-pty-protocol";
import type { RelayFrame } from "@/lib/mission/mission-relay-protocol";

/**
 * One live terminal pane.
 *
 * The PTY is a process on the host's machine; this renders its byte stream and
 * ships keystrokes back. Deliberately transport-agnostic -- it takes a send
 * function and a frame subscription rather than reaching for the relay client
 * itself, so a pane can be driven by a test or, later, tiled many-at-once
 * without each copy opening its own socket.
 */

export interface TerminalPaneProps {
  sessionId: string;
  /** Shown on the pane header; falls back to the session id. */
  title?: string;
  /** Returns false when the transport is down, so input can be shown as dropped. */
  sendFrame(type: "pty.input" | "pty.resize" | "pty.close" | "pty.share", payload: Record<string, unknown>): boolean;
  /** Registers a listener for inbound relay frames; returns an unsubscribe -- also how this pane receives pty.handoff cards (item #21 Phase 6). */
  subscribeFrames(listener: (frame: RelayFrame) => void): () => void;
  /** Read-only panes still render output, they just never send input. */
  canType?: boolean;
  /** Whether the current viewer owns this pane -- only the owner may toggle Sharing. */
  isOwner?: boolean;
  /** The owner-controlled Sharing state (default true). Ignored when isOwner, since the owner can always type their own pane. */
  shared?: boolean;
  /** Resolved display name of the pane's owner, e.g. "Ayaan's Claude Code". */
  ownerLabel?: string;
  /**
   * Item #28 Part B: pointerdown on this pane's own link handle. Only ever
   * rendered when isOwner -- the drag that follows is TerminalWorkspace's to
   * drive (it needs cross-pane coordinates this component can't see), so
   * this only reports the gesture starting, not the drag itself.
   */
  onLinkDragStart?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  className?: string;
}

/** Item #21 Phase 6: a rendered card, never PTY bytes -- see this file's handoff-card rendering below for the full render-don't-inject rationale. */
interface HandoffCard {
  handoffId: string;
  fromLabel: string;
  text: string;
  reason: string | null;
}

/** Named risk (a) in the Phase 6 spec: an agent that hands off on every step must not turn a pane into an unbounded notification feed. */
const MAX_OPEN_HANDOFF_CARDS = 5;

interface XtermTerminal {
  open(element: HTMLElement): void;
  write(data: Uint8Array | string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  dispose(): void;
  resize(cols: number, rows: number): void;
  readonly cols: number;
  readonly rows: number;
}

export function TerminalPane({ sessionId, title, sendFrame, subscribeFrames, canType = true, isOwner = false, shared = true, ownerLabel, onLinkDragStart, className }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const fitRef = useRef<{ fit(): void } | null>(null);
  const [status, setStatus] = useState<PtySessionStatus | "connecting">("connecting");
  const [detail, setDetail] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [handoffCards, setHandoffCards] = useState<HandoffCard[]>([]);
  /**
   * The owner-controlled Sharing toggle must take effect immediately without
   * tearing down and remounting xterm -- a remount would lose the visible
   * scrollback (no replay is re-triggered by an internal remount, only by a
   * fresh room subscription), which would make toggling Sharing look like it
   * wiped the terminal. Checked live inside the onData handler instead of
   * baked into the mount effect's dependencies.
   */
  const canTypeNowRef = useRef(canType && (isOwner || shared));
  useEffect(() => {
    canTypeNowRef.current = canType && (isOwner || shared);
    // A stale "sharing is off" warning shouldn't linger after the owner
    // turns it back on.
    if (canTypeNowRef.current) setDetail((current) => current?.startsWith("Sharing is off") ? null : current);
  }, [canType, isOwner, shared]);

  // Frames can arrive before xterm finishes loading, so output is buffered
  // rather than dropped -- otherwise the first lines of a session vanish.
  const pendingOutput = useRef<Uint8Array[]>([]);

  const writeToTerminal = useCallback((bytes: Uint8Array) => {
    const terminal = terminalRef.current;
    if (!terminal) {
      pendingOutput.current.push(bytes);
      return;
    }
    terminal.write(bytes);
  }, []);

  useEffect(() => {
    let disposed = false;
    let dataSubscription: { dispose(): void } | null = null;

    void (async () => {
      try {
        // xterm touches `window` at import time, so it can only load client-side.
        const [{ Terminal }, { FitAddon }, { WebglAddon }] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
          import("@xterm/addon-webgl"),
        ]);
        if (disposed || !hostRef.current) return;

        const styles = getComputedStyle(document.documentElement);
        const terminal = new Terminal({
          convertEol: false,
          cursorBlink: true,
          // Not tied to the live shared/isOwner state -- see canTypeNowRef.
          // This only reflects whether the pane is EVER allowed to type at
          // all (the canType prop, e.g. a genuinely read-only embed).
          disableStdin: !canType,
          // Deliberately not --ol-mono: IBM Plex Mono/Geist Mono lack full
          // coverage of the Unicode block-element glyphs (▀▄█▘▝ etc.) real
          // CLI output draws with, so the browser silently falls back to a
          // different font for just those characters -- one with different
          // cell metrics, which breaks grid alignment and shows up as gaps
          // in anything drawn from block characters. These are real system
          // terminal fonts with full box-drawing/block-element coverage.
          fontFamily: "Cascadia Code, Menlo, Consolas, 'DejaVu Sans Mono', ui-monospace, monospace",
          fontSize: 12,
          scrollback: 5_000,
          theme: {
            background: styles.getPropertyValue("--ol-surface-0").trim() || "#0b0b0c",
            foreground: styles.getPropertyValue("--ol-text-primary").trim() || "#e6e6e6",
          },
        }) as unknown as XtermTerminal;
        const fit = new FitAddon();
        (terminal as unknown as { loadAddon(addon: unknown): void }).loadAddon(fit);
        terminal.open(hostRef.current);
        fit.fit();

        // The DOM renderer draws every glyph -- including box-drawing/block
        // characters -- from the system font, which is exactly what leaves
        // visible seams in anything a CLI draws out of solid block glyphs
        // (confirmed against xterm.js #2572/#2409: the DOM renderer has no
        // pixel-perfect block-glyph path, only the canvas/WebGL renderers do).
        // WebGL context loss (backgrounded tab, GPU driver reset) is real and
        // not fatal to the pane -- catch it and keep the DOM renderer running
        // rather than losing the whole terminal over a lost context.
        try {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => webgl.dispose());
          (terminal as unknown as { loadAddon(addon: unknown): void }).loadAddon(webgl);
        } catch {
          // No WebGL available (old GPU, disabled in the browser) -- the DOM
          // renderer still works, just with the known block-glyph seam issue.
        }

        terminalRef.current = terminal;
        fitRef.current = fit;
        for (const buffered of pendingOutput.current) terminal.write(buffered);
        pendingOutput.current = [];

        if (canType) {
          dataSubscription = terminal.onData((data) => {
            if (!canTypeNowRef.current) {
              setDetail("Sharing is off — the owner turned off typing for everyone else.");
              return;
            }
            // A paste can exceed one frame's budget, so input chunks too.
            for (const chunk of chunkPtyBytes(new TextEncoder().encode(data), PTY_INPUT_MAX_CHUNK_BYTES)) {
              const delivered = sendFrame("pty.input", { sessionId, data: chunk });
              if (!delivered) setDetail("Not connected — keystrokes are not reaching the terminal.");
            }
          });
        }

        sendFrame("pty.resize", { sessionId, cols: terminal.cols, rows: terminal.rows });
      } catch (error) {
        if (!disposed) setLoadError(error instanceof Error ? error.message : "The terminal renderer failed to load.");
      }
    })();

    return () => {
      disposed = true;
      dataSubscription?.dispose();
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, canType, sendFrame]);

  useEffect(() => {
    return subscribeFrames((frame) => {
      const payload = frame.payload as Record<string, unknown> | null;
      if (!payload || payload.sessionId !== sessionId) return;

      if (frame.type === "pty.output" && typeof payload.data === "string") {
        writeToTerminal(decodePtyBytes(payload.data));
        return;
      }
      if (frame.type === "pty.state") {
        const next = payload.status === "exited" ? "exited" : "running";
        setStatus(next);
        setDetail(
          payload.reason === "host_disconnected"
            ? "The host's machine went offline, so this terminal ended."
            : typeof payload.reason === "string"
              ? payload.reason
              : null,
        );
        return;
      }
      // Item #21 Phase 6: render, don't inject. This is data for a card, it
      // never reaches xterm's buffer and never touches PTY input on its own.
      if (frame.type === "pty.handoff") {
        const handoffId = typeof payload.handoffId === "string" ? payload.handoffId : null;
        const text = typeof payload.text === "string" ? payload.text : "";
        if (!handoffId || !text) return;
        setHandoffCards((current) => {
          if (current.some((card) => card.handoffId === handoffId)) return current; // idempotency-key replay
          const next = [
            ...current,
            {
              handoffId,
              fromLabel: typeof payload.fromLabel === "string" ? payload.fromLabel : "Agent",
              text,
              reason: typeof payload.reason === "string" ? payload.reason : null,
            },
          ];
          // Drop the oldest rather than refusing new ones -- a recent handoff is more likely to still matter than one sitting unread.
          return next.length > MAX_OPEN_HANDOFF_CARDS ? next.slice(next.length - MAX_OPEN_HANDOFF_CARDS) : next;
        });
      }
    });
  }, [sessionId, subscribeFrames, writeToTerminal]);

  function dismissHandoffCard(handoffId: string): void {
    setHandoffCards((current) => current.filter((card) => card.handoffId !== handoffId));
  }

  /** The only place a handoff's text can ever reach the shell: the human's own client emits an ordinary pty.input frame, going through the exact same already-verified input path (and Sharing-gate check) a hand-typed keystroke does. No new privilege exists here. */
  function sendHandoffToTerminal(card: HandoffCard): void {
    if (!canTypeNowRef.current) {
      setDetail("Sharing is off — the owner turned off typing for everyone else.");
      return;
    }
    for (const chunk of chunkPtyBytes(new TextEncoder().encode(card.text), PTY_INPUT_MAX_CHUNK_BYTES)) {
      sendFrame("pty.input", { sessionId, data: chunk });
    }
    dismissHandoffCard(card.handoffId);
  }

  // A pane only shows what fits its own box, so the PTY has to be told the
  // size the viewer actually sees or output wraps at the wrong column.
  //
  // Debounced on purpose: calling fit() synchronously inside the observer's
  // own callback, every single time it fires, is how a brief multi-tick
  // layout settle (mount, font load, sibling panes appearing) turns into
  // several seconds of visible thrashing -- each fit() can itself change the
  // observed element's size, re-triggering the observer before the browser
  // ever paints a stable frame. Waiting for layout to go quiet for one frame
  // fixes that regardless of what's still bouncing around above this pane.
  useEffect(() => {
    const element = hostRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        const terminal = terminalRef.current;
        if (!terminal || !fitRef.current) return;
        fitRef.current.fit();
        sendFrame("pty.resize", { sessionId, cols: terminal.cols, rows: terminal.rows });
        // Keeps the prompt in view after a resize even if xterm's own
        // scroll position didn't move on its own -- the one thing that
        // actually matters to a viewer is never losing sight of the input.
        (terminal as unknown as { scrollToBottom(): void }).scrollToBottom();
      });
    });
    observer.observe(element);
    return () => { if (frame !== null) cancelAnimationFrame(frame); observer.disconnect(); };
  }, [sessionId, sendFrame]);

  /* Identity first, machine facts second: whose pane this is reads as a name
     in sans, the session/command it's running stays mono because that IS a
     machine fact. Previously the only label was a raw mono title, which gave
     a tiled grid of panes no way to be told apart at a glance. */
  const ownerName = isOwner ? "You" : ownerLabel ?? "Agent";

  return (
    <section className={`wf-term-pane ${className ?? ""}`.trim()} data-status={status}>
      <header className="wf-term-pane__bar">
        <PersonMark
          size={20}
          status={status === "running" ? "active" : status === "exited" ? undefined : "waiting"}
        />
        <span className="wf-term-pane__who">
          <span className="wf-term-pane__owner">{ownerName}</span>
          <span className="wf-term-pane__title">{title ?? sessionId}</span>
        </span>

        <span className="wf-term-pane__right">
          {isOwner && onLinkDragStart ? (
            <button
              type="button"
              className="wf-term-pane__link-handle"
              onPointerDown={onLinkDragStart}
              title="Drag onto another terminal to link the two into a shared Room."
              aria-label="Drag to link this terminal with another"
            >
              <span aria-hidden className="wf-term-pane__link-handle-dot" />
            </button>
          ) : null}
          {isOwner ? (
            <button
              type="button"
              className="wf-term-pane__share"
              onClick={() => sendFrame("pty.share", { sessionId, shared: !shared })}
              aria-pressed={shared}
              data-shared={shared}
              title={shared ? "Anyone in the room can type here. Click to make this private." : "Only you can type here. Click to share it."}
            >
              <span aria-hidden className="wf-term-pane__share-dot" />
              {shared ? "Sharing" : "Private"}
            </button>
          ) : !canType ? (
            <span className="wf-term-pane__flag">view only</span>
          ) : !shared ? (
            <span className="wf-term-pane__flag">view only — sharing is off</span>
          ) : null}
        </span>
      </header>

      {loadError ? (
        <p role="alert" className="wf-term-pane__error">{loadError}</p>
      ) : null}

      <div ref={hostRef} data-testid="terminal-surface" className="wf-term-pane__surface" />

      {detail ? (
        <p className="wf-term-pane__detail" data-tone={status === "exited" ? "muted" : "warn"}>{detail}</p>
      ) : null}

      {handoffCards.length > 0 ? (
        <div className="wf-term-handoff-list">
          {handoffCards.map((card) => (
            <div key={card.handoffId} className="wf-term-handoff-card">
              <div className="wf-term-handoff-card__head">
                <span className="wf-term-handoff-card__badge">Message from {card.fromLabel}</span>
                <button type="button" className="wf-term-handoff-card__dismiss" onClick={() => dismissHandoffCard(card.handoffId)} aria-label="Dismiss">
                  ×
                </button>
              </div>
              <p className="wf-term-handoff-card__text">{card.text}</p>
              {card.reason ? <p className="wf-term-handoff-card__reason">{card.reason}</p> : null}
              <button type="button" className="wf-term-handoff-card__send" onClick={() => sendHandoffToTerminal(card)}>
                Send to terminal
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
