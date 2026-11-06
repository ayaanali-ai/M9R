// Live smoke test for the current one-pill desktop UI and its screen-glow window.
// Build/run this only with an isolated Tauri application identifier; the production
// single-instance handler intentionally forwards duplicate launches to the live app.
// The harness uses a scratch M9R home and WebView profile, then closes its own process.
//   node overlay/scripts/e2e-live.mjs <isolated-m9r-overlay.exe>
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const exe = process.argv[2];
if (!exe) throw new Error("Pass an isolated Tauri build (unique app identifier); never launch the production identity while it is running.");

const home = join(tmpdir(), `m9r-e2e-${process.pid}`);
const profile = join(tmpdir(), `m9r-e2e-webview-${process.pid}`);
mkdirSync(home, { recursive: true });
mkdirSync(profile, { recursive: true });
const statePath = join(home, "desktop-pill-state.json");
const clean = { ...process.env, M9R_HOME: home };
for (const key of Object.keys(clean)) if (/^(CLAUDECODE|CLAUDE_CODE_|CODEX_)/.test(key)) delete clean[key];
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
async function until(fn, ms = 7000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = await fn();
    if (value) return { value, took: Date.now() - start };
    await sleep(80);
  }
  return { value: null, took: Date.now() - start };
}
async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a WebView2 debugging port.");
  const port = address.port;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}
