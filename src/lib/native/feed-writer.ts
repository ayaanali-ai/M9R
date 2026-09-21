/**
 * Writes `~/.m9r/feed.json` for the overlay (design: M9R_OVERLAY_DESIGN.md section 5). `once` writes it a single time;
 * `watch` keeps it current: cheap re-reads when `state.json` changes, and the slower probes (which session is open, is a
 * turn running) on a timer, off the UI path. Writes are atomic (temp file, then rename) and happen only when the content
 * changed, so the overlay never sees a half file and is not woken for nothing.
 */
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildFeed, feedBody, lastTurnState, type Feed, type SessionProbe } from "./feed-core";
import { readRolloutTailFor, realDeps, type DeliveryDeps } from "./codex-delivery";
import { PENDING_TTL_MS } from "./approval-core";
import { createLocalStore } from "./local-store";
import type { CodexWatcher } from "./codex-watch";

export const FEED_FILE = "feed.json";

export interface FeedDeps {
  now?: () => Date;
  /** Injected for tests; production asks the machine which Codex sessions are open. */
  liveness?: DeliveryDeps["sessionLiveness"];
  readRolloutTail?: (threadId: string) => string | null;
}

export interface FeedRunOptions {
  root: string;
  watch?: boolean;
  /** Milliseconds between probe passes in watch mode. */
  probeEveryMs?: number;
  /** Milliseconds between checks of state.json in watch mode. */
  pollEveryMs?: number;
  deps?: FeedDeps;
  /** Hook-free Codex mentions: read new Codex prompts while watching (see codex-watch.ts). */
  codexWatcher?: CodexWatcher;
  onWrite?: (feed: Feed) => void;
  /** Stops watch mode when aborted. */
  signal?: AbortSignal;
}

function readPrevious(path: string): Feed | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Feed;
    return parsed && parsed.version === 1 && typeof parsed.seq === "number" ? parsed : null;
  } catch { return null; }
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  // Windows can refuse a rename onto a file another process is reading for a moment; retry briefly.
  for (let i = 0; ; i += 1) {
    try { renameSync(tmp, path); return; } catch (e) { if (i >= 5) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); }
  }
}

async function probe(store: ReturnType<typeof createLocalStore>, deps: FeedDeps): Promise<Record<string, SessionProbe>> {
  const codex = store.sessionsFor("codex");
  if (codex.length === 0) return {};
  const ids = codex.map((s) => s.sessionId);
  const liveness = deps.liveness ?? realDeps().sessionLiveness;
  const live = liveness ? await liveness(ids).catch(() => undefined) : undefined;
  const tail = deps.readRolloutTail ?? ((id: string) => readRolloutTailFor(id));
  const out: Record<string, SessionProbe> = {};
  for (const id of ids) {
    const l = live?.[id] ?? "unknown";
    const t = l === "live" ? tail(id) : null;
    out[id] = { live: l, turn: t ? lastTurnState(t) : "unknown" };
  }
  return out;
}

/** One build-and-maybe-write pass. Returns the feed written, or null when nothing changed. */
export async function feedPass(root: string, deps: FeedDeps, probes: Record<string, SessionProbe>): Promise<Feed | null> {
  const path = join(root, FEED_FILE);
  const store = createLocalStore(root);
  const now = (deps.now ?? (() => new Date()))();
  store.sweepExpired(PENDING_TTL_MS);
  const snap = store.snapshot();
  const previous = readPrevious(path);
  const feed = buildFeed({ now, endpoints: snap.endpoints, sessions: snap.sessions, tasks: snap.tasks, events: snap.events, probes, pendingIds: new Set(store.pendingApprovals().map((t) => t.id)) }, previous);
  if (previous && feedBody(previous) === feedBody(feed)) return null;
  mkdirSync(root, { recursive: true });
  writeAtomic(path, JSON.stringify(feed, null, 2) + "\n");
  return feed;
}

export async function runFeed(options: FeedRunOptions): Promise<Feed | null> {
  const deps = options.deps ?? {};
  let probes = await probe(createLocalStore(options.root), deps);
  let last = await feedPass(options.root, deps, probes);
  if (last) options.onWrite?.(last);
  if (!options.watch) return last;

  const statePath = join(options.root, "state.json");
  const mtime = () => { try { return statSync(statePath).mtimeMs; } catch { return 0; } };
  let seen = mtime();
  let busy = false;
  const tick = async (reprobe: boolean) => {
    if (busy) return;
    busy = true;
    try {
      if (reprobe) probes = await probe(createLocalStore(options.root), deps);
      const wrote = await feedPass(options.root, deps, probes);
      if (wrote) { last = wrote; options.onWrite?.(wrote); }
    } catch { /* a bad pass must never stop the feed; the next one retries */ } finally { busy = false; }
  };
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => { const m = mtime(); if (m !== seen) { seen = m; void tick(false); } }, options.pollEveryMs ?? 500);
    const slow = setInterval(() => void tick(true), options.probeEveryMs ?? 8000);
    const watcher = options.codexWatcher;
    const safely = (fn: () => void) => { try { fn(); } catch { /* the watcher must never stop the feed */ } };
    if (watcher) safely(() => watcher.refresh());
    const codexRead = watcher ? setInterval(() => safely(() => { watcher.tick(); }), 1500) : undefined;
    const codexFind = watcher ? setInterval(() => safely(() => watcher.refresh()), 10_000) : undefined;
    const stop = () => { clearInterval(poll); clearInterval(slow); if (codexRead) clearInterval(codexRead); if (codexFind) clearInterval(codexFind); resolve(); };
    if (options.signal?.aborted) stop(); else options.signal?.addEventListener("abort", stop, { once: true });
  });
  return last;
}

export const feedPath = (root: string) => join(root, FEED_FILE);
export const feedExists = (root: string) => existsSync(feedPath(root));

const lockPath = (root: string) => join(root, "feed.lock");
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };

/** Only one watcher may write the feed (the overlay starts one, and a person may too). Returns a release function, or null when another one is running. */
export function acquireFeedLock(root: string, pid = process.pid): (() => void) | null {
  mkdirSync(root, { recursive: true });
  const path = lockPath(root);
  try {
    const other = Number(readFileSync(path, "utf8").trim());
    if (Number.isInteger(other) && other > 0 && other !== pid && pidAlive(other)) return null;
  } catch { /* no lock, or unreadable: take it */ }
  writeFileSync(path, String(pid));
  return () => { try { if (Number(readFileSync(path, "utf8").trim()) === pid) rmSync(path, { force: true }); } catch { /* already gone */ } };
}
