/** Diagnostic only: measures an isolated Cua host/session; never sends input or moves a pointer. */
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { startCuaDriverHost } from "../src/lib/native/cua-driver-host";

const phases: Array<{ phase: string; ms: number }> = [];
async function measure<T>(phase: string, action: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { return await action(); }
  finally { phases.push({ phase, ms: Math.round((performance.now() - start) * 100) / 100 }); }
}
async function main() {
  const session = `m9r-profile-${randomUUID()}`;
  try {
    const sdk = await measure("sdk-import", () => import("@trycua/cua-driver"));
    const host = await measure("host-spawn-connect-metadata", () => startCuaDriverHost(sdk));
    try {
      for (const temperature of ["cold", "warm-1", "warm-2"]) {
        await measure(`${temperature}:start-session`, () => host.driver.startSession({ session,
          cursorTheme: { themeId: "cua.default", reducedMotion: sdk.CursorReducedMotion.Auto } }));
        const motion = await measure(`${temperature}:configure-motion`, () => host.driver.setAgentCursorMotion({ session,
          style: sdk.CursorMotionStyle.Adaptive, timing: sdk.CursorMotionTiming.Fitts,
          effects: { trail: true, glow: true }, dwellAfterClickMs: 100, idleHideMs: 60_000 }));
        if (motion.isError) throw new Error(`Diagnostic cursor motion setup failed: ${motion.text}`);
      }
    } finally {
      try { await measure("end-session", () => host.driver.endSession({ session })); }
      finally { await measure("close-owned-diagnostic-host", () => host.close()); }
    }
  } finally {
    process.stdout.write(`${JSON.stringify({ diagnostic: "isolated-no-input", phases }, null, 2)}\n`);
  }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
