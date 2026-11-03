#!/usr/bin/env node
// Mechanical audit: for every function in cua-stage-driver.ts, report whether
// its body calls into Cua Driver and whether it has native (SendInput)
// dispatch wired. This is deliberately dumb line-range scanning, not
// judgment -- the point is a count neither Claude nor Codex can fudge by
// skimming the file and trusting their own memory of what they already
// touched.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetPath = path.join(repoRoot, "src/lib/native/cua-stage-driver.ts");
const text = readFileSync(targetPath, "utf8");
const lines = text.split(/\r?\n/);

const FUNCTION_RE = /^\s*(?:export\s+)?async function (\w+)\(/;
const CUA_CALL_RE = /\bdriver\.callTool\(|\bdriver\.click\(|\bdriver\.pressKey\(|\bdriver\.hotkey\(|\bdriver\.typeText\(|\bdriver\.scroll\(|\bdriver\.drag\(|\bdriver\.moveCursor\(|\brunner?\.driver\.callTool\(|\bruntime\.driver\.(?:callTool|click|pressKey|hotkey|typeText|scroll|drag|moveCursor)\(/;
const NATIVE_RE = /nativeForeground/;

const starts = [];
for (let i = 0; i < lines.length; i++) {
  const m = FUNCTION_RE.exec(lines[i]);
  if (m) starts.push({ line: i, name: m[1] });
}
starts.push({ line: lines.length, name: "__EOF__" });

const rows = [];
for (let i = 0; i < starts.length - 1; i++) {
  const { line: startLine, name } = starts[i];
  const endLine = starts[i + 1].line;
  const body = lines.slice(startLine, endLine).join("\n");
  const hasCuaCall = CUA_CALL_RE.test(body);
  const hasNative = NATIVE_RE.test(body);
  rows.push({
    name,
    startLine: startLine + 1,
    endLine,
    hasCuaCall,
    hasNative,
    verdict: !hasCuaCall ? "no-cua-call-found" : hasNative ? "NATIVE-WIRED" : "CUA-ONLY",
  });
}

const cuaOnly = rows.filter((r) => r.verdict === "CUA-ONLY");
const nativeWired = rows.filter((r) => r.verdict === "NATIVE-WIRED");
const noCua = rows.filter((r) => r.verdict === "no-cua-call-found");

console.log(`Scanned ${path.relative(repoRoot, targetPath)}: ${rows.length} top-level functions found.\n`);
console.log(`=== CUA-ONLY (zero native dispatch) -- ${cuaOnly.length} functions ===`);
for (const r of cuaOnly) console.log(`  ${r.name}  (line ${r.startLine}-${r.endLine})`);
console.log(`\n=== NATIVE-WIRED (has nativeForeground somewhere in body) -- ${nativeWired.length} functions ===`);
for (const r of nativeWired) console.log(`  ${r.name}  (line ${r.startLine}-${r.endLine})`);
console.log(`\n=== No direct Cua Driver call detected (may delegate, may be unrelated) -- ${noCua.length} functions ===`);
for (const r of noCua) console.log(`  ${r.name}  (line ${r.startLine}-${r.endLine})`);

console.log(`\nSUMMARY: ${cuaOnly.length} Cua-only, ${nativeWired.length} native-wired, ${noCua.length} no-direct-call, ${rows.length} total.`);
console.log(`\nNOTE: "NATIVE-WIRED" only means the word nativeForeground appears in the function's own body between its declaration and the next function's declaration. It does NOT mean every code path inside the function uses it (e.g. a function can have one branch wired and another, like a "replace" mode, still calling Cua directly) -- read the flagged function's body to confirm before trusting the label beyond this top-level count.`);
