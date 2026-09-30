/**
 * Fine-grained turn-taking for agents sharing one tab (M9R_DEMO_BUILD_PLAN_2026-09-23.md's Phase 2 claim system
 * decides *what* an agent may touch; this decides *when* it gets to act). Google Docs never has true simultaneous
 * writes either -- every keystroke is still serialized one at a time -- it reads as multiplayer because the unit
 * being serialized is one keystroke, not one paragraph, so the interleaving is too fine to notice. Letting an agent
 * run a whole subtask uninterrupted before another agent's cursor reappears is what made past demos read as a
 * relay race instead of a team: coarse turns make serialization visible. This scheduler grants each agent a short
 * burst (default: one action) before it must yield to the next agent that has pending work, round robin, so at
 * almost any moment more than one agent's cursor is moving on screen.
 *
 * One agent's process cost is not like the others': Codex spawns a new OS process per message (see
 * web-live-sessions.ts), so forcing it through 1-action bursts would spin up a fresh process every couple of
 * seconds. Give a process-per-message agent a larger burstSize at registration; Claude and OpenCode (persistent
 * sessions) can stay at the fine default.
 */

export interface TurnSchedulerDeps {
  now?: () => number;
}

interface AgentState {
  id: string;
  burstSize: number;
  pending: boolean;
  actionsTakenThisTurn: number;
  turnStartedAt: number;
}

export interface TurnRequestResult {
  granted: boolean;
  /** Present only when granted is false: who currently holds the turn, or null if nobody has pending work. */
  holder?: string | null;
  reason: string;
}

export interface TurnSchedulerLane {
  register(id: string, opts?: { burstSize?: number }): void;
  unregister(id: string): void;
  setPending(id: string, pending: boolean): void;
  requestTurn(id: string): TurnRequestResult;
  recordAction(id: string): { ok: boolean; yielded: boolean };
  yieldTurn(id: string): void;
  releaseIfStale(maxHoldMs: number): boolean;
  currentHolder(): string | null;
  snapshot(): Array<{ id: string; pending: boolean; isHolder: boolean; burstSize: number; actionsTakenThisTurn: number }>;
}

export interface TurnScheduler extends TurnSchedulerLane {
  /** Independent round-robin lane owned by this scheduler (for example, one contended claim scope in a tab). */
  forLane(key: string): TurnSchedulerLane;
}

const MAX_BURST = 50;

export function createTurnScheduler(deps: TurnSchedulerDeps = {}): TurnScheduler {
  const now = deps.now ?? Date.now;
  const agents = new Map<string, AgentState>();
  const order: string[] = [];
  let holder: string | null = null;
  let cursor = 0;

  function register(id: string, opts: { burstSize?: number } = {}): void {
    if (agents.has(id)) return;
    const burstSize = Math.max(1, Math.min(MAX_BURST, Math.floor(opts.burstSize ?? 1)));
    agents.set(id, { id, burstSize, pending: false, actionsTakenThisTurn: 0, turnStartedAt: 0 });
    order.push(id);
  }

  function unregister(id: string): void {
    if (!agents.has(id)) return;
    agents.delete(id);
    const i = order.indexOf(id);
    if (i >= 0) order.splice(i, 1);
    if (holder === id) holder = null;
    if (order.length > 0) cursor %= order.length;
    else cursor = 0;
  }

  /** The broker calls this whenever an agent does or no longer has work to offer; skipped agents are never granted a turn. */
  function setPending(id: string, pending: boolean): void {
    const agent = agents.get(id);
    if (agent) agent.pending = pending;
  }

  // Finds the next pending agent starting at `cursor`, and advances `cursor` past it -- independent of who is
  // currently holding, so rotation stays fair (round robin) instead of always restarting from the front.
  function advance(): string | null {
    if (order.length === 0) return null;
    for (let i = 0; i < order.length; i += 1) {
      const idx = (cursor + i) % order.length;
      const candidate = agents.get(order[idx]);
      if (candidate && candidate.pending) {
        cursor = (idx + 1) % order.length;
        return candidate.id;
      }
    }
    return null;
  }

  function ensureHolder(): void {
    if (holder) {
      const agent = agents.get(holder);
      if (agent && agent.pending) return;
      holder = null;
    }
    const next = advance();
    if (!next) return;
    holder = next;
    const agent = agents.get(next)!;
    agent.actionsTakenThisTurn = 0;
    agent.turnStartedAt = now();
  }

  function requestTurn(id: string): TurnRequestResult {
    const agent = agents.get(id);
    if (!agent) return { granted: false, reason: `unknown agent ${id}` };
    if (!agent.pending) return { granted: false, reason: `${id} has no pending work` };
    ensureHolder();
    if (holder !== id) return { granted: false, holder, reason: holder ? `waiting on @${holder}` : "no agent is ready" };
    return { granted: true, reason: "" };
  }

  /** Call once per action the holder actually takes. Returns whether the burst is now exhausted and the turn moved on. */
  function recordAction(id: string): { ok: boolean; yielded: boolean } {
    const agent = agents.get(id);
    if (!agent || holder !== id) return { ok: false, yielded: false };
    agent.actionsTakenThisTurn += 1;
    if (agent.actionsTakenThisTurn < agent.burstSize) return { ok: true, yielded: false };
    holder = null;
    ensureHolder();
    return { ok: true, yielded: true };
  }

  /** An agent that finishes its whole subtask early releases the turn without waiting out its burst. */
  function yieldTurn(id: string): void {
    if (holder !== id) return;
    const agent = agents.get(id);
    if (agent) agent.actionsTakenThisTurn = 0;
    holder = null;
    ensureHolder();
  }

  /** A crashed or hung holder must not stall every other agent forever; the broker decides what "stale" means. */
  function releaseIfStale(maxHoldMs: number): boolean {
    if (!holder) return false;
    const agent = agents.get(holder);
    if (!agent || now() - agent.turnStartedAt < maxHoldMs) return false;
    setPending(holder, false);
    holder = null;
    ensureHolder();
    return true;
  }

  function currentHolder(): string | null {
    ensureHolder();
    return holder;
  }

  function snapshot(): Array<{ id: string; pending: boolean; isHolder: boolean; burstSize: number; actionsTakenThisTurn: number }> {
    ensureHolder();
    return order.map((id) => {
      const agent = agents.get(id)!;
      return { id, pending: agent.pending, isHolder: id === holder, burstSize: agent.burstSize, actionsTakenThisTurn: agent.actionsTakenThisTurn };
    });
  }

  const lanes = new Map<string, TurnSchedulerLane>();
  return {
    register,
    unregister,
    setPending,
    requestTurn,
    recordAction,
    yieldTurn,
    releaseIfStale,
    currentHolder,
    snapshot,
    forLane(key: string): TurnSchedulerLane {
      let lane = lanes.get(key);
      if (!lane) {
        lane = createTurnScheduler({ now });
        lanes.set(key, lane);
      }
      return lane;
    },
  };
}
