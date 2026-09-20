// Live check of the Relay presence lease (manual; takes ~2 minutes; uses the token in .oathlock/agents/codex/local.json).
//   node --disable-warning=ExperimentalWarning scripts/stage1-relay-lease-live.ts
// PASS: a Bridge that stops heartbeating is closed with 4009 after 90-120 s; one that keeps heartbeating, and a socket that never
// heartbeated (like a browser tab), stay connected. It opens 3 short-lived sockets; nothing is written except a heartbeat.
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";

const RELAY = "m9r-relay.m9r.workers.dev";
const WEB = "https://app.m9r.workers.dev";
const token = JSON.parse(readFileSync(".oathlock/agents/codex/local.json", "utf8")).token as string;
const who = await fetch(`${WEB}/api/agent/whoami`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json()) as { workspaceId: string };
const WS_ID = who.workspaceId;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = (type: string, payload: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ version: "oathlock.relay.v1", frameId: "f" + Math.random(), type, workspaceId: WS_ID, correlationId: "c" + Math.random(), causationId: null, idempotencyKey: null, sentAt: new Date().toISOString(), payload, ...extra });

function open(label: string) {
  const ws = new WebSocket(`wss://${RELAY}/`);
  const state = { label, closed: null as null | { code: number; reason: string; atMs: number }, frames: [] as any[], openedAt: Date.now() };
  ws.on("message", (d: any) => state.frames.push(JSON.parse(String(d))));
  ws.on("close", (code: number, reason: any) => { state.closed = { code, reason: String(reason), atMs: Date.now() - state.openedAt }; });
  return { ws, state, opened: new Promise<void>((res, rej) => { ws.on("open", () => res()); ws.on("error", rej); }) };
}
async function authed(label: string) {
  const c = open(label); await c.opened;
  c.ws.send(frame("auth.bridge", { credential: token }));
  for (let i = 0; i < 100 && !c.state.frames.some((f) => f.type === "relay.ready"); i += 1) await sleep(100);
  if (!c.state.frames.some((f) => f.type === "relay.ready")) throw new Error(`${label}: never got relay.ready`);
  return c;
}
const beat = (c: { ws: any }, id: string) => c.ws.send(frame("bridge.heartbeat", { protocolVersion: "oathlock.bridge.v1", bridgeInstanceId: id, activeSessionIds: [] }));

const silent = await authed("silent-bridge");      // heartbeats once, then goes quiet
const steady = await authed("steady-bridge");      // keeps heartbeating every 20 s
const browser = await authed("never-heartbeats");  // like a browser tab: quiet but not a Bridge
beat(silent, "lease-test-silent"); beat(steady, "lease-test-steady");
const t0 = Date.now();
console.log("opened 3 sockets; silent-bridge stops heartbeating now; waiting up to 150 s...");
const timer = setInterval(() => beat(steady, "lease-test-steady"), 20_000);
while (Date.now() - t0 < 150_000 && !silent.state.closed) await sleep(1000);
clearInterval(timer);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => { results.push([name, ok, detail]); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`); };
const s = silent.state.closed;
check("silent bridge is closed with 4009 presence_lease_expired", !!s && s.code === 4009 && s.reason === "presence_lease_expired", JSON.stringify(s));
check("it was closed within one lease plus one sweep (90-120 s)", !!s && s.atMs >= 88_000 && s.atMs <= 125_000, s ? `${Math.round(s.atMs / 1000)}s` : "not closed");
check("the server told it why before closing (presence_lease_expired error frame)", silent.state.frames.some((f) => f.payload?.code === "presence_lease_expired"));
check("a Bridge that keeps heartbeating stays connected", steady.state.closed === null, JSON.stringify(steady.state.closed));
check("a socket that never heartbeated stays connected however quiet", browser.state.closed === null, JSON.stringify(browser.state.closed));
for (const c of [steady, browser]) try { c.ws.close(1000); } catch {}
await sleep(500);
const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
