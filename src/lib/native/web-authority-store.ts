import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_AWARE_PROTOCOL_FRAMES, validateProtocolMessage } from "../../../packages/web-protocol-placeholder/src/index";
import { defaultStoreRoot } from "./local-store";
import { boundAuditWindow, MAX_AUTHORITY_GRANTS, MAX_PENDING_AUTHORITY_REQUESTS, verifyAudit, type AuditAnchor, type AuditEntry, type Grant, type GrantRequest, type WebAuthoritySnapshot } from "./web-authority-core";

const FILE_NAME = "web-authority.json";
const PROTOCOL_FILE_NAME = "web-aware-ledger.json";
/** Last-resort whole-snapshot bound, including grants, requests, and audit metadata. */
export const MAX_WEB_AUTHORITY_STATE_BYTES = 8 * 1024 * 1024;
const MAX_PROTOCOL_LEDGER_BYTES = 1_048_576;
const EMERGENCY_STOP_RESERVED_BYTES = 4_096;
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80] as const;

function waitSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, ms);
}

/** Retry only OS-level transient destination locks; invalid paths, permissions and disk errors still fail closed. */
export function renameWithRetry(
  source: string,
  destination: string,
  rename: (source: string, destination: string) => void = renameSync,
  wait: (ms: number) => void = waitSync,
): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      const retryable = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!retryable || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error;
      wait(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isActionArray(value: unknown): value is Grant["actions"] {
  return isStringArray(value) && value.every((action) => ["open", "read", "click", "type"].includes(action));
}

function isGrantee(value: unknown): boolean {
  return isRecord(value) && typeof value.owner === "string" && typeof value.agent === "string";
}

function isRequest(value: unknown): value is GrantRequest {
  return isRecord(value) && typeof value.id === "string" && isGrantee(value.grantee) && typeof value.origin === "string" &&
    (value.pathPrefix === undefined || (typeof value.pathPrefix === "string" && value.pathPrefix.startsWith("/"))) &&
    isActionArray(value.actions) && typeof value.ttlMs === "number" && typeof value.reason === "string" && typeof value.createdAt === "number";
}

function isGrant(value: unknown): value is Grant {
  return isRecord(value) && typeof value.id === "string" && typeof value.grantorOwner === "string" && isGrantee(value.grantee) &&
    typeof value.origin === "string" && (value.pathPrefix === undefined || (typeof value.pathPrefix === "string" && value.pathPrefix.startsWith("/"))) && isActionArray(value.actions) && typeof value.createdAt === "number" &&
    typeof value.expiresAt === "number" && typeof value.uses === "number" &&
    (value.maxUses === undefined || typeof value.maxUses === "number") && (value.revokedAt === undefined || typeof value.revokedAt === "number");
}

function isAuditEntry(value: unknown): value is AuditEntry {
  return isRecord(value) && Number.isSafeInteger(value.seq) && typeof value.at === "number" && Number.isFinite(value.at) && typeof value.kind === "string" &&
    typeof value.actor === "string" && typeof value.prev === "string" && typeof value.hash === "string" &&
    ["grant.requested", "grant.approved", "grant.denied", "grant.revoked", "action.allowed", "action.refused", "action.requested", "action.approved", "action.denied", "action.timed_out"].includes(value.kind) &&
    ["grantId", "action", "origin", "selector", "detail"].every((key) => value[key] === undefined || typeof value[key] === "string");
}

function isAuditAnchor(value: unknown): value is AuditAnchor {
  if (!isRecord(value) || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0 || typeof value.hash !== "string") return false;
  return value.sequence === 0 ? value.hash === "genesis" : /^[a-f0-9]{64}$/i.test(value.hash);
}

function isValidTerminalStopAll(frames: unknown[]): boolean {
  const terminal = frames.at(-1);
  if (!isRecord(terminal) || terminal.message_type !== "stop-all" || !isRecord(terminal.sender) || typeof terminal.sender.principal_id !== "string") return false;
  return validateProtocolMessage(terminal, { authenticatedPrincipalId: terminal.sender.principal_id }).ok;
}

function isEmergencyProtocolOverflow(frames: unknown[]): boolean {
  return frames.length === MAX_AWARE_PROTOCOL_FRAMES + 1 && isValidTerminalStopAll(frames);
}

function isWithinProtocolFrameLimit(frames: unknown[]): boolean {
  return frames.length <= MAX_AWARE_PROTOCOL_FRAMES || isEmergencyProtocolOverflow(frames);
}

function isWithinProtocolByteLimit(frames: unknown[], serialized = JSON.stringify(frames)): boolean {
  const limit = isValidTerminalStopAll(frames)
    ? MAX_PROTOCOL_LEDGER_BYTES + EMERGENCY_STOP_RESERVED_BYTES
    : MAX_PROTOCOL_LEDGER_BYTES;
  return Buffer.byteLength(serialized, "utf8") <= limit;
}

function parseSnapshot(value: unknown): WebAuthoritySnapshot | null {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || !Array.isArray(value.grants) || !value.grants.every(isGrant) ||
      value.grants.length > MAX_AUTHORITY_GRANTS || !Array.isArray(value.requests) || !value.requests.every(isRequest) ||
      value.requests.length > MAX_PENDING_AUTHORITY_REQUESTS || !Array.isArray(value.audit) || !value.audit.every(isAuditEntry)) return null;
  if (value.version === 1) {
    if (!verifyAudit(value.audit).ok) return null;
    const bounded = boundAuditWindow(value.audit, { sequence: 0, hash: "genesis" });
    return {
      version: 2,
      grants: value.grants,
      requests: value.requests,
      ...bounded,
    };
  }

  if (!isAuditAnchor(value.auditAnchor) || !verifyAudit(value.audit, value.auditAnchor).ok) return null;
  return {
    version: 2,
    grants: value.grants,
    requests: value.requests,
    ...boundAuditWindow(value.audit, value.auditAnchor),
  };
}

