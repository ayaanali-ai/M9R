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

const CSHARP = String.raw`
using System;
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
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint h, int f, string key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint nf, string[] files, uint na, UP[] apps, uint ns, string[] svcs);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint needed, ref uint count, [In, Out] PI[] info, out uint reasons);
  public static string Holders(string path) {
    uint h;
    if (RmStartSession(out h, 0, Guid.NewGuid().ToString()) != 0) return "ERR";
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
  "foreach ($f in ($env:M9R_RM_FILES -split '\\|')) { if ($f) { $f + [char]9 + [M9rRm]::Holders($f) } }",
].join("\n");

/** Turns the program's output into a verdict per file; anything unclear is `unknown`, never `free`. */
export function parseHolders(output: string, files: readonly string[]): Record<string, Liveness> {
  const verdicts: Record<string, Liveness> = Object.fromEntries(files.map((f) => [f, "unknown" as Liveness]));
  for (const line of output.split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const file = line.slice(0, tab);
    const holders = line.slice(tab + 1).trim();
    if (!(file in verdicts) || holders === "ERR") continue;
    verdicts[file] = holders === "" ? "free" : "live";
  }
  return verdicts;
}

/** One PowerShell start for all files (about a second), used only when a push has to choose between sessions. */
export function windowsFileHolders(files: readonly string[], timeoutMs = 15_000): Promise<Record<string, Liveness>> {
  const unknown = Object.fromEntries(files.map((f) => [f, "unknown" as Liveness]));
  if (process.platform !== "win32" || files.length === 0) return Promise.resolve(unknown);
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (v: Record<string, Liveness>) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, env: { ...process.env, M9R_RM_FILES: files.join("|") } });
      const timer = setTimeout(() => { child.kill(); done(unknown); }, timeoutMs);
      child.stdout?.on("data", (c) => { out += String(c); });
      child.on("error", () => { clearTimeout(timer); done(unknown); });
      child.on("close", () => { clearTimeout(timer); done(parseHolders(out, files)); });
    } catch { done(unknown); }
  });
}
