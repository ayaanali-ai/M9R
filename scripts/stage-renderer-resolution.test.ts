import assert from "node:assert/strict";
import test from "node:test";
import { discoverInstalledWindowExecutable } from "../src/lib/native/windows-installed-apps";
import { stageWindowMatchesApp } from "../src/lib/native/task-stage-apps";

test("launcher renderer matching consumes Windows registration evidence, not executable-name guesses", async () => {
  for (const [launcher, renderer] of [["calc.exe", "CalculatorApp.exe"], ["VendorLauncher.exe", "VendorEditor.exe"]]) {
    const resolved = await discoverInstalledWindowExecutable(`C:\\Apps\\${launcher}`, async (_script, env) => {
      assert.equal(env.M9R_APP_LAUNCHER, `C:\\Apps\\${launcher}`);
      return JSON.stringify([renderer]);
    });
    assert.equal(resolved, renderer);
    const spec = { executable: launcher, args: [], windowExecutable: resolved };
    assert.equal(stageWindowMatchesApp({ pid: 2, windowId: "20", title: "", appName: renderer }, spec), true);
    assert.equal(stageWindowMatchesApp({ pid: 3, windowId: "30", title: renderer, appName: "Unrelated.exe" }, spec), false);
  }
});

test("renderer resolution refuses ambiguity, malformed names and missing evidence", async () => {
  assert.equal(await discoverInstalledWindowExecutable("C:\\Apps\\stub.exe", async () => "[]"), undefined);
  assert.equal(await discoverInstalledWindowExecutable("C:\\Apps\\stub.exe", async () => '["one.exe","two.exe"]'), undefined);
  assert.equal(await discoverInstalledWindowExecutable("C:\\Apps\\stub.exe", async () => '["../bad.exe"]'), undefined);
  await assert.rejects(discoverInstalledWindowExecutable("C:\\Apps\\stub.exe", async () => "not json"));
});
