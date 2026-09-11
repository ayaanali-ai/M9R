// Minimal local CLI: bundle a normalized trace (+ optional findings / prevention
// rules) into a runleak.proof.v0 package JSON. NOT a live recorder, SDK, DB, or
// hosted API — it only reads already-produced local JSON and reuses
// createProofPackage. No external calls.
//
// Usage:
//   npm run proof:package -- <normalized-trace.json> [--out <output.json>]
//   npm run proof:package -- <normalized.json> --findings <findings.json> [--out <out.json>]
//   npm run proof:package -- <normalized.json> --synthetic --out <out.json>
import { readFileSync, writeFileSync } from "node:fs";
import { createProofPackage } from "@/lib/proof-package";

const USAGE = `Usage: npm run proof:package -- <normalized-trace.json> [options]

Options:
  --out <path>          Write the proof package JSON here (default: stdout)
  --recorded <path>     Record the source recorded-trace path in the package
  --findings <path>     JSON file containing a findings array
  --prevention <path>   JSON file containing a prevention-rules array
  --synthetic           Mark the package as a synthetic example

Reads a NormalizedManualTrace JSON file and emits a runleak.proof.v0 package.
Exact fields are copied verbatim from the normalized trace; nothing is invented.`;

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function asArray(v: unknown, label: string): unknown[] {
  if (Array.isArray(v)) return v;
  // Tolerate the prevention-rules example shape { preventionRules: [...] }.
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if (Array.isArray(obj.preventionRules)) return obj.preventionRules;
    if (Array.isArray(obj.findings)) return obj.findings;
  }
  throw new Error(`Expected ${label} to be a JSON array.`);
}

function main(): void {
  const argv = process.argv.slice(2);
  let inputPath: string | undefined;
  let outPath: string | undefined;
  let recordedPath: string | undefined;
  let findingsPath: string | undefined;
  let preventionPath: string | undefined;
  let synthetic = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") outPath = argv[++i];
    else if (arg === "--recorded") recordedPath = argv[++i];
    else if (arg === "--findings") findingsPath = argv[++i];
    else if (arg === "--prevention") preventionPath = argv[++i];
    else if (arg === "--synthetic") synthetic = true;
    else if (!arg.startsWith("-") && !inputPath) inputPath = arg;
  }

  if (!inputPath) {
    console.error(USAGE);
    process.exit(1);
  }

  let normalizedTrace: unknown;
  try {
    normalizedTrace = readJsonFile(inputPath);
  } catch {
    console.error(`Error: cannot read/parse normalized trace "${inputPath}".`);
    process.exit(1);
  }

  let findings: unknown[] | undefined;
  let preventionRules: unknown[] | undefined;
  try {
    if (findingsPath) findings = asArray(readJsonFile(findingsPath), "findings");
    if (preventionPath)
      preventionRules = asArray(readJsonFile(preventionPath), "prevention rules");
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const pkg = createProofPackage({
    normalizedTracePath: inputPath,
    recordedTracePath: recordedPath,
    normalizedTrace: normalizedTrace as Record<string, unknown>,
    findings,
    preventionRules,
    synthetic,
  });

  const output = JSON.stringify(pkg, null, 2);
  if (outPath) {
    writeFileSync(outPath, output + "\n");
    console.error(`Wrote ${outPath}`);
  } else {
    console.log(output);
  }
}

main();
