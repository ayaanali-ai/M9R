/**
 * Which Codex sessions are open right now. Codex has no session-end hook and its hook payload has no process id, but a
 * live session keeps its rollout file open (checked 2026-09-20 on Windows with a real interactive session: locked while
 * live, free after exit or kill). Windows Restart Manager reports which processes hold a file WITHOUT opening it
 * exclusively, so asking can never disturb Codex writing to it.
 *
 * Windows only for now. Other platforms report `unknown`, which callers treat as "no information", never as "closed"
 * (a Mac/Linux equivalent, likely `lsof`, is untested and deliberately not claimed).
 */
import { spawn } from "node:child_process";

export type Liveness = "live" | "free" | "unknown";
export interface FileHolderObservation {
  state: Liveness;
  /** Present only when Restart Manager reports exactly one valid owner process. */
  processId?: number;
}

const CSHARP = String.raw`
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class M9rRm {
  [StructLayout(LayoutKind.Sequential)] struct FT { public uint lo; public uint hi; }
  [StructLayout(LayoutKind.Sequential)] struct UP { public int pid; public FT start; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct PI {
    public UP p;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string app;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string svc;
    public int type; public uint status; public uint session;
    [MarshalAs(UnmanagedType.Bool)] public bool restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint h, int f, StringBuilder key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint nf, string[] files, uint na, UP[] apps, uint ns, string[] svcs);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint needed, ref uint count, [In, Out] PI[] info, out uint reasons);
  public static string Holders(string path) {
    uint h;
    var key = new StringBuilder(33);
    if (RmStartSession(out h, 0, key) != 0) return "ERR";
    try {
      if (RmRegisterResources(h, 1, new[] { path }, 0, null, 0, null) != 0) return "ERR";
      uint needed = 0, count = 0, reasons;
      int r = RmGetList(h, out needed, ref count, null, out reasons);
      if (r == 0) return "";
      if (r != 234) return "ERR";
      var info = new PI[needed]; count = needed;
      r = RmGetList(h, out needed, ref count, info, out reasons);
      if (r != 0) return "ERR";
      var s = new System.Text.StringBuilder();
      for (int i = 0; i < count; i++) s.Append(info[i].p.pid).Append(':').Append(info[i].app).Append(';');
      return s.ToString();
    } finally { RmEndSession(h); }
  }
}
`;

/** The PowerShell program: compile the helper, then print `path<TAB>holders` for each path in M9R_RM_FILES (joined by `|`). */
const POWERSHELL = [
  "$ErrorActionPreference = 'Stop'",
  `Add-Type -TypeDefinition @'${CSHARP}'@`,
  "foreach ($f in $env:M9R_RM_FILES.Split([char]'|')) { if ($f) { $f + [char]9 + [M9rRm]::Holders($f) } }",
].join("\n");

/** Turns the program's output into a verdict per file; anything unclear is `unknown`, never `free`. */
export function parseHolderObservations(output: string, files: readonly string[]): Record<string, FileHolderObservation> {
  const observations: Record<string, FileHolderObservation> = Object.fromEntries(files.map((file) => [file, { state: "unknown" as Liveness }]));
  for (const line of output.split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const file = line.slice(0, tab);
    const holders = line.slice(tab + 1).trim();
    if (!(file in observations) || holders === "ERR") continue;
    if (!holders) {
      observations[file] = { state: "free" };
      continue;
    }

    const entries = holders.split(";").filter(Boolean);
    const pids = entries.map((entry) => {
      const match = /^\s*(\d+):/.exec(entry);
      const pid = match ? Number(match[1]) : Number.NaN;
      return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
    });
    const uniquePids = new Set(pids.filter((pid): pid is number => pid !== undefined));
    observations[file] = {
      state: "live",
      ...(entries.length > 0 && pids.every((pid): pid is number => pid !== undefined) && uniquePids.size === 1
        ? { processId: [...uniquePids][0]! }
        : {}),
    };
  }
  return observations;
}

export function parseHolders(output: string, files: readonly string[]): Record<string, Liveness> {
  return Object.fromEntries(Object.entries(parseHolderObservations(output, files)).map(([file, observation]) => [file, observation.state]));
}

/** One Restart Manager query for all files, preserving a PID only when it uniquely owns that session file. */
export function windowsFileHolderObservations(files: readonly string[], timeoutMs = 15_000): Promise<Record<string, FileHolderObservation>> {
  const unknown = Object.fromEntries(files.map((file) => [file, { state: "unknown" as Liveness }]));
  if (process.platform !== "win32" || files.length === 0) return Promise.resolve(unknown);
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (value: Record<string, FileHolderObservation>) => { if (!settled) { settled = true; resolve(value); } };
    try {
      const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, env: { ...process.env, M9R_RM_FILES: files.join("|") } });
      const timer = setTimeout(() => { child.kill(); done(unknown); }, timeoutMs);
      child.stdout?.on("data", (c) => { out += String(c); });
      child.on("error", () => { clearTimeout(timer); done(unknown); });
      child.on("close", () => { clearTimeout(timer); done(parseHolderObservations(out, files)); });
    } catch { done(unknown); }
  });
}

/** State-only compatibility surface for callers that do not need session ownership. */
export async function windowsFileHolders(files: readonly string[], timeoutMs = 15_000): Promise<Record<string, Liveness>> {
  const observations = await windowsFileHolderObservations(files, timeoutMs);
  return Object.fromEntries(Object.entries(observations).map(([file, observation]) => [file, observation.state]));
}
