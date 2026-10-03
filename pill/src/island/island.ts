// The island: DOM shell, sizing animation, mark placement, mouse handling, window collapse.

import { Tracked, Spring, clamp } from "../core/anim";
import {
  EXPANDED_CORNER, NOTCH_W, PANEL_W, ROUNDED_CORNER, VIEW_LAYOUTS,
  botGlowColor, botGlowOpacity, botPosition, islandSize,
  type IslandMode, type IslandViewName,
} from "../core/layout";
import { Sound } from "../core/sound";
import { browserSpeechEnv } from "../core/speech";
import { State, type PillSnapshot } from "../core/state";
import type { Decision, PillTransport } from "../core/transport";
import { buildHeader, buildViews, type ViewActions, type ViewHost } from "../views/views";
import { providerLogo } from "../views/provider";
import { h } from "../views/dom";
import { IslandStateMachine } from "./fsm";

/** Margin around the island that still counts as "over it" (the host uses the same value for click-through). */
const HIT_MARGIN = 14;

const modeOrder = (m: IslandMode) => (m === "hidden" ? 0 : m === "compact" ? 1 : 2);

export class Island {
  readonly fsm = new IslandStateMachine();

  private root: HTMLElement;
  private transport: PillTransport;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private markEl!: HTMLElement;
  private markGlow!: HTMLElement;
  private miniGrid!: HTMLElement;
  private countdown!: HTMLElement;
  private wakeStrip!: HTMLElement;

  private header!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;

  private width = new Tracked(NOTCH_W);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  private markCx = new Spring(46);
  private markCy = new Spring(16);
  private markSize = new Spring(10);

  private running = false;
  private lastFrame = 0;
  private dirty = true;

