// End-to-end check of the whole pipeline with real parts: a real `m9r-cli feed --watch`, a real hook and CLI creating
// tasks, and the real overlay window, read back through WebView2's debugging port. No mock feed.
//   node overlay/scripts/e2e-live.mjs [path to m9r-overlay.exe]
// Uses a scratch M9R home (never your real ~/.m9r) and a scratch WebView profile, so nothing of yours is touched.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const exe = process.argv[2] ?? join(repo, "overlay", "src-tauri", "target", "release", "m9r-overlay.exe");
const dist = join(repo, "cli", "dist");
const home = mkdtempSync(join(tmpdir(), "m9r-e2e-"));
const profile = mkdtempSync(join(tmpdir(), "m9r-e2e-webview-"));
const port = 9344;
const clean = { ...process.env, M9R_HOME: home };
for (const k of Object.keys(clean)) if (/^(CLAUDECODE|CLAUDE_CODE_|CODEX_)/.test(k)) delete clean[k];
const agentEnv = { ...clean, CLAUDECODE: "1" };
let failures = 0;
const check = (name, ok, detail = "") => { if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];

async function until(fn, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return { v, took: Date.now() - t0 }; await sleep(60); } return { v: null, took: Date.now() - t0 }; }

try {
  // Real hook registers Claude; the real feed writer starts; then the real window.
  spawnSync(process.execPath, [join(dist, "m9r-hook.js"), "SessionStart", "claude-code"], { env: clean, input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "cc-e2e", cwd: "C:/p" }), windowsHide: true });
  const writer = spawn(process.execPath, [join(dist, "m9r.js"), "feed", "--watch"], { env: clean, stdio: "ignore", windowsHide: true }); procs.push(writer);
  await until(() => spawnSync(process.execPath, ["-e", `process.exit(require("fs").existsSync(${JSON.stringify(join(home, "feed.json"))}) ? 0 : 1)`]).status === 0, 8000);
  const app = spawn(exe, [], { env: { ...clean, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: profile }, stdio: "ignore" }); procs.push(app);

  let page;
  const found = await until(async () => { try { const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); page = t.find((x) => x.type === "page" && !x.url.startsWith("about:")); return page; } catch { return null; } }, 20000);
  check("the overlay window loads its page", !!found.v, `${found.took} ms`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pending = new Map();
  ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
  const evalJs = (expression) => new Promise((res) => { id += 1; pending.set(id, (d) => res(d.result?.result?.value)); ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } })); });
  const dom = () => evalJs(`JSON.stringify({ dots: [...document.querySelectorAll('#dots .dot')].map(d => d.className.replace('dot ','')), badgeHidden: document.getElementById('badge').hidden, badge: document.getElementById('badge').textContent, pingHidden: document.getElementById('ping').hidden, ping: document.getElementById('ping').textContent })`).then((s) => JSON.parse(s ?? "{}"));

  await sleep(1500);
  const first = await dom();
  check("the pill draws the three agents from the real feed (Claude seen, Codex and OpenCode not connected)", first.dots?.length === 3 && first.dots[0] === "seen" && first.dots[1] === "not_connected" && first.dots[2] === "not_connected", JSON.stringify(first.dots));
  check("nothing needs you yet, so there is no badge and no ping", first.badgeHidden === true && first.pingHidden === true);

  // An agent asks for work; it must show on the pill and announce itself, quietly.
  const t0 = Date.now();
  spawnSync(process.execPath, [join(dist, "m9r.js"), "send", "@codex", "Review lease.ts using key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", "--from", "claude"], { env: agentEnv, windowsHide: true });
  const shown = await until(async () => { const d = await dom(); return d.badgeHidden === false && d.pingHidden === false ? d : null; }, 5000);
  check("a new agent task lights the badge and shows a ping on the real pill", !!shown.v && shown.v.badge === "1" && /^@claude asks @codex: Review lease\.ts/.test(shown.v.ping), `${Date.now() - t0} ms total, ping="${(shown.v?.ping ?? "").slice(0, 70)}"`);
  check("the secret in the goal never reached the screen", !JSON.stringify(shown.v ?? {}).includes("sk-ant-api03"), "");

  const gone = await until(async () => { const d = await dom(); return d.pingHidden === true ? d : null; }, 9000);
  check("the ping folds back into the quiet pill after about 6 seconds, the badge stays", !!gone.v && gone.v.badgeHidden === false && gone.took >= 4000 && gone.took <= 8500, `${gone.took} ms`);

  // Deciding elsewhere (a terminal, later the overlay itself) clears it.
  spawnSync(process.execPath, ["--input-type=module", "-e", `import {createLocalStore} from ${JSON.stringify("file:///" + join(dist, "local-store.js").replace(/\\/g, "/"))}; createLocalStore(${JSON.stringify(home)}).setApproval("T1", "denied");`], { env: clean, windowsHide: true });
  const cleared = await until(async () => { const d = await dom(); return d.badgeHidden === true ? d : null; }, 4000);
  check("once the task is decided elsewhere the badge disappears", !!cleared.v, `${cleared.took} ms`);

  // A reset feed (sequence goes backwards) must not silence pings.
  writer.kill(); await sleep(400);
  rmSync(join(home, "feed.json"), { force: true }); rmSync(join(home, "state.json"), { force: true });
  const writer2 = spawn(process.execPath, [join(dist, "m9r.js"), "feed", "--watch"], { env: clean, stdio: "ignore", windowsHide: true }); procs.push(writer2);
  await sleep(2500);
  spawnSync(process.execPath, [join(dist, "m9r.js"), "send", "@codex", "After the reset", "--from", "claude"], { env: agentEnv, windowsHide: true });
  const again = await until(async () => { const d = await dom(); return d.pingHidden === false ? d : null; }, 5000);
  check("after the feed was reset, a new task still pings", !!again.v && /After the reset/.test(again.v.ping), `${again.took} ms`);
  ws.close();
} finally {
  for (const p of procs) { try { p.kill(); } catch { /* already gone */ } }
  await sleep(800);
  for (const d of [home, profile]) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { console.log(`note: could not delete ${d}; safe to delete by hand`); } }
}
console.log(`\n${failures === 0 ? "all steps passed" : `${failures} step(s) FAILED`}`);
process.exit(failures ? 1 : 0);
