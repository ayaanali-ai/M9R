import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";

import { standaloneWebBrokerRuntime } from "../src/lib/native/web-broker-runtime.ts";

test("standalone web setup schedules the packaged broker executable, not the unsupported engine web serve path", () => {
  const engineExecutable = "C:/Users/demo/.m9r/bin/m9r-engine.exe";
  const executable = join(dirname(engineExecutable), "m9r-web-broker.exe");
  const plan = standaloneWebBrokerRuntime({
    engineExecutable,
    home: "C:/Users/demo/.m9r",
    port: 47821,
    exists: (path) => path === executable,
  });

  assert.deepEqual(plan, {
    executable,
    args: ["--home", "C:/Users/demo/.m9r", "--port", "47821"],
  });
});

test("standalone web setup refuses to produce a broken service plan without the broker executable", () => {
  assert.throws(
    () => standaloneWebBrokerRuntime({
      engineExecutable: "C:/Users/demo/.m9r/bin/m9r-engine.exe",
      home: "C:/Users/demo/.m9r",
      port: 47821,
      exists: () => false,
    }),
    /standalone M9R Web broker is missing/i,
  );
});
