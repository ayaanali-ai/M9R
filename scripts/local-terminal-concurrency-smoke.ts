import process from "node:process";
import * as pty from "node-pty";

const markers = ["OATHLOCK_CLAUDE_PTY", "OATHLOCK_CODEX_PTY"] as const;

function spawnMarker(marker: string) {
  const command = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
  const args = process.platform === "win32"
    ? ["-NoLogo", "-NonInteractive", "-Command", `Write-Output ${marker}; Start-Sleep -Milliseconds 250`]
    : ["-lc", `printf '${marker}\\n'; sleep 0.25`];
  return pty.spawn(command, args, {
    cwd: process.cwd(),
    cols: 100,
    rows: 30,
    env: process.env as Record<string, string>,
    name: "xterm-256color",
    ...(process.platform === "win32" ? { useConptyDll: true, conptyInheritCursor: true } : {}),
  });
}

async function readMarker(marker: string): Promise<{ pid: number; output: string }> {
  const handle = spawnMarker(marker);
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => { handle.kill(); reject(new Error(`${marker} did not produce PTY output.`)); }, 10_000);
    handle.onData((data) => { output += data; });
    handle.onExit(() => {
      clearTimeout(timer);
      if (!output.includes(marker)) reject(new Error(`${marker} output was not observed.`));
      else resolve({ pid: handle.pid, output });
    });
  });
}

void Promise.all(markers.map(readMarker)).then((sessions) => {
  if (sessions[0].pid === sessions[1].pid) throw new Error("Concurrent PTYs unexpectedly shared a process id.");
  process.stdout.write("PASS: Claude-labelled and Codex-labelled workloads produced output concurrently in independent real PTYs.\n");
  process.exit(0);
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