  private collapsed = false;
  private suppressed = false;
  private collapseTimer: number | null = null;
  private wasInIsland = false;
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };
  private homeCollapseAt: number | null = null;
  private lastSyncedView: IslandViewName | null = null;
  private markKey = "";

  constructor(root: HTMLElement, transport: PillTransport) {
    this.root = root;
    this.transport = transport;
    this.build();
    this.wireFsm();
    this.wireInput();
    State.subscribe(() => {
      this.dirty = true;
      this.ensureRunning();
    });
  }

  // ── DOM ──────────────────────────────────────────────────────────

  private build() {
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      collapse: () => this.collapse(),
      setFocus: (id) => {
        State.setFocus(id);
        Sound.play("blip");
      },
      decide: (d) => this.decide(d),
      send: (text) => this.transport.send(text),
      canAllowForADay: () => this.transport.capabilities?.allowForADay === true,
      dictation: this.transport.capabilities?.dictation ? () => browserSpeechEnv(() => this.transport.openMicSetup?.()) : undefined,
      linking: this.transport.capabilities?.linkSessions && this.transport.listSessions && this.transport.linkSession
        ? { list: (handle) => this.transport.listSessions!(handle), link: (offer, session) => this.transport.linkSession!(offer, session) }
        : undefined,
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        this.transport.saveSettings?.(State.settings);
        State.notify();
      },
      setAutoClose: (s) => {
        State.settings.autoCloseInterval = s;
        this.fsm.homeToPetitDelay = s;
        this.transport.saveSettings?.(State.settings);
        State.notify();
      },
      blip: () => Sound.play("blip"),
    };

    this.wakeStrip = h("div", { id: "wake-strip" });
    this.markGlow = h("div", { id: "bot-glow" });
    this.markEl = h("div", { id: "mark" });
    this.miniGrid = h("div", { id: "mini-grid" });
    this.countdown = h("div", { id: "countdown" });

    this.header = buildHeader(actions);
    this.views = buildViews(actions, () => this.animateGeometry(false));
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);

    this.clipEl = h("div", { id: "island-clip" }, this.contentEl);
    this.islandEl = h("div", { id: "island" }, this.clipEl, this.markGlow, this.markEl, this.miniGrid, this.countdown);

    this.root.append(this.wakeStrip, this.islandEl);
    this.applyGeometry();
  }

  private decide(d: "allow" | "deny" | "allow_day") {
    const req = State.pendingApproval;
    if (!req) return;
    Sound.play(d === "deny" ? "blip" : "approve");
    const decision: Decision = d;
    void this.transport.decide(req.id, decision);
    // Optimistic: the next snapshot confirms. Keep the owner's place if more approvals wait.
    State.approvals = State.approvals.filter((a) => a.id !== req.id);
    if (State.approvals.length === 0) {
      State.isPinned = false;
      this.fsm.pinned = false;
      this.setView(State.defaultView());
    } else {
      State.notify();
    }
  }

  /** Feed from the host. Opens on a new approval (pinned until answered) and shows a quiet reveal for replies. */
  applySnapshot(snapshot: PillSnapshot) {
    const suppressed = snapshot.desktopPill === true;
    if (suppressed !== this.suppressed) {
      this.suppressed = suppressed;
      this.transport.setSuppressed?.(suppressed);
    }
    const { newApprovals, newReplies } = State.apply(snapshot);
    for (const m of newReplies) State.chatHistory.push({ id: Date.now() + State.chatHistory.length, role: "assistant", content: `${m.from}: ${m.text}`, link: m.link });
    if (newApprovals.length > 0) {
      const asking = State.approvals.find((a) => a.id === newApprovals[0]);
      if (asking) State.setFocus(asking.agent);
      State.isPinned = true;
      this.alert("approval");
    } else if (State.approvals.length === 0 && State.view === "approval") {
      State.isPinned = false;
      this.dropPin();
      this.setView(State.defaultView());
    } else if (newReplies.length > 0 && this.fsm.state === "hidden") {
      this.reveal();
    } else if (State.mode === "hidden" && State.tasks.some((t) => t.state === "working")) {
      this.reveal();
    }
    this.dirty = true;
    this.ensureRunning();
  }

  // ── State machine ────────────────────────────────────────────────

  private wireFsm() {
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.onTransition = (from, to) => {
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          if (from === "hidden") Sound.play("peek");
          this.setMode("compact");
          if (from === "intro") State.view = State.defaultView();
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "home":
          this.expand(State.defaultView());
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "intro":
          this.expand(State.defaultView());
          this.fsm.introComplete();
          break;
      }
      State.notify();
    };
  }

  launch() {
    this.fsm.launch();
  }

  // ── Mode / view ──────────────────────────────────────────────────

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    State.mode = mode;
    if (mode === "expanded") Sound.play("open");
    if (prev === "expanded") {
      Sound.play("close");
      State.isPinned = false;
      this.transport.focusWindow?.(false);
    }
    this.updateWindowCollapsed();
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    State.notify();
  }

  expand(view: IslandViewName) {
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    this.homeCollapseAt = null;
    State.notify();
  }

  setView(view: IslandViewName) {
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      return;
    }
    const grew = VIEW_LAYOUTS[view].height >= VIEW_LAYOUTS[State.view].height;
    State.view = view;
    State.lastActivity = performance.now();
    this.animateGeometry(!grew);
    State.notify();
  }

  /** Opens the message view (the keyboard shortcut in a page frame). */
  openMessage() {
    this.setView("prompt");
  }

  /** Push-to-talk from the keyboard: holding opens the message view and listens; letting go ends it. */
  talk(active: boolean) {
    if (active) this.setView("prompt");
    this.views.get("prompt")?.talk?.(active);
  }

  collapse() {
    State.isPinned = false;
    this.fsm.pinned = false;
    // Drive the state machine rather than the mode, or it keeps believing the island is open and a click on the compact
    // island does nothing.
    this.fsm.forcePetit();
  }

  /** Open on this view. Pinned alerts never auto-close. */
  alert(view: IslandViewName) {
    this.fsm.pinned = State.isPinned;
    this.fsm.forceHome();
    this.expand(view);
  }

  reveal() {
    this.fsm.reveal();
  }

  dropPin() {
    this.fsm.pinned = false;
  }

  // ── Geometry ─────────────────────────────────────────────────────

  private targetSize(): { w: number; h: number; r: number } {
    const { w, h } = islandSize(State.mode, State.view, State.chatHistory.length);
    const r = State.mode === "expanded" ? EXPANDED_CORNER : ROUNDED_CORNER;
    return { w, h, r };
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    if (shrinking) {
      this.width.curveTowards(w);
      this.height.curveTowards(h);
      this.radius.curveTowards(r);
    } else {
      this.width.springTo(w);
      this.height.springTo(h);
      this.radius.springTo(r);
    }
    this.ensureRunning();
  }

  private applyGeometry() {
    const w = this.width.value;
    const hh = this.height.value;
    const r = this.radius.value;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    this.islandEl.style.borderRadius = `0 0 ${r}px ${r}px`;
    this.islandEl.style.transform = `translateX(-50%)`;
    this.miniGrid.style.left = `${w - 40 - 14.5}px`;
    this.miniGrid.style.top = `${hh / 2 - 14.5}px`;

    const rect = { x: (PANEL_W - w) / 2, y: 0, w, h: hh };
    const p = this.pushedRect;
    if (Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5) {
      this.pushedRect = rect;
      this.transport.setIslandRect?.(rect.x, rect.y, rect.w, rect.h);
    }
  }

  private islandRect(): { x: number; y: number; w: number; h: number } {
    const w = this.width.value;
    const hh = this.height.value;
    return { x: (PANEL_W - w) / 2, y: 0, w, h: hh };
  }

  // ── Window collapse (hidden → tiny wake strip, zero polling) ─────

  private updateWindowCollapsed() {
    if (this.collapseTimer != null) {
      window.clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
    if (State.mode === "hidden") {
      // Let the island finish retracting, then drop the window to the wake strip: from there the OS delivers no cursor
      // events, so nothing polls at all.
      this.collapseTimer = window.setTimeout(() => {
        this.collapseTimer = null;
        if (State.mode !== "hidden") return;
        this.collapsed = true;
        this.transport.setCollapsed?.(true);
      }, 420);
    } else if (this.collapsed) {
      this.collapsed = false;
      this.transport.setCollapsed?.(false);
    }
  }

  // ── Input ────────────────────────────────────────────────────────

  private wireInput() {
    // The wake strip is the only thing the OS can hit while the island is hidden.
    this.wakeStrip.addEventListener("mouseenter", () => {
      Sound.resume();
      if (State.mode === "hidden") this.fsm.mouseEntered();
    });

    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      if (State.mode !== "expanded") {
        this.fsm.click();
        return;
      }
      // Clicking the empty part of the header folds the island away, even while an approval waits (it stays pending and
      // its badge stays on the agent). Buttons, tabs and fields keep their own clicks.
      const target = e.target as HTMLElement;
      if (target.closest("#header") && !target.closest("button")) this.collapse();
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && State.mode === "expanded" && !State.isPinned) this.collapse();
      State.lastActivity = performance.now();
    });

    // A shell that reports the global cursor calls onCursor itself; otherwise follow the page's own mouse events.
    this.followPageCursor();
  }

  /** Takes the cursor from the page's mouse events; leaving the window is reported as a cursor far away. */
  followPageCursor() {
    window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    window.addEventListener("mouseout", (e) => {
      if (e.relatedTarget == null) this.onCursor(-10_000, -10_000);
    });
  }

  /** Cursor in window-logical coordinates. */
  onCursor(x: number, y: number) {
    State.mouse = { x, y };
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };

    const inIsland =
      x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
      y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;

    if (inIsland && !this.wasInIsland) {
      this.fsm.mouseEntered();
      this.homeCollapseAt = null;
    }
    if (!inIsland && this.wasInIsland) {
      this.fsm.mouseLeft();
      if (this.fsm.state === "home" && !State.isPinned) {
        this.homeCollapseAt = performance.now() + State.settings.autoCloseInterval * 1000;
      }
    }
    this.wasInIsland = inIsland;
    this.ensureRunning();
  }

  // ── Frame loop ───────────────────────────────────────────────────

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    const dt = Math.min(0.05, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateMark();
    this.markCx.step(dt);
    this.markCy.step(dt);
    this.markSize.step(dt);
    this.placeMark();

    this.views.get(State.view)?.tick?.(nowMs);
    this.updateCountdown(nowMs);

    // Nothing is drawn while hidden, so nothing may keep the loop alive either; geometry still has to finish retracting.
    const settling = this.width.animating || this.height.animating || this.radius.animating;
    const busy = State.mode === "hidden"
      ? settling
      : settling || !this.markCx.settled || !this.markCy.settled || !this.markSize.settled || this.countdownActive;

    if (busy) {
      requestAnimationFrame(this.frame);
    } else {
      this.running = false;
      Sound.idle();
    }
  };

  private updateMark() {
    const p = botPosition(State.mode, State.view, this.height.value);
    this.markCx.target = p.cx;
    this.markCy.target = p.cy;
    this.markSize.target = p.diameter;
    this.markEl.style.opacity = p.opacity > 0 ? "1" : "0";

    if (State.mode === "expanded") {
      const d = p.diameter;
      const color = botGlowColor(State.effectiveState);
      this.markGlow.style.display = "block";
      this.markGlow.style.width = `${d * 2.2}px`;
      this.markGlow.style.height = `${d * 2.2}px`;
      this.markGlow.style.left = `${this.markCx.value - d * 1.1}px`;
      this.markGlow.style.top = `${this.markCy.value - d * 1.1}px`;
      this.markGlow.style.background = `radial-gradient(circle, ${color} 0%, transparent 62%)`;
      this.markGlow.style.opacity = String(botGlowOpacity(State.effectiveState));
    } else {
      this.markGlow.style.display = "none";
    }
  }

  private placeMark() {
    const d = this.markSize.value;
    this.markEl.style.width = `${d}px`;
    this.markEl.style.height = `${d}px`;
    this.markEl.style.left = `${this.markCx.value - d / 2}px`;
    this.markEl.style.top = `${this.markCy.value - d / 2}px`;
  }

  private get countdownActive(): boolean {
    return State.mode === "expanded" && !State.isPinned && this.homeCollapseAt != null;
  }

  private updateCountdown(nowMs: number) {
    if (!this.countdownActive) {
      this.countdown.style.width = "0px";
      return;
    }
    const autoClose = State.settings.autoCloseInterval;
    const windowS = Math.min(10, autoClose * 0.6);
    const remaining = ((this.homeCollapseAt as number) - nowMs) / 1000;
    this.countdown.style.width =
      remaining < windowS ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * 160)}px` : "0px";
  }

  // ── DOM sync ─────────────────────────────────────────────────────

  private syncDom() {
    const expanded = State.mode === "expanded";

    this.contentEl.style.opacity = expanded ? "1" : "0";
    this.contentEl.style.pointerEvents = expanded ? "auto" : "none";

    this.header.sync();
    for (const [name, view] of this.views) {
      const on = name === State.view;
      view.el.classList.toggle("on", on);
      if (on) view.sync();
    }

    // The message view is the only one with a text field, so it is the only time the island may take keyboard focus.
    if (this.lastSyncedView !== State.view) {
      const wasChat = this.lastSyncedView === "prompt";
      this.lastSyncedView = State.view;
      if (State.view === "prompt") {
        this.transport.focusWindow?.(true);
        window.setTimeout(() => this.views.get("prompt")?.focus?.(), 120);
      } else if (wasChat) {
        this.transport.focusWindow?.(false);
      }
    }

    // The focused agent's mark; rebuilt only when it changes.
    const focus = State.focusTask;
    const key = focus ? `${focus.provider}|${focus.state}` : "none";
    if (key !== this.markKey) {
      this.markKey = key;
      this.markEl.replaceChildren();
      if (focus) this.markEl.append(providerLogo(focus.provider, "fill"));
      this.markEl.dataset.state = focus?.state ?? "idle";
    }

    // Compact mini grid: the other agents.
    const showGrid = State.mode === "compact";
    this.miniGrid.style.opacity = showGrid ? "1" : "0";
    if (showGrid) {
      const others = State.otherTasks.slice(0, 4);
      const gridKey = others.map((t) => `${t.id}:${t.state}`).join("|");
      if (this.miniGrid.dataset.key !== gridKey) {
        this.miniGrid.dataset.key = gridKey;
        this.miniGrid.replaceChildren();
        for (const t of others) this.miniGrid.append(providerLogo(t.provider, 13, t.state));
      }
    }
  }

  /** Applies saved settings at boot. */
  applySettings() {
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    State.notify();
  }
}
