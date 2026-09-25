/**
 * `M9R_BENCH_ALLOW_SPEND=1 npm run bench:real -- --task search --condition solo,coordinated --seed 1 [--model sonnet] [--vendors claude,codex,claude] [--out results.jsonl]`
 * Runs real Claude Code sessions through M9R. Uses subscription quota; prints real token usage for every run.
 */
import { appendFileSync } from "node:fs";
import type { TaskName } from "./bench-data";
import { ROLES } from "./prompts";
import { runReal, type RealRunResult, type Vendor } from "./real-runner";
import { CONDITIONS, type Condition } from "./strategies";

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function describe(r: RealRunResult): string {
  const seconds = (ms: number | null) => (ms === null ? "not submitted" : `${(ms / 1000).toFixed(1)}s`);
  const lines = [
    `${r.task}/${r.condition} seed ${r.seed}: ${r.correct ? "CORRECT" : r.submitted ? "WRONG ANSWER" : "NO ANSWER"}, submitted at ${seconds(r.wallMs)}, all agents done at ${seconds(r.totalMs)}`,
    `  turns ${r.totals.turns}, tokens ${r.totals.tokens.toLocaleString()}, cost $${r.totals.costUsd.toFixed(3)} (API-equivalent), messages ${r.messages}, page loads ${r.pageLoads}`,
  ];
  for (const a of r.agents) {
    lines.push(`  ${a.role} (${a.vendor ?? "claude"}): ${a.turns} turns, $${a.costUsd.toFixed(3)}${a.killed ? ", KILLED" : ""}${a.error ? `, ${a.error}` : ""}${a.reply ? `; said: ${a.reply.replace(/\s+/g, " ").slice(0, 100)}` : ""}`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const task = (argument("task") ?? "search") as TaskName;
  const seeds = (argument("seed") ?? "1").split(",").map(Number);
  const wanted = (argument("condition") ?? "solo").split(",") as Condition[];
  const conditions = wanted.filter((c) => CONDITIONS.includes(c));
  const model = argument("model");
  const out = argument("out");
  const vendorList = (argument("vendors") ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  if (vendorList.some((v) => v !== "claude" && v !== "codex")) throw new Error(`--vendors takes claude or codex per role, in order a1,a2,a3; got "${vendorList.join(",")}"`);
  const vendors = Object.fromEntries(vendorList.map((v, i) => [ROLES[i], v as Vendor]).filter(([role]) => role));
  if (task !== "trip" && task !== "search") throw new Error(`unknown task ${task}`);
  if (conditions.length === 0) throw new Error(`no valid condition in "${wanted.join(",")}"`);

  for (const seed of seeds) {
    for (const condition of conditions) {
      const result = await runReal({ task, condition, seed, model, vendors });
      process.stdout.write(`${describe(result)}\n\n`);
      if (out) appendFileSync(out, `${JSON.stringify(result)}\n`);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
