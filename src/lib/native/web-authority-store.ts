import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultStoreRoot } from "./local-store";
import { verifyAudit, type AuditEntry, type Grant, type GrantRequest, type WebAuthoritySnapshot } from "./web-authority-core";

const FILE_NAME = "web-authority.json";

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
  return isRecord(value) && typeof value.seq === "number" && typeof value.at === "number" && typeof value.kind === "string" &&
    typeof value.actor === "string" && typeof value.prev === "string" && typeof value.hash === "string" &&
    ["grant.requested", "grant.approved", "grant.denied", "grant.revoked", "action.allowed", "action.refused", "action.requested", "action.approved", "action.denied", "action.timed_out"].includes(value.kind) &&
    ["grantId", "action", "origin", "selector", "detail"].every((key) => value[key] === undefined || typeof value[key] === "string");
}

function parseSnapshot(value: unknown): WebAuthoritySnapshot | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.grants) || !value.grants.every(isGrant) ||
      !Array.isArray(value.requests) || !value.requests.every(isRequest) || !Array.isArray(value.audit) || !value.audit.every(isAuditEntry)) return null;
  const snapshot: WebAuthoritySnapshot = { version: 1, grants: value.grants, requests: value.requests, audit: value.audit };
  return verifyAudit(snapshot.audit).ok ? snapshot : null;
}

export function createWebAuthorityStore(root = defaultStoreRoot(homedir())) {
  const filePath = join(root, FILE_NAME);

  function quarantine(): void {
    const stem = `${filePath}.corrupt-${Date.now()}`;
    let destination = stem;
    let suffix = 1;
    while (existsSync(destination)) destination = `${stem}-${suffix++}`;
    renameSync(filePath, destination);
  }

  return {
    load(): WebAuthoritySnapshot {
      if (!existsSync(filePath)) return { version: 1, grants: [], requests: [], audit: [] };
      try {
        const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
        const snapshot = parseSnapshot(parsed);
        if (snapshot) return snapshot;
      } catch {
        // Quarantine malformed or unreadable state below; a fresh authority starts with no grants.
      }
      quarantine();
      return { version: 1, grants: [], requests: [], audit: [] };
    },

    save(snapshot: WebAuthoritySnapshot): void {
      const validated = parseSnapshot(snapshot);
      if (!validated) throw new Error("refusing to persist an invalid web authority snapshot");
      mkdirSync(root, { recursive: true });
      const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      try {
        writeFileSync(temporaryPath, JSON.stringify(validated), { encoding: "utf8", mode: 0o600 });
        renameSync(temporaryPath, filePath);
      } catch (error) {
        try {
          rmSync(temporaryPath, { force: true });
        } catch {
          // Preserve the original write error; a leftover uniquely named temp file is recoverable.
        }
        throw error;
      }
    },
  };
}