function writeState(state) {
  writeFileSync(statePath, `${JSON.stringify({ version: 1, surface: "desktop-pill", state })}\n`, "utf8");
}
function makeState({ approval = false, idle = false } = {}) {
  const now = new Date().toISOString();
  return {
    type: "ui-state",
    agents: [
      { id: "claude", provider: "anthropic", folder: "C:/m9r-e2e", state: idle ? "idle" : "working", doing: idle ? "" : "Reviewing lease.ts" },
      { id: "codex", provider: "openai", folder: "C:/m9r-e2e", state: "idle", doing: "" },
      { id: "opencode", provider: "opencode", folder: "C:/m9r-e2e", state: "stopped", doing: "" },
    ],
    thread: [],
    approvals: approval ? [{ id: "T-E2E", agent: "codex", provider: "openai", text: "Publish the reviewed draft", action: "publish the reviewed draft" }] : [],
  };
}
function devtools(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const ready = new Promise((resolveOpen, reject) => {
    ws.addEventListener("open", resolveOpen, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const evaluate = async (expression) => {
    await ready;
    nextId += 1;
    const id = nextId;
    const result = new Promise((resolveResult) => pending.set(id, resolveResult));
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    const message = await result;
    if (message.exceptionDetails) throw new Error(message.exceptionDetails.text ?? "WebView evaluation failed");
    return message.result?.result?.value;
  };
  return { ws, evaluate };
}

let app;
let pill;
let glow;
try {
  const port = await freePort();
  writeState(makeState());
  app = spawn(exe, [], {
    env: {
      ...clean,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      WEBVIEW2_USER_DATA_FOLDER: profile,
    },
    stdio: "ignore",
    windowsHide: true,
  });

  let targets = [];
  const pages = await until(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      if (!response.ok) return null;
      targets = (await response.json()).filter((target) => target.type === "page" && !target.url.startsWith("about:"));
      const byPath = (suffix) => targets.find((target) => {
        try { return new URL(target.url).pathname.toLowerCase().endsWith(suffix); } catch { return false; }
      });
      const pillPage = byPath("/index.html") ?? targets.find((target) => {
        try { return new URL(target.url).pathname === "/"; } catch { return false; }
      });
      const glowPage = byPath("/edge-glow.html");
      return pillPage && glowPage ? { pillPage, glowPage } : null;
    } catch {
      return null;
    }
  }, 20000);
  check("the pill and screen-glow WebViews load", !!pages.value, `${pages.took} ms; targets=${targets.map((target) => target.url).join(", ") || "none"}`);
  if (!pages.value) throw new Error("Isolated overlay did not expose both expected WebView pages.");

  pill = devtools(pages.value.pillPage);
  glow = devtools(pages.value.glowPage);
  const pillReady = await until(async () => {
    const raw = await pill.evaluate(`JSON.stringify({
      root: !!document.querySelector("#root"),
      island: !!document.querySelector("#island"),
      connection: document.querySelector(".broker-status")?.dataset.state ?? "",
      agents: [...document.querySelectorAll(".drum-row")].map((row) => row.textContent.trim()),
      approval: !!document.querySelector(".approval-view.on"),
    })`);
    const dom = JSON.parse(raw ?? "{}");
    return dom.root && dom.island && dom.connection === "connected" && dom.agents.length === 3 ? dom : null;
  }, 10000);
  check("the pill renders the three agents from the broker-owned state envelope", !!pillReady.value, JSON.stringify(pillReady.value ?? {}));

  const statusGlow = await until(async () => {
    const raw = await glow.evaluate(`JSON.stringify((() => { const el = document.querySelector("#screen-glow"); return el && {
      visible: el.classList.contains("visible"),
      rainbow: el.classList.contains("rainbow"),
      live: el.classList.contains("live"),
      color: getComputedStyle(el).getPropertyValue("--glow-color").trim(),
      frame: [document.documentElement.clientWidth, document.documentElement.clientHeight],
    }; })())`);
    const state = JSON.parse(raw ?? "null");
    return state?.visible && !state.rainbow ? state : null;
  }, 5000);
  check("working-agent status reaches the full-screen glow frame", !!statusGlow.value, JSON.stringify(statusGlow.value ?? {}));

  writeState(makeState({ approval: true }));
  const approval = await until(async () => {
    const raw = await pill.evaluate(`JSON.stringify({
      active: !!document.querySelector(".approval-view.on"),
      name: document.querySelector(".approval-view.on .ask-name")?.textContent.trim() ?? "",
      sentence: document.querySelector(".approval-view.on .ask-sentence")?.textContent.trim() ?? "",
    })`);
    const state = JSON.parse(raw ?? "{}");
    return state.active && state.name ? state : null;
  }, 7000);
  check("a new approval opens the approval band for the right agent", !!approval.value && /codex/i.test(approval.value.name) && /publish/i.test(approval.value.sentence), JSON.stringify(approval.value ?? {}));

  const custom = await pill.evaluate(`window.__TAURI_INTERNALS__.invoke("set_screen_glow", {
    visible: true, style: "rainbow", color: "#32A8FF", live: false
  }).then(() => true)`);
  const rainbow = await until(async () => {
    const raw = await glow.evaluate(`JSON.stringify((() => { const el = document.querySelector("#screen-glow"); return el && {
      visible: el.classList.contains("visible"), rainbow: el.classList.contains("rainbow"),
      color: getComputedStyle(el).getPropertyValue("--glow-color").trim().toLowerCase()
    }; })())`);
    const state = JSON.parse(raw ?? "null");
    return state?.visible && state.rainbow && state.color === "#32a8ff" ? state : null;
  }, 4000);
  check("custom rainbow glow color reaches the presentation WebView", custom === true && !!rainbow.value, JSON.stringify(rainbow.value ?? {}));

  await pill.evaluate(`window.__TAURI_INTERNALS__.invoke("set_screen_glow", {
    visible: false, style: "status", color: "#32A8FF", live: false
  }).then(() => true)`);
  const hidden = await until(async () => {
    const raw = await glow.evaluate(`JSON.stringify(document.querySelector("#screen-glow")?.classList.contains("visible") === false)`);
    return raw === "true" ? true : null;
  }, 3000);
  check("the screen glow hides when commanded", !!hidden.value);
} finally {
  try { pill?.ws.close(); } catch { /* closed already */ }
  try { glow?.ws.close(); } catch { /* closed already */ }
  if (app && app.exitCode === null) {
    app.kill();
    await new Promise((resolveExit) => app.once("exit", resolveExit));
  }
  await sleep(500);
  for (const path of [home, profile]) {
    try { rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }); }
    catch { console.log(`note: scratch directory remains: ${path}`); }
  }
}

console.log(`\n${failures === 0 ? "all steps passed" : `${failures} step(s) FAILED`}`);
process.exit(failures ? 1 : 0);
