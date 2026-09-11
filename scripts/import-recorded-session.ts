// Minimal local CLI: import a strict runleak.recorded.v0 JSON file and print a
// NormalizedManualTrace. NOT a live recorder, SDK, DB, or hosted API — it only
// reads an already-recorded local JSON file and reuses importRecordedSessionJson.
//
// Usage:
//   npm run import:recorded -- examples/recorded-session.example.json
//   npm run import:recorded -- <file.json> --out <output.json>
import { readFileSync, writeFileSync } from "node:fs";
import { importRecordedSessionJson } from "@/lib/cli/recorded-session-import";

const USAGE = `Usage: npm run import:recorded -- <recorded-session.json> [--out <output.json>]

Reads a runleak.recorded.v0 JSON file and prints a NormalizedManualTrace to stdout.
Exact model-call / token / cost fields are populated only from explicit metadata.`;

function main(): void {
  const argv = process.argv.slice(2);
  let inputPath: string | undefined;
  let outPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") {
      outPath = argv[++i];
    } else if (!arg.startsWith("-") && !inputPath) {
      inputPath = arg;
    }
  }

  if (!inputPath) {
    console.error(USAGE);
    process.exit(1);
  }

  let raw: string;
  try {
    raw = readFileSync(inputPath, "utf8");
  } catch {
    console.error(`Error: cannot read file "${inputPath}".`);
    process.exit(1);
  }

  const result = importRecordedSessionJson(raw);
  if (!result.ok) {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }

  const output = JSON.stringify(result.trace, null, 2);
  if (outPath) {
    writeFileSync(outPath, output + "\n");
    console.error(`Wrote ${outPath}`);
  } else {
    console.log(output);
  }
}

main();
