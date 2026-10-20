import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { defaultStoreRoot } from "./local-store";

const isEngineName = (value: string): boolean => /^m9r-engine(?:\.exe)?(?:\.m9r-retired-[a-f0-9-]+)?$/i.test(value);

/**
 * Resolve the current installed engine for a packaged MCP supervisor.
 *
 * A supervisor can outlive an update. In that case process.execPath can point
 * at an executable that the installer retained as rollback material while the
 * stable bin path already contains the new build. Spawning process.execPath
 * again would therefore keep reviving the old runtime. Only an M9R-engine
 * process is allowed to use this installed-path override; source/Node MCP
 * entries continue to use their normal entrypoint.
 */
export function resolveMcpRuntimeExecutable(
  env: Record<string, string | undefined>,
  execPath: string,
  platform = process.platform,
): string {
  if (!isEngineName(basename(execPath))) return execPath;
  const root = defaultStoreRoot(homedir(), env);
  const installed = join(root, "bin", platform === "win32" ? "m9r-engine.exe" : "m9r-engine");
  return existsSync(installed) ? installed : execPath;
}

export function isPackagedMcpExecutable(path: string): boolean {
  return isEngineName(basename(path));
}
