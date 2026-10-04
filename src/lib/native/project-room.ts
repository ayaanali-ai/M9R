import { createHash } from "node:crypto";
import { resolve } from "node:path";

function normalizedProjectPath(folder: string): string {
  const path = resolve(folder).replace(/[\\/]+/g, "/");
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

/** Stable opaque local room key shared by all provider sessions working in this project. */
export function projectRoomId(folder: string): string {
  const digest = createHash("sha256").update(normalizedProjectPath(folder)).digest("hex").slice(0, 32);
  return `project-${digest}`;
}
