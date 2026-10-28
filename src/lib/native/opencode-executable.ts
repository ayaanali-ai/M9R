import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** Resolve OpenCode's real executable without invoking npm shell shims. */
export function opencodeExecutablePath(env: Record<string, string | undefined> = process.env): string | null {
  if (process.platform !== "win32") return env.M9R_OPENCODE_EXE?.trim() || "opencode";

  const envValue = (name: string): string | undefined => {
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key ? env[key] : undefined;
  };
  const explicit = envValue("M9R_OPENCODE_EXE")?.trim();
  // An explicit executable is an isolation boundary, not a hint. Falling
  // through to APPDATA or the user's PATH after it is supplied can launch a
  // different provider installation (and, in tests, the developer's real
  // OpenCode service) under the wrong workspace profile.
  if (explicit) return existsSync(explicit) ? explicit : null;
  const pathValue = envValue("PATH") ?? "";
  const pathCandidates = pathValue.split(delimiter).flatMap((entry) => {
    const directory = entry.trim().replace(/^(?:(["'])(.*)\1)$/, "$2");
    if (!directory) return [];
    return [
      join(directory, "opencode.exe"),
      join(directory, "node_modules", "@opencode", "cli", "bin", "opencode.exe"),
      join(directory, "node_modules", "opencode-ai", "bin", "opencode.exe"),
    ];
  });
  const appData = envValue("APPDATA")?.trim();
  const candidates = [
    ...pathCandidates,
    appData ? join(appData, "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe") : undefined,
    appData ? join(appData, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe") : undefined,
    join(homedir(), ".npm-global", "lib", "node_modules", "@opencode", "cli", "bin", "opencode.exe"),
    join(homedir(), ".npm-global", "lib", "node_modules", "opencode-ai", "bin", "opencode.exe"),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? null;
}

export function requireOpenCodeExecutable(env: Record<string, string | undefined> = process.env): string {
  const executable = opencodeExecutablePath(env);
  if (!executable) throw new Error("OpenCode's real executable was not found; set M9R_OPENCODE_EXE to opencode.exe.");
  return executable;
}
