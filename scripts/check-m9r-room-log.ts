import { readFileSync } from "node:fs";
import { checkRoomLitmus } from "../src/lib/mission/room-litmus-core";

const file = process.argv[2];
if (!file) throw new Error("Usage: npx tsx scripts/check-m9r-room-log.ts <room-log.json>");
let input: unknown;
try { input = JSON.parse(readFileSync(file, "utf8")) as unknown; }
catch { throw new Error("Could not read a valid JSON room log."); }
const result = checkRoomLitmus(input);
for (const [criterion, passed] of Object.entries(result.criteria)) process.stdout.write(`${passed ? "PASS" : "FAIL"} ${criterion}\n`);
for (const reason of result.reasons) process.stdout.write(`WHY ${reason}\n`);
process.stdout.write(`${result.pass ? "LITMUS PASS" : "LITMUS FAIL"}\n`);
if (!result.pass) process.exitCode = 1;
