import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isAgentContext } from "./approval-core";

export interface ApprovedStageApp { executable: string; args: string[]; sha256: string }
const CATALOG = "task-stage-apps.json";
const APP_ID = /^[a-z][a-z0-9_-]{0,39}$/;

export function listApprovedStageApps(root: string): string[] {
  const file = join(root, CATALOG);
  if (!existsSync(file)) return [];
  if (statSync(file).size > 65536) throw new Error("Stage app catalog exceeds its size limit.");
  const catalog = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; apps?: Record<string, unknown> };
  if (catalog.version !== 1 || !catalog.apps || Array.isArray(catalog.apps) || typeof catalog.apps !== "object") throw new Error("Invalid stage app catalog.");
  const ids = Object.keys(catalog.apps);
  if (ids.length > 16 || ids.some((id) => !APP_ID.test(id))) throw new Error("Invalid stage app catalog.");
  return ids.sort();
}

export function readApprovedStageApp(root: string, id: string): ApprovedStageApp {
  if (!APP_ID.test(id)) throw new Error("Invalid stage app identifier.");
  const file = join(root, CATALOG);
  if (!existsSync(file) || statSync(file).size > 65536) throw new Error("No approved stage app catalog is available.");
  const catalog = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; apps?: Record<string, ApprovedStageApp> };
  const app = catalog.version === 1 && catalog.apps && Object.hasOwn(catalog.apps, id) ? catalog.apps[id] : undefined;
  if (!app || !isAbsolute(app.executable) || !/\.exe$/i.test(app.executable) || !Array.isArray(app.args)
    || app.args.length > 16 || app.args.some((arg) => typeof arg !== "string" || arg.length > 2048 || /[\u0000\r\n]/.test(arg))
    || !/^[a-f0-9]{64}$/.test(app.sha256)) throw new Error("This app has not been approved for task stages.");
  if (!statSync(app.executable).isFile() || statSync(app.executable).size > 256 * 1024 * 1024) throw new Error("The approved app exceeds its supported size or is not a file.");
  if (createHash("sha256").update(readFileSync(app.executable)).digest("hex") !== app.sha256) throw new Error("The approved app changed; owner review is required again.");
  return app;
}

/** Only the owner supplies executable paths and fixed arguments; agents select an app ID. */
export function approveStageApp(root: string, id: string, executable: string, args: string[], context: { terminal: boolean; env: Record<string, string | undefined> }) {
  if (!context.terminal || isAgentContext(context.env)) throw new Error("Only the owner can approve stage applications.");
  if (!APP_ID.test(id) || !isAbsolute(executable) || !/\.exe$/i.test(executable) || !statSync(executable).isFile() || statSync(executable).size > 256 * 1024 * 1024
    || args.length > 16 || args.some((arg) => typeof arg !== "string" || arg.length > 2048 || /[\u0000\r\n]/.test(arg))) throw new Error("Invalid stage application.");
  mkdirSync(root, { recursive: true });
  const file = join(root, CATALOG), lock = `${file}.lock`, temp = `${file}.${process.pid}.tmp`;
  mkdirSync(lock);
  try {
    if (existsSync(file) && statSync(file).size > 65536) throw new Error("Stage app catalog exceeds its size limit.");
    const catalog = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as { version: number; apps: Record<string, ApprovedStageApp> } : { version: 1, apps: {} };
    if (catalog.version !== 1 || !catalog.apps || Object.keys(catalog.apps).length >= 16 && !Object.hasOwn(catalog.apps, id)) throw new Error("Invalid or full stage app catalog.");
    catalog.apps[id] = { executable, args, sha256: createHash("sha256").update(readFileSync(executable)).digest("hex") };
    writeFileSync(temp, JSON.stringify(catalog) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); rmSync(lock, { recursive: true, force: true }); }
}

export function launchApprovedStageApp(app: ApprovedStageApp): ChildProcess {
  // No shell, model-provided arguments, inherited stdin, or agent subprocess.
  return spawn(app.executable, app.args, { shell: false, windowsHide: true, stdio: "ignore" });
}
