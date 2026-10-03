import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { publicErrorMessage } from "@/lib/public-error";

test("server failures and database internals never reach a person; ordinary messages do", () => {
  assert.equal(publicErrorMessage("Could not find the table 'public.user_api_tokens' in the schema cache", 500), "Something went wrong on our side. Please try again.");
  assert.equal(publicErrorMessage("Apply the run-settings migration.", 503), "This is temporarily unavailable. Please try again in a moment.");
  assert.equal(publicErrorMessage('duplicate key value violates unique constraint "x"', 409), "Something went wrong on our side. Please try again.");
  assert.equal(publicErrorMessage("Workspace memory is full. Delete saved memory to make space.", 413), "Workspace memory is full. Delete saved memory to make space.");
  assert.equal(publicErrorMessage("Memory title must be 1–160 characters.", 400), "Memory title must be 1–160 characters.");
});

test("the shared route error handler sends every typed error through the same filter", () => {
  const source = readFileSync(join(process.cwd(), "src/app/api/agent/_shared.ts"), "utf8");
  assert.ok(source.includes('from "@/lib/public-error"'));
  assert.equal(source.match(/error: err\.message/g)?.length ?? 0, 1, "only the plan-limit error, whose message is written for people, is passed through unfiltered");
  assert.ok((source.match(/publicErrorMessage\(err\.message, err\.status\)/g)?.length ?? 0) >= 4);
});

test("no source file tells a person to apply a migration", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!/\.(ts|tsx)$/.test(name)) continue;
      if (/(?:Apply|apply) [^"'`\n]{0,60}migration/.test(readFileSync(path, "utf8"))) offenders.push(path);
    }
  };
  walk(join(process.cwd(), "src"));
  assert.deepEqual(offenders, []);
});
