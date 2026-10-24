import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("engine release uses immutable action commits", () => {
  const workflow = readFileSync(new URL("../.github/workflows/m9r-engine-release.yml", import.meta.url), "utf8");
  const actions = [...workflow.matchAll(/uses:\s*([^\s]+)/g)].map((match) => match[1]);
  assert.equal(actions.length, 3);
  assert.ok(actions.every((action) => /@[a-f0-9]{40}$/.test(action)), actions.join(", "));
  assert.match(workflow, /-RequireSignedExecutables\s+-RequireCleanSource\s+-ExpectedSignerThumbprint/);
});

test("signed package mode checks every M9R executable and rejects invalid publisher signatures", () => {
  const script = readFileSync(new URL("./package-engine-release.ps1", import.meta.url), "utf8");
  assert.match(script, /RequireSignedExecutables/);
  assert.match(script, /RequireCleanSource/);
  assert.match(script, /release-package-manifest\.mjs/);
  assert.match(script, /--verify/);
  assert.match(script, /Get-AuthenticodeSignature/);
  assert.match(script, /Status -ne 'Valid'/);
  assert.match(script, /SignerCertificate\.Thumbprint/);
});

test("published release workflow requires a clean exact source identity", () => {
  const workflow = readFileSync(new URL("../.github/workflows/m9r-engine-release.yml", import.meta.url), "utf8");
  assert.match(workflow, /-RequireSignedExecutables\s+-RequireCleanSource\s+-ExpectedSignerThumbprint/);
});
