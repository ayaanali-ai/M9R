import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Room presence and live updates use Supabase Realtime over a WebSocket. A CSP `https://` source does not cover `wss://`,
// so without this entry the browser blocks the socket and the room page sits on "Reconnecting" (found in the live cross-user test).
test("the site's connect-src allows the Supabase Realtime WebSocket", () => {
  const source = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
  const connect = source.split("\n").find((line) => line.includes("connect-src")) ?? "";
  assert.match(connect, /https:\/\/eymtshaxpkmojsggdtkh\.supabase\.co/);
  assert.match(connect, /wss:\/\/eymtshaxpkmojsggdtkh\.supabase\.co/);
});
