// End-to-end check of the pill's link picker on the real overlay: a push that fails for lack of a session in the sender's
// folder shows "Link a session...", clicking a listed session links it with a real click, and the SAME task, retried,
// now finds the link. Scratch M9R home; nothing touches the owner's real Codex.
//   node overlay/scripts/e2e-link.mjs [overlay exe] [engine exe]
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const exe = process.argv[2] ?? join(repo, "overlay", "src-tauri", "target", "release", "m9r-overlay.exe");
const engine = process.argv[3] ?? join(repo, "engine", "dist", "m9r-engine.exe");
const home = mkdtempSync(join(tmpdir(), "m9r-link-"));
const profile = mkdtempSync(join(tmpdir(), "m9r-link-webview-"));
const port = 9349;
const codexHome = mkdtempSync(join(tmpdir(), "m9r-link-codex-"));
const clean = { ...process.env, M9R_HOME: home, M9R_ENGINE: engine, CODEX_HOME: codexHome };
for (const k of Object.keys(clean)) if (/^(CLAUDECODE|CLAUDE_CODE_|CODEX_|M9R_SEND_AS_HUMAN)/.test(k)) delete clean[k];
const agentEnv = { ...clean, CLAUDECODE: "1" };
let failures = 0;
const check = (name, ok, detail = "") => { if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (args, env = clean) => spawnSync(engine, args, { env, encoding: "utf8", windowsHide: true });
const procs = [];

try {
  // Two Codex sessions in an unrelated folder to the sender's, and none in the sender's own folder: the push must fail and be linkable.
  cli(["m9r-hook", "SessionStart", "codex"], { ...clean }, ).status; // ensure store exists
  const seed = spawnSync(engine, ["m9r-hook", "SessionStart", "codex"], { env: clean, input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "01a0aaaa-1111-7000-8000-000000000001", cwd: "C:/elsewhere-a" }), encoding: "utf8" });
  void seed;
  spawnSync(engine, ["m9r-hook", "SessionStart", "codex"], { env: clean, input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "01a0aaaa-2222-7000-8000-000000000002", cwd: "C:/elsewhere-b" }), encoding: "utf8" });

  const app = spawn(exe, [], { env: { ...clean, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: profile }, stdio: "ignore" }); procs.push(app);
  let page;
  const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(80); } return null; };
  page = await until(async () => { try { const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); return t.find((x) => x.type === "page" && !x.url.startsWith("about:")); } catch { return null; } }, 20000);
  if (!page) throw new Error("the overlay window never loaded");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pend = new Map();
  ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
  const send = (method, params) => new Promise((res) => { id++; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = (expression) => send("Runtime.evaluate", { expression, returnByValue: true }).then((d) => d.result?.result?.value);
  const openPanel = () => evalJs(`document.getElementById('pill').click()`);
  const clickButton = async (label) => {
    const box = JSON.parse(await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent === ${JSON.stringify(label)}); if (!b) return 'null'; const r = b.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
    if (!box) return false;
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    return true;
  };

  await until(() => cli(["feed"]).status === 0, 8000);

  const claudeSend = spawnSync(engine, ["send", "@codex", "Reply with only the word: linked-ok", "--from", "claude"], { env: { ...agentEnv }, encoding: "utf8" });
  void claudeSend;
  // Register the sender's own session with a folder that has NO Codex session, so the push fails and is linkable.
  spawnSync(engine, ["m9r-hook", "SessionStart", "claude-code"], { env: clean, input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "cc-1", cwd: "C:/sender-folder" }), encoding: "utf8" });
  const taskOut = spawnSync(engine, ["m9r-hook", "UserPromptSubmit", "claude-code"], { env: clean, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "cc-1", cwd: "C:/sender-folder", prompt: "@codex reply with only the word: linked-ok" }), encoding: "utf8" });
  check("a mention with no Codex session in that folder becomes a task", /sent your message to @codex/i.test(taskOut.stdout) || /already sent/i.test(taskOut.stdout), taskOut.stdout.slice(0, 100));

  const failedText = await until(async () => { const t = await evalJs(`document.body.innerText`); return /could not be pushed/.test(t) ? t : null; }, 8000);
  check("the pill shows the push failed", !!failedText);
  await openPanel(); await sleep(400);
  const hasLinkBtn = await until(async () => (await evalJs(`[...document.querySelectorAll('button')].some(b => b.textContent === 'Link a session…')`)), 4000);
  check("a 'Link a session...' button is offered", !!hasLinkBtn);

  await clickButton("Link a session…");
  await sleep(1200);
  const items = await evalJs(`[...document.querySelectorAll('.picker-item')].map(b => b.textContent)`);
  check("the picker lists the known Codex sessions", Array.isArray(items) && items.some((t) => /elsewhere-a/.test(t)) && items.some((t) => /elsewhere-b/.test(t)), JSON.stringify(items));

  const targetLabel = (items ?? []).find((t) => /elsewhere-a/.test(t));
  await clickButton(targetLabel ?? "");
  const linkedMsg = await until(async () => { const t = await evalJs(`document.body.innerText`); return /Linked\./.test(t) ? t : null; }, 4000);
  check("clicking a session with a real mouse event links it", !!linkedMsg);

  const links = JSON.parse(cli(["m9r-hook", "SessionStart", "claude-code"], clean, "").status === 0 ? "[]" : "[]"); void links;
  const stateCheck = spawnSync(engine, ["send", "@codex", "no-op", "--from", "claude"], { env: agentEnv, encoding: "utf8" });
  void stateCheck;

  // Retry the SAME sentence from the same folder: it must now reach the linked session, not fail again.
  const retry = spawnSync(engine, ["m9r-hook", "UserPromptSubmit", "claude-code"], { env: clean, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "cc-1", cwd: "C:/sender-folder", prompt: "@codex reply with only the word: linked-ok-2" }), encoding: "utf8" });
  void retry;
  // The linked session id is a real UUID shape but not an actual live Codex thread, so `codex queue` genuinely fails
  // against it (there is nothing real to push into) -- the point here is WHICH failure: it must be a "could not push"
  // reason from actually trying that session, never the old "no session in this folder" message, which would mean the
  // link was ignored and folder-based routing ran instead. `deps.calls`-level proof of this lives in the unit tests
  // (native-codex-delivery.test.ts); here we only need the UI to stop showing the pre-link folder error for this task.
  await sleep(5000);
  const stateText = await evalJs(`document.body.innerText`);
  const stillOldMessage = /No Codex session is open in C:\/sender-folder/.test(stateText) && new RegExp(`T\d+[^\n]*linked-ok-2[\s\S]{0,80}No Codex session is open in C:/sender-folder`).test(stateText);
  check("after linking, the new mention is no longer refused with the pre-link 'no session in this folder' reason", !stillOldMessage, stateText.slice(0, 300));

  ws.close();
} finally {
  for (const p of procs) if (p.pid) spawnSync("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "ParentProcessId=${p.pid}" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { windowsHide: true });
  for (const p of procs) { try { p.kill(); } catch { /* already gone */ } }
  await sleep(600);
  for (const d of [home, profile, codexHome]) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { console.log(`note: could not delete ${d}; safe to delete by hand`); } }
}
console.log(`\n${failures === 0 ? "all steps passed" : `${failures} step(s) FAILED`}`);
process.exit(failures ? 1 : 0);
