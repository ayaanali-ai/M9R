import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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
export const MAX_DELIVERY_LEDGER_ENTRIES = 10_000;
export const MAX_DELIVERY_LEDGER_BYTES = 16 * 1024 * 1024;
const MAX_MESSAGE_ID_CHARS = 256;
const MAX_PROVIDER_CHARS = 64;
const MAX_LEDGER_LINE_BYTES = 2_048;

export interface DeliveryLedgerLimits {
  /** Tests and embedded callers may lower, but never raise, production ceilings. */
  maxEntries?: number;
  maxBytes?: number;
}

function keyOf(messageId: string, provider: string): string {
  return `${provider}|${messageId}`;
}

function parseLine(line: string): LedgerEntry | null {
  try {
    const value = JSON.parse(line) as Partial<LedgerEntry>;
    if (typeof value.messageId !== "string" || value.messageId.length > MAX_MESSAGE_ID_CHARS || typeof value.provider !== "string" || value.provider.length > MAX_PROVIDER_CHARS || typeof value.state !== "string" || typeof value.at !== "number" || !Number.isFinite(value.at)) return null;
    if (!(value.state in RANK)) return null;
    return { messageId: value.messageId, provider: value.provider, state: value.state as DeliveryState, at: value.at, ...(typeof value.note === "string" ? { note: value.note.slice(0, 64) } : {}) };
  } catch {
    return null;
  }
}

export class DeliveryLedger {
  private readonly path: string;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly latest = new Map<string, LedgerEntry>();
  private loaded = false;
  private rawEntryCount = 0;

  constructor(path: string, now: () => number = Date.now, limits: DeliveryLedgerLimits = {}) {
    this.path = path;
    this.now = now;
    this.maxEntries = Math.min(MAX_DELIVERY_LEDGER_ENTRIES, Math.max(1, Math.floor(limits.maxEntries ?? MAX_DELIVERY_LEDGER_ENTRIES)));
    this.maxBytes = Math.min(MAX_DELIVERY_LEDGER_BYTES, Math.max(1, Math.floor(limits.maxBytes ?? MAX_DELIVERY_LEDGER_BYTES)));
  }

  /** Reads within fixed file/entry ceilings, drops expired entries, and remembers each message's furthest state. */
  load(): void {
    this.loaded = false;
    this.latest.clear();
    this.rawEntryCount = 0;
    if (!existsSync(this.path)) { this.loaded = true; return; }
    const fileBytes = statSync(this.path).size;
    if (fileBytes > this.maxBytes) throw new Error(`delivery ledger exceeds its safe capacity (${fileBytes}/${this.maxBytes} bytes); refusing to read or rewrite it`);
    let entries: LedgerEntry[] = [];
    let text = "";
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      this.loaded = true;
      return;
    }
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length > this.maxEntries) throw new Error(`delivery ledger exceeds its safe entry capacity (${lines.length}/${this.maxEntries}); refusing to truncate delivery history`);
    for (const line of lines) {
      const entry = parseLine(line);
      if (entry) entries.push(entry);
    }
    const cutoff = this.now() - LEDGER_RETENTION_MS;
    const kept = entries.filter((entry) => entry.at >= cutoff);
    const didRewrite = kept.length !== lines.length && this.rewrite(kept);
    entries = kept;
    for (const entry of entries) this.remember(entry);
    this.rawEntryCount = didRewrite ? kept.length : lines.length;
    this.loaded = true;
  }

  /**
   * Records a state for a message. Returns true when the ledger now durably holds that message at that state
   * or further (so a repeat is a no-op that still reports true). A message that failed may start again from
   * delivered_to_node, which is the spec's retry.
   */
  record(messageId: string, provider: string, state: DeliveryState, at: number = this.now(), note?: string): boolean {
    if (typeof messageId !== "string" || messageId.length === 0 || messageId.length > MAX_MESSAGE_ID_CHARS ||
        typeof provider !== "string" || provider.length === 0 || provider.length > MAX_PROVIDER_CHARS || !Number.isFinite(at)) return false;
    if (!this.loaded) {
      try { this.load(); } catch { return false; }
    }
    const key = keyOf(messageId, provider);
    const current = this.latest.get(key);
    if (current && current.state === state) return true;
    if (current && RANK[current.state] > RANK[state] && !(current.state === "failed" && state === "delivered_to_node")) return true;
    const entry: LedgerEntry = { messageId, provider, state, at, ...(note ? { note: note.slice(0, 64) } : {}) };
    const line = `${JSON.stringify(entry)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes > MAX_LEDGER_LINE_BYTES || this.rawEntryCount >= this.maxEntries) return false;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const currentBytes = existsSync(this.path) ? statSync(this.path).size : 0;
      if (currentBytes + lineBytes > this.maxBytes) return false;
      appendFileSync(this.path, line, "utf8");
    } catch {
      return false;
    }
    this.remember(entry);
    this.rawEntryCount += 1;
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

  private rewrite(entries: LedgerEntry[]): boolean {
    try {
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""), "utf8");
      renameSync(temp, this.path);
      return true;
    } catch {
      // Keeping the old file is safe: it is only larger than intended.
      return false;
    }
  }
}
