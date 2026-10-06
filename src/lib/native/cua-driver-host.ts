import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { CuaDriverLike } from "@trycua/cua-driver";

const DRIVER_VERSION = "0.33.4";
const START_TIMEOUT_MS = 12_000;
const RETRY_INTERVAL_MS = 100;

export interface CuaDriverSdkConnector {
  CuaDriver: { connect(socketPath: string | undefined): CuaDriverLike };
}

export interface CuaDriverHostConnection {
  driver: CuaDriverLike;
  close(): Promise<void>;
}

export function findBundledCuaDriverExecutable(input: {
  executablePath?: string;
  workingDirectory?: string;
} = {}): string | undefined {
  const executablePath = input.executablePath ?? process.execPath;
  const workingDirectory = input.workingDirectory ?? process.cwd();
  const candidates = [
    join(dirname(executablePath), "cua-driver-runtime", "bin", "cua-driver.exe"),
    join(workingDirectory, "engine", "dist", "cua-driver-runtime", "bin", "cua-driver.exe"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function daemonEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "NODE_ENV", "SystemRoot", "windir", "PATH", "Path", "USERPROFILE", "LOCALAPPDATA", "APPDATA",
    "TEMP", "TMP", "HOMEDRIVE", "HOMEPATH", "USERNAME", "USERDOMAIN", "COMSPEC",
    "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER",
  ];
  const env: NodeJS.ProcessEnv = { NODE_ENV: source.NODE_ENV ?? "production" };
  for (const key of allowed) if (source[key] !== undefined) env[key] = source[key];
  // Do not let the M9R process accidentally mark the standalone UI daemon as embedded.
  env.CUA_DRIVER_EMBEDDED = "0";
  return env;
}

function destroyClient(driver: CuaDriverLike): void {
  const disposable = driver as CuaDriverLike & { uniffiDestroy?: () => void };
  try { disposable.uniffiDestroy?.(); } catch { /* the connection is already unusable */ }
}

async function closeClient(driver: CuaDriverLike | undefined): Promise<void> {
  if (!driver) return;
  try { await driver.shutdown(); } catch { /* daemon clients do not own the daemon */ }
  destroyClient(driver);
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(timeoutMs).then(() => undefined),
  ]);
}

export async function startCuaDriverHost(
  sdk: CuaDriverSdkConnector,
  input: { executablePath?: string; workingDirectory?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CuaDriverHostConnection> {
  if (process.platform !== "win32") throw new Error("The local M9R agent-cursor host is available only on Windows.");
  const executablePath = input.executablePath ?? findBundledCuaDriverExecutable({ workingDirectory: input.workingDirectory });
  if (!executablePath || !existsSync(executablePath)) {
    throw new Error("The bundled Cua Driver Windows host is missing. Rebuild or reinstall the M9R Windows runtime with its matching Cua Driver files.");
  }

  // M9R owns a random private pipe for this broker/runtime. It does not attach to
  // another Cua installation, and the endpoint is never exposed to agent tools.
  const socketPath = `\\\\.\\pipe\\m9r-cua-${randomBytes(16).toString("hex")}`;
  const child = spawn(executablePath, ["serve", "--socket", socketPath], {
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: daemonEnvironment(input.env ?? process.env),
  });
  let childError: Error | undefined;
  let stderr = "";
  child.once("error", (error) => { childError = error; });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
  const childExited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const deadline = Date.now() + START_TIMEOUT_MS;
  let driver: CuaDriverLike | undefined;
  let lastConnectionError = "the named pipe is not ready";

  try {
    while (Date.now() < deadline) {
      if (childError) throw new Error(`The Cua Driver host could not start: ${childError.message}`);
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`The Cua Driver host exited before becoming ready${stderr.trim() ? `: ${stderr.replace(/[\r\n\t]+/g, " ").slice(-500).trim()}` : "."}`);
      }
      try {
        driver = sdk.CuaDriver.connect(socketPath);
        const metadata = await driver.metadata();
        if (metadata.driverVersion !== DRIVER_VERSION) {
          throw new Error(`The Cua Driver host is ${metadata.driverVersion}; M9R requires ${DRIVER_VERSION}.`);
        }
        if (metadata.embedded !== false) throw new Error("The Cua Driver host connected in embedded mode; the visible Windows overlay requires the standalone DPI-aware host.");
        const connectedDriver = driver;
        let closed = false;
        return {
          driver: connectedDriver,
          async close() {
            if (closed) return;
            closed = true;
            await closeClient(connectedDriver);
            if (child.exitCode === null && child.signalCode === null) {
              child.kill();
              await waitForChildExit(child, 1_500);
              if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            }
          },
        };
      } catch (error) {
        if (error instanceof Error && /requires 0\.33\.4|connected in embedded mode/.test(error.message)) throw error;
        lastConnectionError = error instanceof Error ? error.message.replace(/[\r\n\t]+/g, " ").slice(0, 240) : "connection failed";
        await closeClient(driver);
        driver = undefined;
      }
      await Promise.race([delay(RETRY_INTERVAL_MS), childExited]);
    }
    throw new Error(`The Cua Driver host did not become ready within ${START_TIMEOUT_MS / 1_000} seconds (${lastConnectionError}).`);
  } catch (error) {
    await closeClient(driver);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await waitForChildExit(child, 1_500);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    throw error;
  }
}
