/**
 * `npm run bench:scripted -- [--seeds 1,2,3] [--think 150]`
 * Validates the benchmark harness with scripted agents. The numbers describe the harness and the task design, not real agents.
 */
import { runScripted, type RunResult } from "./scripted-runner";

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function main(): Promise<void> {
  const seeds = (argument("seeds") ?? "1").split(",").map(Number);
  const thinkMs = Number(argument("think") ?? 150);
  process.stdout.write(`SCRIPTED SIMULATION, not evidence about real agents. seeds=${seeds.join(",")} think=${thinkMs}ms per step\n\n`);
  const results = await runScripted({ seeds, thinkMs });

  const groups = new Map<string, RunResult[]>();
  for (const r of results) groups.set(`${r.task}/${r.condition}`, [...(groups.get(`${r.task}/${r.condition}`) ?? []), r]);

  process.stdout.write("task/condition        correct   wall ms (median)   tool calls   page loads\n");
  for (const [name, rows] of groups) {
    const walls = rows.map((r) => r.wallMs).filter((w): w is number => w !== null);
    const correct = rows.filter((r) => r.correct).length;
    process.stdout.write(
      `${name.padEnd(22)}${`${correct}/${rows.length}`.padEnd(10)}${String(walls.length ? Math.round(median(walls)) : "-").padEnd(19)}${String(Math.round(median(rows.map((r) => r.toolCalls)))).padEnd(13)}${Math.round(median(rows.map((r) => r.pageLoads)))}\n`,
    );
  }
  const failures = results.filter((r) => r.error);
  for (const f of failures) process.stdout.write(`\nERROR ${f.task}/${f.condition} seed ${f.seed}: ${f.error}\n`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
