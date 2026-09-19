import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { TERMINAL_STATES, type DeliveryState } from "../delivery-state";

/**
 * The Bridge's local delivery ledger (M9R_NETWORK_SPEC.md 7.3 #7): an append-only file, written before the
 * Bridge tells the cloud it received or progressed a message. It is what lets `delivered_to_node` honestly
 * mean "persisted on the recipient's machine", and what a restart can read to know how far each message got.
 *
 * One file per provider Bridge process, so concurrent Bridges never interleave writes. Best effort by design:
 * a ledger failure must never stop a message, it only means the receipt is reported as not persisted.
 */

export interface LedgerEntry {
  messageId: string;
  provider: string;
  state: DeliveryState;
  at: number;
  /** Why the state was written when the state alone is ambiguous (for example a failure caused by a restart). */
  note?: string;
}

const RANK: Readonly<Record<DeliveryState, number>> = {
  accepted: 0, queued: 0, delivered_to_node: 1, delivered_to_session: 2, processing: 3,
  failed: 4, completed: 5, expired: 5, rejected: 5, cancelled: 5,
};

export const LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10_000;

function keyOf(messageId: string, provider: string): string {
  return `${provider}|${messageId}`;
}

function parseLine(line: string): LedgerEntry | null {
  try {
    const value = JSON.parse(line) as Partial<LedgerEntry>;
    if (typeof value.messageId !== "string" || typeof value.provider !== "string" || typeof value.state !== "string" || typeof value.at !== "number") return null;
    if (!(value.state in RANK)) return null;
    return { messageId: value.messageId, provider: value.provider, state: value.state as DeliveryState, at: value.at, ...(typeof value.note === "string" ? { note: value.note.slice(0, 64) } : {}) };
  } catch {
    return null;
  }
}

export class DeliveryLedger {
  private readonly path: string;
  private readonly now: () => number;
  private readonly latest = new Map<string, LedgerEntry>();
  private loaded = false;

  constructor(path: string, now: () => number = Date.now) {
    this.path = path;
    this.now = now;
  }

  /** Reads the file, drops entries past retention and beyond the cap (rewriting atomically if it did), and remembers each message's furthest state. */
  load(): void {
    this.loaded = true;
    this.latest.clear();
    if (!existsSync(this.path)) return;
    let entries: LedgerEntry[] = [];
    let text = "";
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      return;
    }
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    for (const line of lines) {
      const entry = parseLine(line);
      if (entry) entries.push(entry);
    }
    const cutoff = this.now() - LEDGER_RETENTION_MS;
    const kept = entries.filter((entry) => entry.at >= cutoff).slice(-MAX_ENTRIES);
    if (kept.length !== lines.length) this.rewrite(kept);
    entries = kept;
    for (const entry of entries) this.remember(entry);
  }

  /**
   * Records a state for a message. Returns true when the ledger now durably holds that message at that state
   * or further (so a repeat is a no-op that still reports true). A message that failed may start again from
   * delivered_to_node, which is the spec's retry.
   */
  record(messageId: string, provider: string, state: DeliveryState, at: number = this.now(), note?: string): boolean {
    if (!this.loaded) this.load();
    const key = keyOf(messageId, provider);
    const current = this.latest.get(key);
    if (current && current.state === state) return true;
    if (current && RANK[current.state] > RANK[state] && !(current.state === "failed" && state === "delivered_to_node")) return true;
    const entry: LedgerEntry = { messageId, provider, state, at, ...(note ? { note } : {}) };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      return false;
    }
    this.remember(entry);
    return true;
  }

  entryOf(messageId: string, provider: string): LedgerEntry | null {
    if (!this.loaded) this.load();
    return this.latest.get(keyOf(messageId, provider)) ?? null;
  }

  stateOf(messageId: string, provider: string): DeliveryState | null {
    if (!this.loaded) this.load();
    return this.latest.get(keyOf(messageId, provider))?.state ?? null;
  }

  /** Messages the Bridge took but never finished: what a restart has to reconcile instead of re-injecting. */
  unfinished(): LedgerEntry[] {
    if (!this.loaded) this.load();
    return [...this.latest.values()].filter((entry) => !TERMINAL_STATES.has(entry.state) && entry.state !== "failed" && RANK[entry.state] >= RANK.delivered_to_session);
  }

  private remember(entry: LedgerEntry): void {
    this.latest.set(keyOf(entry.messageId, entry.provider), entry);
  }

  private rewrite(entries: LedgerEntry[]): void {
    try {
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""), "utf8");
      renameSync(temp, this.path);
    } catch {
      // Keeping the old file is safe: it is only larger than intended.
    }
  }
}
