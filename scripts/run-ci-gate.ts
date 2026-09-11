// Minimal local CLI: consume a runleak.policy.v0 advisory report and produce a
// runleak.ci-gate.v0 result. DEFAULT IS DRY-RUN AND NON-BLOCKING (exit 0).
// NOT a GitHub Action, SDK, DB, or hosted API — no external calls.
//
// Usage:
//   npm run ci:gate -- <policy-report.json> [--mode dry-run|enforce] [--threshold fail|warn] [--out <path>]
import { readFileSync, writeFileSync } from "node:fs";
import { evaluateCIGate, type CIGateMode, type CIGateThreshold } from "@/lib/ci-gate";

const USAGE = `Usage: npm run ci:gate -- <policy-report.json> [options]

Options:
  --mode <dry-run|enforce>   Default: dry-run (non-blocking, always exit 0)
  --threshold <fail|warn>    Default: fail
  --out <path>               Write the gate result JSON here (default: stdout)

Consumes a runleak.policy.v0 report. No external calls; nothing is recomputed.`;

function main(): void {
  const argv = process.argv.slice(2);
  let inputPath: string | undefined;
  let outPath: string | undefined;
  let mode: CIGateMode | undefined;
  let threshold: CIGateThreshold | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") outPath = argv[++i];
    else if (arg === "--mode") {
      const v = argv[++i];
      if (v !== "dry-run" && v !== "enforce") {
        console.error(`Error: --mode must be "dry-run" or "enforce".`);
        process.exit(2);
      }
      mode = v;
    } else if (arg === "--threshold") {
      const v = argv[++i];
      if (v !== "fail" && v !== "warn") {
        console.error(`Error: --threshold must be "fail" or "warn".`);
        process.exit(2);
      }
      threshold = v;
    } else if (!arg.startsWith("-") && !inputPath) {
      inputPath = arg;
    }
  }

  if (!inputPath) {
    console.error(USAGE);
    process.exit(2);
  }

  let policyReport: unknown;
  try {
    policyReport = JSON.parse(readFileSync(inputPath, "utf8"));
  } catch {
    console.error(`Error: cannot read/parse policy report "${inputPath}".`);
    process.exit(2);
  }

  if (
    !policyReport ||
    typeof policyReport !== "object" ||
    (policyReport as Record<string, unknown>).reportVersion !== "runleak.policy.v0"
  ) {
    console.error(
      `Error: input is not a runleak.policy.v0 report (run "npm run policy:check" first).`,
    );
    process.exit(2);
  }

  const result = evaluateCIGate({
    policyReport: policyReport as Record<string, unknown>,
    mode,
    threshold,
  });

  const output = JSON.stringify(result, null, 2);
  if (outPath) {
    writeFileSync(outPath, output + "\n");
    console.error(
      `Wrote ${outPath} (mode: ${result.mode}, threshold: ${result.threshold}, wouldBlock: ${result.wouldBlock}, exitCode: ${result.exitCode})`,
    );
  } else {
    console.log(output);
  }

  // Exit using the computed exit code (dry-run is always 0).
  process.exit(result.exitCode);
}

main();
