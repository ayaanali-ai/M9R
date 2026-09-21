#!/usr/bin/env node
// Stage 1 acceptance (M9R_NETWORK_SPEC.md section 25), automated parts. Prints PASS/FAIL per step, exits 1 on any FAIL.
//
//   node scripts/stage1-acceptance.mjs [--target claude-code] [--sender codex] [--restart-bridges]
//
// Runs against the real staging app with real sessions, so it posts a few short test messages in #general and
// uses a few tokens of the target's subscription. Env: OATHLOCK_API_URL (default staging).
// Step 6 (kill mid-turn) is scripts/stage1-restart-kill-test.ps1. The Relay lease check is scripts/stage1-relay-lease-live.ts.
// --restart-bridges (Windows) also restarts the local bridge runners to prove a message sent during the gap is delivered once.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const TARGET = opt("target", "claude-code");
const SENDER = opt("sender", "codex");
const RESTART = args.includes("--restart-bridges");
const API = process.env.OATHLOCK_API_URL ?? "https://app.m9r.workers.dev";
const root = resolve(import.meta.dirname, "..");
const cli = resolve(root, "cli/dist/m9r.js");
const token = JSON.parse(readFileSync(resolve(root, `.oathlock/agents/${SENDER}/local.json`), "utf8")).token;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function m9r(...cliArgs) {
  const r = spawnSync(process.execPath, [cli, ...cliArgs, "--agent-kind", SENDER], { env: { ...process.env, OATHLOCK_API_URL: API }, encoding: "utf8", windowsHide: true });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", all: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const results = [];
function check(step, name, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  [${step}] ${name}${detail ? `  -- ${detail}` : ""}`);
}
const tag = () => randomBytes(3).toString("hex");
const idFrom = (text) => /delivery ([0-9a-f-]{36})/.exec(text)?.[1] ?? null;

async function waitForState(messageId, wanted, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = m9r("delivery", messageId).out;
    if (new RegExp(`: ${wanted} \\(attempt`).test(last)) return last;
    await sleep(3000);
  }
  return last;
}
const statesIn = (delivery) => [...delivery.matchAll(/^ {2}\d\d:\d\d:\d\d {2}(\w+)/gm)].map((m) => m[1]);

// 1. endpoints
const list = m9r("endpoints");
check(1, "endpoints lists the workspace's endpoints with fidelity and presence", list.code === 0 && /endpoints: \d+/.test(list.out) && /fidelity: /.test(list.out) && /presence: /.test(list.out));

// 2. resolve the target
const resolved = m9r("resolve", `@${TARGET}`);
check(2, `resolve @${TARGET} is live with a native fidelity level`, resolved.code === 0 && /reachability: live/.test(resolved.out) && /fidelity: LIVE_NATIVE/.test(resolved.out), resolved.out.split("\n")[0]);

// 3. ask, with the delivery timeline
const first = `reply with only the word ok (${tag()})`;
const asked = m9r("ask", `@${TARGET}`, first);
const messageId = idFrom(asked.out);
check(3, "ask returns a message id to track", asked.code === 0 && !!messageId);
const timeline = messageId ? await waitForState(messageId, "completed") : "";
const order = statesIn(timeline);
const inOrder = ["accepted", "delivered_to_node", "delivered_to_session", "processing", "completed"].every((s, i) => order[i] === s);
check(3, "the delivery timeline shows every state, in order, with adapter evidence", inOrder && !/implied/.test(timeline), order.join(" > "));

// 4. same request twice: one message, one turn
const dup = `reply with only the word ok (${tag()})`;
const a = m9r("ask", `@${TARGET}`, dup);
const b = m9r("ask", `@${TARGET}`, dup);
const idA = idFrom(a.out), idB = idFrom(b.out);
check(4, "the same ask twice returns the same message id", !!idA && idA === idB, `${idA} / ${idB}`);
const dupDelivery = idA ? await waitForState(idA, "completed") : "";
check(4, "and produces exactly one turn (one session hand-off, attempt 1)", (dupDelivery.match(/delivered_to_session/g) ?? []).length === 1 && /attempt 1\)/.test(dupDelivery));

// 5. same idempotency key, different text: 409
const channels = await fetch(`${API}/api/agent/conversations`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
const general = channels.conversations.find((c) => c.channel_kind === "channel" && String(c.topic).toLowerCase() === "general");
const key = `stage1-acceptance-${tag()}`;
const post = (body) => fetch(`${API}/api/agent/conversations/${general.id}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ kind: "notice", body }) });
const one = await post(`stage 1 acceptance idempotency probe ${key}`);
const same = await post(`stage 1 acceptance idempotency probe ${key}`);
const changed = await post(`stage 1 acceptance idempotency probe CHANGED ${key}`);
const oneBody = await one.json(), sameBody = await same.json();
check(5, "same key and same content replays the original message", one.status === 201 && (same.status === 200 || same.status === 201) && oneBody.message?.id === sameBody.message?.id, `${one.status}/${same.status}`);
check(5, "same key with different content is refused as a conflict", changed.status === 409, `status ${changed.status}`);

// 8. offline endpoint: durable address, queued, not live
const offline = m9r("resolve", "@opencode");
const offlineOk = offline.code === 0 && /reachability: queue/.test(offline.out) && /presence: offline \(unknown\)/.test(offline.out) && /fidelity: CONSULTATION/.test(offline.out);
if (/no connected agent|No agent named/.test(offline.all)) console.log("SKIP  [8] no @opencode endpoint in this workspace");
else check(8, "an endpoint with no live session resolves as queue/offline/consultation, never live", offlineOk, offline.out.split("\n")[1]?.trim());

// 9. unknown address
const missing = m9r("resolve", `@nobody-${tag()}`);
check(9, "an unknown address is ENDPOINT_NOT_FOUND and lists the known agents", missing.code === 1 && /No agent named/.test(missing.all) && /Known agents:/.test(missing.all));
const handle = m9r("resolve", "@sarah/claude");
check(9, "owner handles are refused honestly until they exist", handle.code === 1 && /not available yet/.test(handle.all));

// 7'. a message sent while the bridges are restarting is delivered exactly once
if (RESTART) {
  if (process.platform !== "win32") console.log("SKIP  [7] --restart-bridges is Windows-only");
  else {
    const ps = (script) => execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true });
    ps("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'bridge-runner' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }");
    const gap = `reply with only the word ok (${tag()})`;
    const sent = m9r("ask", `@${TARGET}`, gap);
    const gapId = idFrom(sent.out);
    const gapDelivery = gapId ? await waitForState(gapId, "completed", 200_000) : "";
    const handoffs = (gapDelivery.match(/delivered_to_session/g) ?? []).length;
    check(7, "a message sent while the bridges were down is delivered once after they return: no loss, no duplicate", /: completed \(attempt/.test(gapDelivery) && handoffs === 1, `${handoffs} hand-off(s)`);
  }
} else console.log("SKIP  [7] pass --restart-bridges to run the bridge-restart delivery check");

console.log("SKIP  [6] kill mid-turn: run scripts/stage1-restart-kill-test.ps1");
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
