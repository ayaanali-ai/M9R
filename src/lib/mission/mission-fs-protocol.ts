/**
 * Item #9 Phase 1a -- wire contract for resident-served real files, no Tauri
 * needed. Sibling to mission-pty-protocol.ts:
 * one owner (the resident, with real disk access on the user's own machine)
 * produces, a room consumes.
 *
 * Deliberately scoped down from the full spec in M9R_MASTER_BUILD_PLAN.md's
 * #9 section: this ships request/response tree listing and file reads
 * (fs.tree.request/fs.tree, fs.read.request/fs.content) using the exact
 * broadcast-and-self-filter pattern already reviewed and shipped for
 * in-memory session registry. Live file-watching (fs.subscribe/fs.changed, pushed
 * from a chokidar watcher in the resident) is the deliberately deferred
 * remainder of Phase 1a, not built in this pass.
 *
 * Payload size is the same constraint PTY output hit (relay caps a frame at
 * MISSION_RELAY_MAX_FRAME_BYTES=16384), so file content chunks the same way
 * `chunkPtyBytes` does -- reusing that exact function rather than a second
 * copy, since the spec's own #9 section calls out this as the third feature
 * needing it and asks for a shared helper instead of a third copy.
 */

import { chunkPtyBytes } from "./mission-pty-protocol";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

/** Same raw-bytes-per-chunk budget PTY output uses -- base64 inflation and the rest of the frame's JSON both fit under the relay's payload cap at this size. */
export const FS_CONTENT_MAX_CHUNK_BYTES = 4096;

/** A file this large is refused rather than silently truncated -- the IDE panel is for reading source, not arbitrary binaries or huge logs. */
export const FS_READ_MAX_FILE_BYTES = 2 * 1024 * 1024;

export function isFsRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

/** Relative to the resident's own repository root -- never an absolute path, so a client can't ask the resident to read outside its working directory. Real containment is enforced resident-side (path.resolve + startsWith check), this is just the wire shape. */
export function isFsRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1000) return false;
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return false;
  if (value.split(/[\\/]/).includes("..")) return false;
  return true;
}

export interface FsTreeRequestPayload {
  requestId: string;
  /** Target resident; other residents in the room ignore a request that isn't theirs. */
  connectionId: string;
  /** Defaults to the resident's repo root when omitted. */
  path?: string;
}

export interface FsTreeNode {
  name: string;
  path: string;
  kind: "file" | "directory";
}

export interface FsTreeResultPayload {
  requestId: string;
  path: string;
  entries: FsTreeNode[];
}

export interface FsReadRequestPayload {
  requestId: string;
  connectionId: string;
  path: string;
}

export interface FsContentChunkPayload {
  requestId: string;
  path: string;
  /** Monotonic per request, mirroring pty.output's seq -- lets a viewer detect a dropped chunk instead of silently rendering a truncated file. */
  seq: number;
  chunkIndex: number;
  chunkCount: number;
  data: string;
}

export interface FsErrorPayload {
  requestId: string;
  reason: "not_found" | "too_large" | "not_a_file" | "outside_workspace" | "read_failed";
  message: string;
}

export function parseFsTreeRequestPayload(payload: unknown): FsTreeRequestPayload | null {
  if (!isRecord(payload)) return null;
  if (!isFsRequestId(payload.requestId)) return null;
  if (typeof payload.connectionId !== "string" || payload.connectionId.length === 0) return null;
  const path = payload.path;
  if (path !== undefined && !isFsRelativePath(path)) return null;
  return { requestId: payload.requestId, connectionId: payload.connectionId, ...(path === undefined ? {} : { path }) };
}

export function parseFsReadRequestPayload(payload: unknown): FsReadRequestPayload | null {
  if (!isRecord(payload)) return null;
  if (!isFsRequestId(payload.requestId)) return null;
  if (typeof payload.connectionId !== "string" || payload.connectionId.length === 0) return null;
  if (!isFsRelativePath(payload.path)) return null;
  return { requestId: payload.requestId, connectionId: payload.connectionId, path: payload.path };
}

/** Split a file's raw bytes into transport-sized, ordered chunk frames -- same shape `chunkPtyBytes` already produces for terminal output, just wrapped with the extra fs.content addressing fields (requestId/path/chunkIndex/chunkCount). */
export function chunkFsContent(
  input: { requestId: string; path: string; bytes: Uint8Array },
  maxChunkBytes = FS_CONTENT_MAX_CHUNK_BYTES,
): FsContentChunkPayload[] {
  const chunks = chunkPtyBytes(input.bytes, maxChunkBytes);
  if (chunks.length === 0) {
    return [{ requestId: input.requestId, path: input.path, seq: 0, chunkIndex: 0, chunkCount: 1, data: "" }];
  }
  return chunks.map((data, index) => ({
    requestId: input.requestId,
    path: input.path,
    seq: index,
    chunkIndex: index,
    chunkCount: chunks.length,
    data,
  }));
}
