import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";

export interface FixtureLaunchSpec {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function restrictedEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "SystemRoot", "TEMP", "TMP", "NO_COLOR"] as const;
  return {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    ...Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
  };
}

/** Build the non-provider fixture used to prove process custody before real adapters are enabled. */
export function buildFixtureLaunchSpec(input: {
  repositoryRoot: string;
  workingDirectory: string;
  grantId: string;
  task: string;
}): FixtureLaunchSpec {
  const root = resolve(input.repositoryRoot);
  const cwd = resolve(root, input.workingDirectory);
  if (!isWithin(root, cwd)) throw new Error("Working directory must remain inside the authorized repository.");
  if (!/^[a-zA-Z0-9._:-]{8,100}$/.test(input.grantId)) throw new Error("Grant id is invalid.");
  const task = input.task.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!task || task.length > 1_000) throw new Error("Fixture task is invalid.");
  const payload = Buffer.from(JSON.stringify({ grantId: input.grantId, task }), "utf8").toString("base64url");
  const program = "const p=JSON.parse(Buffer.from(process.argv[1],'base64url').toString('utf8'));process.stdout.write(JSON.stringify({kind:'oathlock.resident-fixture.v1',grantId:p.grantId,accepted:true})+'\\n')";
  return { executable: process.execPath, args: ["-e", program, payload], cwd, env: restrictedEnvironment(), shell: false };
}

export function runFixtureLaunch(spec: FixtureLaunchSpec, timeoutMs: number): Promise<{
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error("Fixture timeout is invalid.");
  return new Promise((resolveResult, reject) => {
    const child = spawn(spec.executable, spec.args, { cwd: spec.cwd, env: spec.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString("utf8")).slice(0, 16_384); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(0, 16_384); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (exitCode) => { clearTimeout(timer); resolveResult({ exitCode, timedOut, stdout, stderr }); });
  });
}
