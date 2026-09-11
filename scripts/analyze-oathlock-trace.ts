// Run the existing coding-agent detectors against an exported OathLock trace.
//   npm run analyze:trace -- examples/sample-traces/oathlock-messy-coding-agent.json
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseTraceJson,
  parseTraceJsonl,
  analyzeOathlockTrace,
  expectationFired,
  EXPECTED_DETECTOR_MAP,
} from "@/lib/oathlock-trace-adapter";

const file = process.argv[2];
if (!file) {
  console.error("usage: analyze-oathlock-trace <path-to-trace.json|.jsonl>");
  process.exit(1);
}

const text = readFileSync(resolve(process.cwd(), file), "utf8");
const trace = file.endsWith(".jsonl") ? parseTraceJsonl(text) : parseTraceJson(text);
const findings = analyzeOathlockTrace(trace);

console.log(`\n=== ${file} ===`);
console.log(`variant: ${trace.variant} · steps: ${trace.totals.steps}`);
console.log(`findings: ${findings.length}`);
for (const f of findings) {
  console.log(`  - [${f.severity}] ${f.type} :: ${f.title} (confidence: ${f.confidence})`);
}

console.log("\nexpected detectors:");
for (const key of Object.keys(EXPECTED_DETECTOR_MAP) as (keyof typeof EXPECTED_DETECTOR_MAP)[]) {
  const fired = expectationFired(findings, key);
  console.log(`  ${fired ? "FIRED   " : "no fire "} ${key}`);
}
