import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { codeCheckPlan } from "./test-suite-runner-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profile = process.argv[2];
const serial = process.argv[3] === "--serial";
if (!profile || process.argv.length > (serial ? 4 : 3)) {
  console.error("usage: node scripts/check-code.mjs <native|full> [--serial]"); process.exit(2);
}
let plan;
try { plan = codeCheckPlan(profile); } catch (error) { console.error(error.message); process.exit(2); }
const git = args => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
};
const sourceCommit = git(["rev-parse", "HEAD"]);
const sourceDirty = git(["status", "--porcelain=v1"]);
const directory = join(root, ".workcache", "code-check", `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${profile}-${randomUUID().slice(0, 8)}`);
mkdirSync(directory, { recursive: true });
const started = performance.now();
async function run(step) {
  const logPath = join(directory, `${step.name}.log`), log = createWriteStream(logPath);
  const at = performance.now();
  console.log(`CHECK_START profile=${profile} step=${step.name}`);
  return new Promise(resolveStep => {
    const child = spawn(process.execPath, step.args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => log.write(chunk));
    child.stderr.on("data", chunk => log.write(chunk));
    let error = null;
    child.on("error", reason => { error = reason.message; log.write(reason.message + "\n"); });
    child.on("close", code => log.end(() => {
      const elapsedMs = Math.round(performance.now() - at);
      console.log(`CHECK_END profile=${profile} step=${step.name} elapsedMs=${elapsedMs} exit=${code ?? "spawn-error"}`);
      resolveStep({ name: step.name, args: step.args, elapsedMs, exitCode: code, error, logPath: relative(root, logPath) });
    }));
  });
}
const steps = [];
if (serial) for (const step of plan) steps.push(await run(step));
else steps.push(...await Promise.all(plan.map(run)));
const ok = steps.every(step => step.exitCode === 0 && !step.error);
const report = { schemaVersion: 1, profile, developmentOnly: true, releaseAcceptance: false, execution: serial ? "serial" : "parallel",
  sourceCommit, sourceDirty: sourceDirty === null ? null : Boolean(sourceDirty), elapsedMs: Math.round(performance.now() - started), ok, steps };
writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`CHECK_REPORT ${relative(root, join(directory, "report.json"))}`);
console.log(`CHECK_TOTAL profile=${profile} elapsedMs=${report.elapsedMs} ok=${ok} developmentOnly=true`);
process.exitCode = ok ? 0 : 1;
