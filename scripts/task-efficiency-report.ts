import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { createTaskEfficiencyReport, type EfficiencyRates, type EfficiencyReview } from "../src/lib/native/task-efficiency-report";
import type { Task } from "../src/lib/native/inbox-core";
import { createHash } from "node:crypto";

const help = "npm run report:efficiency -- --format claude|codex --transcript PATH --from ISO --to ISO [--state PATH --tasks T1,T2] [--review PATH] [--rates PATH] [--out PATH]\nRead-only analysis; no model calls. Output contains counters and evidence line numbers, not prompts, screenshots or raw errors. Review JSON: {artifactCorrect:boolean|null,ownerInterventions:number|null,evidence:string}. Rates JSON: {inputAccounting:'exclusive'|'includes-cache-read',inputUsdPerMillion:number,outputUsdPerMillion:number,cacheReadUsdPerMillion:number,cacheWriteUsdPerMillion:number}. Rates are explicit API estimates, never subscription allowance.";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { process.stdout.write(help + "\n"); return; }
  const allowed = new Set(["format", "transcript", "from", "to", "state", "tasks", "review", "rates", "out"]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, "");
    const value = args[index + 1];
    if (!args[index]?.startsWith("--") || !key || !allowed.has(key) || !value || value.startsWith("--") || values.has(key)) throw new Error("Invalid or duplicate report arguments. Use --help.");
    values.set(key, value);
  }
  const format = values.get("format"), transcript = values.get("transcript"), from = values.get("from"), to = values.get("to");
  if ((format !== "claude" && format !== "codex") || !transcript || !from || !to) throw new Error("Explicit format, transcript, from and to are required. Use --help.");
  if (!/(?:Z|[+-]\d\d:\d\d)$/.test(from) || !/(?:Z|[+-]\d\d:\d\d)$/.test(to)) throw new Error("Timestamps must include Z or an explicit UTC offset.");
  const taskIds = values.get("tasks")?.split(",");
  if (taskIds?.some(id => !/^T[0-9]{1,12}$/.test(id))) throw new Error("Invalid task IDs.");
  if (values.has("state") !== Boolean(taskIds?.length)) throw new Error("State and exact task IDs must be supplied together.");
  const digests: Record<string, string> = {};
  const readJson = (key: string): unknown => {
    const bytes = readFileSync(values.get(key)!);
    digests[key] = createHash("sha256").update(bytes).digest("hex");
    return JSON.parse(bytes.toString("utf8"));
  };
  let tasks: Task[] | undefined;
  if (values.has("state")) {
    const state = readJson("state") as { tasks?: Task[] };
    if (!state || !Array.isArray(state.tasks)) throw new Error("State has no tasks array.");
    tasks = state.tasks;
  }
  const inputs = [transcript, ...["state", "review", "rates"].flatMap(key => values.has(key) ? [values.get(key)!] : [])].map(path => resolve(path).toLowerCase());
  if (values.has("out") && inputs.includes(resolve(values.get("out")!).toLowerCase())) throw new Error("The output must not overwrite an input evidence file.");
  const collector = createTaskEfficiencyReport({ format, from, to, tasks, taskIds,
    ...(values.has("review") ? { review: readJson("review") as EfficiencyReview } : {}),
    ...(values.has("rates") ? { rates: readJson("rates") as EfficiencyRates } : {}) });
  const input = createReadStream(transcript);
  const transcriptDigest = createHash("sha256");
  input.on("data", chunk => transcriptDigest.update(chunk));
  const lines = createInterface({ input, crlfDelay: Infinity });
  try { for await (const line of lines) collector.addLine(line); }
  finally { lines.close(); input.destroy(); }
  digests.transcript = transcriptDigest.digest("hex");
  const json = JSON.stringify({ ...collector.finish(), inputSha256: digests }, null, 2) + "\n";
  if (values.has("out")) writeFileSync(values.get("out")!, json, { flag: "wx" });
  else process.stdout.write(json);
}

main().catch(() => { process.stderr.write("Efficiency report failed: check arguments and input schemas/files. Use --help. No model call or input mutation was performed.\n"); process.exitCode = 1; });
