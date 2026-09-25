// End-to-end check of clicking Approve / Deny on the real pill: the real overlay starts its own engine (no Node used for M9R),
// real tasks are created by an agent-marked CLI call, and real mouse events are sent to the buttons through WebView2's debug port.
//   node overlay/scripts/e2e-approve.mjs [overlay exe] [engine exe]
// Uses a scratch M9R home and a scratch WebView profile. Tasks are aimed at @claude so nothing is ever pushed into a real Codex.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const exe = process.argv[2] ?? join(repo, "overlay", "src-tauri", "target", "release", "m9r-overlay.exe");
const engine = process.argv[3] ?? join(repo, "engine", "dist", "m9r-engine.exe");
const home = mkdtempSync(join(tmpdir(), "m9r-appr-"));
const profile = mkdtempSync(join(tmpdir(), "m9r-appr-webview-"));
const port = 9345;
const clean = { ...process.env, M9R_HOME: home, M9R_ENGINE: engine };
for (const k of Object.keys(clean)) if (/^(CLAUDECODE|CLAUDE_CODE_|CODEX_|M9R_SEND_AS_HUMAN)/.test(k)) delete clean[k];
const agentEnv = { ...clean, CODEX_HOME: "x", CLAUDECODE: "1" };
let failures = 0;
const check = (name, ok, detail = "") => { if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(80); } return null; };
const cli = (args, env = clean) => spawnSync(engine, args, { env, encoding: "utf8", windowsHide: true });
const ask = (goal) => cli(["send", "@claude", goal, "--from", "codex"], agentEnv);

try {
  const app = spawn(exe, [], { env: { ...clean, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: profile }, stdio: "ignore" }); procs.push(app);
  let page;
  await until(async () => { try { const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); page = t.find((x) => x.type === "page" && !x.url.startsWith("about:")); return page; } catch { return null; } }, 20000);
  if (!page) throw new Error("the overlay window never loaded");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pending = new Map();
  ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
  const send = (method, params) => new Promise((res) => { id += 1; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = (expression) => send("Runtime.evaluate", { expression, returnByValue: true }).then((d) => d.result?.result?.value);
  const rows = () => evalJs(`JSON.stringify([...document.querySelectorAll('.row')].filter(r => r.querySelector('.title') && /asks/.test(r.textContent)).map(r => ({ text: r.textContent, buttons: [...r.querySelectorAll('button')].map(b => b.textContent) })))`).then((s) => JSON.parse(s ?? "[]"));
  const clickButton = async (label) => {
    const box = JSON.parse(await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent === ${JSON.stringify(label)}); if (!b) return 'null'; const r = b.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
    if (!box) return false;
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    return true;
  };
  const openPanel = () => evalJs(`document.getElementById('pill').click()`);

  await until(() => cli(["feed"]).status === 0 && true, 8000);
  check("the overlay started the engine itself (feed exists, lock held)", await until(() => spawnSync("powershell", ["-NoProfile", "-Command", `Test-Path '${join(home, "feed.lock")}'`], { encoding: "utf8" }).stdout.trim() === "True", 8000));

  // 1. An ordinary ask: Approve
  ask("Summarise the open TODOs in this repo");
  await until(async () => (await rows()).length > 0, 6000);
  await openPanel(); await sleep(400);
  let r = await rows();
  if (r.length === 0) console.log("DEBUG page:", JSON.stringify(await evalJs("document.body.innerText")), "hidden panel:", await evalJs("document.getElementById('panel').hidden"));
  check("an ordinary ask shows Approve, Deny and the one-day link", r.length === 1 && ["Approve", "Deny", "Allow this kind for a day"].every((l) => r[0].buttons.includes(l)), JSON.stringify(r[0]?.buttons));
  await clickButton("Approve");
  const said = await until(() => evalJs(`(document.querySelector('.result.ok') || {}).textContent || ''`).then((t) => (/^Approved/.test(t) ? t : null)), 3000);
  check("the row says what happened after the click", !!said, said ?? "no confirmation shown");
  const after = await until(async () => { const t = cli(["tasks"]).stdout; return /pushed into the session|in the inbox|delivered/.test(t) && !/awaiting approval/.test(t) ? t : null; }, 6000);
  check("clicking Approve with a real mouse event approves the task in the store", !!after, (after ?? cli(["tasks"]).stdout).split("\n")[0]);

  // 2. Deny
  ask("Rename the config folder");
  await until(async () => (await rows()).some((x) => /Rename the config/.test(x.text)), 6000);
  await openPanel(); await sleep(300); if (!(await rows()).length) { await openPanel(); await sleep(300); }
  await clickButton("Deny");
  const denied = await until(() => (/denied/.test(cli(["tasks"]).stdout) ? true : null), 6000);
  check("clicking Deny denies the task", !!denied);

  // 3. Protected: no one-day link, wording says once
  ask("Deploy the site to production");
  await until(async () => (await rows()).some((x) => /Deploy the site/.test(x.text)), 6000);
  await sleep(500);
  r = (await rows()).filter((x) => /Deploy the site/.test(x.text));
  check("a protected ask has 'Approve this once' and no one-day link", r.length === 1 && r[0].buttons.includes("Approve this once") && !r[0].buttons.includes("Allow this kind for a day"), JSON.stringify(r[0]?.buttons));
  await clickButton("Deny"); await sleep(600);

  // 4. Allow for a day: approves this one and creates a one-day rule
  ask("List the test files");
  await until(async () => (await rows()).some((x) => /List the test files/.test(x.text)), 6000);
  await sleep(500);
  await clickButton("Allow this kind for a day");
  const rule = await until(() => (/@codex/.test(cli(["standing"]).stdout) && /@claude/.test(cli(["standing"]).stdout) ? cli(["standing"]).stdout : null), 6000);
  check("'Allow this kind for a day' creates a one-day rule for that pair", !!rule, (rule ?? "").split("\n")[0]);
  const t = cli(["tasks"]).stdout;
  check("...and the task itself was approved", !/List the test files[^\n]*awaiting/.test(t), t.split("\n")[0]);

  // 5. The same buttons cannot be reached by an agent: a plain agent-marked CLI approve is refused
  ask("Remove old logs");
  await sleep(500);
  const id5 = /(T\d+)\s+@codex -> @claude\s+\[awaiting approval\]\s+Remove old logs/.exec(cli(["tasks"]).stdout)?.[1];
  const agentTry = cli(["approve", id5 ?? "T99", "--yes"], agentEnv);
  check("an agent-marked process still cannot approve (the terminal rule is unchanged)", agentTry.status !== 0 && /person/i.test(agentTry.stderr + agentTry.stdout), (agentTry.stderr || agentTry.stdout).slice(0, 80));
  ws.close();
} finally {
  // Stop only what this run started: the engine is the overlay's child, so match on the parent, never on the name.
  for (const p of procs) if (p.pid) spawnSync("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "ParentProcessId=${p.pid}" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { windowsHide: true });
  for (const p of procs) { try { p.kill(); } catch { /* already gone */ } }
  await sleep(600);
  await sleep(600);
  for (const d of [home, profile]) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { console.log(`note: could not delete ${d}; safe to delete by hand`); } }
}
console.log(`\n${failures === 0 ? "all steps passed" : `${failures} step(s) FAILED`}`);
process.exit(failures ? 1 : 0);