export function createWebAuthorityStore(root = defaultStoreRoot(homedir()), options: { maxStateBytes?: number } = {}) {
  const filePath = join(root, FILE_NAME);
  const protocolFilePath = join(root, PROTOCOL_FILE_NAME);
  const maxStateBytes = Math.min(MAX_WEB_AUTHORITY_STATE_BYTES, Math.max(1, Math.floor(options.maxStateBytes ?? MAX_WEB_AUTHORITY_STATE_BYTES)));

  function saveSnapshot(snapshot: WebAuthoritySnapshot): void {
    const validated = parseSnapshot(snapshot);
    if (!validated) throw new Error("refusing to persist an invalid web authority snapshot");
    const serialized = JSON.stringify(validated);
    const serializedBytes = Buffer.byteLength(serialized, "utf8");
    if (serializedBytes > maxStateBytes) throw new Error(`web authority state exceeds its safe capacity (${serializedBytes}/${maxStateBytes} bytes); the previous file was left unchanged`);
    mkdirSync(root, { recursive: true });
    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
      renameWithRetry(temporaryPath, filePath);
    } catch (error) {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // Preserve the original write error; a leftover uniquely named temp file is recoverable.
      }
      throw error;
    }
  }

  function quarantine(path: string): void {
    const stem = `${path}.corrupt-${Date.now()}`;
    let destination = stem;
    let suffix = 1;
    while (existsSync(destination)) destination = `${stem}-${suffix++}`;
    renameSync(path, destination);
  }

  return {
    load(): WebAuthoritySnapshot {
      if (!existsSync(filePath)) return { version: 2, grants: [], requests: [], audit: [], auditAnchor: { sequence: 0, hash: "genesis" } };
      const fileBytes = statSync(filePath).size;
      if (fileBytes > maxStateBytes) throw new Error(`web authority state exceeds its safe capacity (${fileBytes}/${maxStateBytes} bytes); file left untouched`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(filePath, "utf8"));
      } catch {
        // Quarantine malformed or unreadable state below; a fresh authority starts with no grants.
        quarantine(filePath);
        return { version: 2, grants: [], requests: [], audit: [], auditAnchor: { sequence: 0, hash: "genesis" } };
      }
      const snapshot = parseSnapshot(parsed);
      if (snapshot) {
        const parsedAnchor = isRecord(parsed) && isAuditAnchor(parsed.auditAnchor) ? parsed.auditAnchor : null;
        const parsedAuditCount = isRecord(parsed) && Array.isArray(parsed.audit) ? parsed.audit.length : -1;
        const needsRewrite = isRecord(parsed) && (parsed.version === 1 || snapshot.audit.length !== parsedAuditCount ||
          !parsedAnchor || snapshot.auditAnchor.sequence !== parsedAnchor.sequence || snapshot.auditAnchor.hash !== parsedAnchor.hash);
        if (needsRewrite) {
          try {
            saveSnapshot(snapshot);
          } catch {
            // Keep the valid legacy file recoverable; the in-memory migrated state is still safe to use.
          }
        }
        return snapshot;
      }
      quarantine(filePath);
      return { version: 2, grants: [], requests: [], audit: [], auditAnchor: { sequence: 0, hash: "genesis" } };
    },

    save(snapshot: WebAuthoritySnapshot): void {
      saveSnapshot(snapshot);
    },

    loadProtocolFrames(): unknown[] {
      if (!existsSync(protocolFilePath)) return [];
      let parsed: unknown;
      try {
        if (statSync(protocolFilePath).size > MAX_PROTOCOL_LEDGER_BYTES + EMERGENCY_STOP_RESERVED_BYTES) {
          quarantine(protocolFilePath);
          return [];
        }
        parsed = JSON.parse(readFileSync(protocolFilePath, "utf8"));
      }
      catch {
        quarantine(protocolFilePath);
        return [];
      }
      if (!Array.isArray(parsed) || !isWithinProtocolFrameLimit(parsed) || !isWithinProtocolByteLimit(parsed)) {
        quarantine(protocolFilePath);
        return [];
      }
      return parsed;
    },

    saveProtocolFrames(frames: readonly unknown[]): void {
      if (!Array.isArray(frames) || !isWithinProtocolFrameLimit(frames)) {
        throw new Error("refusing to persist an oversized AWARE journal; overflow requires one valid terminal stop-all frame");
      }
      const serialized = JSON.stringify(frames);
      if (!isWithinProtocolByteLimit(frames, serialized)) throw new Error("refusing to persist an AWARE journal over 1 MiB plus the bounded reserved terminal stop-all space");
      mkdirSync(root, { recursive: true });
      const temporaryPath = `${protocolFilePath}.tmp-${process.pid}-${Date.now()}`;
      try {
        writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
        renameWithRetry(temporaryPath, protocolFilePath);
      } catch (error) {
        try { rmSync(temporaryPath, { force: true }); } catch { /* preserve the original persistence error */ }
        throw error;
      }
    },
  };
}
