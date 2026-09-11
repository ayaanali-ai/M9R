import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  chunkFsContent,
  FS_READ_MAX_FILE_BYTES,
  type FsTreeNode,
  type FsTreeResultPayload,
  type FsContentChunkPayload,
  type FsErrorPayload,
} from "../mission/mission-fs-protocol";

/**
 * Item #9 Phase 1a: real disk access on the user's own machine, served over
 * the Mission Relay -- no Tauri needed (see M9R_MASTER_BUILD_PLAN.md's #9
 * section for why this is worth building before the desktop shell). This is
 * the resident-side counterpart to CodexThreadHost/MissionPtyRuntime: it
 * owns nothing long-lived (a file read is transactional, not a stream), so
 * unlike those two there is no session registry here -- each request is
 * answered and forgotten.
 *
 * Directory names skipped entirely from listings, never surfaced even as
 * empty folders -- matches what agents' own file tools already treat as
 * noise (`node_modules`, build output, VCS internals), not a new policy.
 */
const SKIPPED_DIRECTORY_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", ".oathlock", ".turbo", "coverage",
]);

export class FsTreeHost {
  constructor(private readonly repositoryRoot: string) {}

  /** Real containment check: the resolved path must land inside the resident's own repo root, never trusted from the relative path string alone (mission-fs-protocol.ts's isFsRelativePath already rejects `..`/absolute segments at the wire layer, but resolve+prefix-check is the actual enforcement). */
  private resolveWithin(relativePath: string | undefined): string | null {
    const target = resolve(this.repositoryRoot, relativePath ?? ".");
    const rootWithSep = this.repositoryRoot.endsWith(sep) ? this.repositoryRoot : this.repositoryRoot + sep;
    if (target !== this.repositoryRoot && !target.startsWith(rootWithSep)) return null;
    return target;
  }

  async listTree(relativePath: string | undefined): Promise<FsTreeResultPayload | { error: FsErrorPayload["reason"] }> {
    const target = this.resolveWithin(relativePath);
    if (!target) return { error: "outside_workspace" };
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = await readdir(target, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return { error: "not_found" };
    }
    const nodes: FsTreeNode[] = entries
      .filter((entry) => !(entry.isDirectory() && SKIPPED_DIRECTORY_NAMES.has(entry.name)))
      .map((entry): FsTreeNode => ({
        name: entry.name,
        path: relativePath ? `${relativePath}/${entry.name}` : entry.name,
        kind: entry.isDirectory() ? "directory" : "file",
      }))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));
    return { requestId: "", path: relativePath ?? "", entries: nodes };
  }

  async readFileChunks(relativePath: string): Promise<FsContentChunkPayload[] | { error: FsErrorPayload["reason"] }> {
    const target = this.resolveWithin(relativePath);
    if (!target) return { error: "outside_workspace" };
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(target);
    } catch {
      return { error: "not_found" };
    }
    if (!info.isFile()) return { error: "not_a_file" };
    if (info.size > FS_READ_MAX_FILE_BYTES) return { error: "too_large" };
    try {
      const bytes = await readFile(target);
      return chunkFsContent({ requestId: "", path: relativePath, bytes: new Uint8Array(bytes) });
    } catch {
      return { error: "read_failed" };
    }
  }
}

