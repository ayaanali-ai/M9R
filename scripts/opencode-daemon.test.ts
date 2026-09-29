import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createOpenCodeDaemon } from "@/lib/native/opencode-daemon";

test("OpenCode backend starts once, waits for health, reuses its authenticated localhost address, and stops", async () => {
  let starts = 0;
  let killed = 0;
  let healthCalls = 0;
  const argsSeen: string[][] = [];
  const daemon = createOpenCodeDaemon({
    exe: "opencode.exe", cwd: "C:/project", env: { XDG_CONFIG_HOME: "C:/isolated" },
    reservePort: async () => 47123,
    spawn: (_exe, args) => {
      starts += 1;
      argsSeen.push(args);
      const events = new EventEmitter();
      return { on: events.on.bind(events), kill: () => { killed += 1; events.emit("exit", 0); } };
    },
    healthy: async () => { healthCalls += 1; return healthCalls > 1; },
    password: () => "test-secret",
  });
  const [first, second] = await Promise.all([daemon.ready(), daemon.ready()]);
  assert.equal(starts, 1);
  assert.deepEqual(argsSeen[0], ["serve", "--hostname", "127.0.0.1", "--port", "47123"]);
  assert.deepEqual(first, second);
  assert.equal(first.url, "http://127.0.0.1:47123");
  assert.equal(first.password, "test-secret");
  assert.deepEqual(await daemon.ready(), first);
  daemon.close();
  assert.equal(killed, 1);
});
