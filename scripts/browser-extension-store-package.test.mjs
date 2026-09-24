import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { buildStorePackage } from "./build-browser-store-package.mjs";
import { stageScreenshots } from "./stage-browser-store-screenshots.mjs";

function zipFiles(bytes) {
  const files = new Map();
  for (let offset = 0; offset + 30 <= bytes.length;) {
    const signature = bytes.readUInt32LE(offset);
    if (signature === 0x04034b50) {
      const size = bytes.readUInt32LE(offset + 18);
      const nameLength = bytes.readUInt16LE(offset + 26);
      const extraLength = bytes.readUInt16LE(offset + 28);
      const nameStart = offset + 30;
      const dataStart = nameStart + nameLength + extraLength;
      const name = bytes.toString("utf8", nameStart, nameStart + nameLength);
      files.set(name, bytes.subarray(dataStart, dataStart + size));
      offset = dataStart + size;
    } else if (signature === 0x02014b50 || signature === 0x06054b50) break;
    else throw new Error(`unexpected ZIP central directory signature at ${offset}`);
  }
  return files;
}

test("store package is reproducible and includes the production manifest, runtime code, provider assets and PNG icons", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "m9r-store-test-"));
  try {
    const output = path.join(temp, "candidate.zip");
    const outputAgain = path.join(temp, "candidate-again.zip");
    const result = await buildStorePackage(output);
    await buildStorePackage(outputAgain);
    const archive = await readFile(output);
    assert.deepEqual(archive, await readFile(outputAgain), "same source files produce byte-identical ZIP archives");
    assert.equal(result.bytes, archive.length);
    const files = zipFiles(archive);
    const names = [...files.keys()];
    assert.ok(names.includes("manifest.json"));
    assert.ok(names.includes("permission.html"));
    assert.ok(names.includes("src/background.js"));
    for (const provider of ["claude", "codex", "opencode"]) assert.ok(names.includes(`assets/providers/${provider}.svg`));
    for (const size of [16, 32, 48, 128]) assert.ok(names.includes(`icons/icon-${size}.png`));
    assert.equal(names.some((name) => name.startsWith("test-page/")), false);
    const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
    assert.equal(manifest.name, "M9R Web Presence");
    assert.equal("content_scripts" in manifest, false);
    assert.equal(manifest.icons[128], "icons/icon-128.png");
    assert.equal(result.files.includes("manifest.json"), true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("screenshot staging accepts a real PNG and refuses overwriting existing captures", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "m9r-store-shots-"));
  try {
    const source = path.join(temp, "source");
    const destination = path.join(temp, "staged");
    const logo = await readFile(new URL("../public/star-logo.png", import.meta.url));
    const { mkdir: makeDir, writeFile: putFile } = await import("node:fs/promises");
    await makeDir(source);
    await putFile(path.join(source, "01-owner-consent.png"), logo);
    const captures = await stageScreenshots(source, destination);
    assert.equal(captures.length, 1);
    assert.ok(captures[0].width > 0 && captures[0].height > 0);
    await assert.rejects(() => stageScreenshots(source, destination), /already exists|file already exists|EEXIST/i);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("screenshot staging rejects truncated or CRC-corrupted PNG data", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "m9r-store-invalid-shot-"));
  try {
    const source = path.join(temp, "source");
    const destination = path.join(temp, "staged");
    const { mkdir: makeDir, writeFile: putFile } = await import("node:fs/promises");
    await makeDir(source);
    const bytes = await readFile(new URL("../public/star-logo.png", import.meta.url));
    const corrupt = Buffer.from(bytes);
    corrupt[corrupt.length - 20] ^= 1;
    await putFile(path.join(source, "01-corrupt.png"), corrupt);
    await assert.rejects(() => stageScreenshots(source, destination), /valid PNG/i);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("store manifest requests no ordinary-site permission at install and injects no static all-sites scripts", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extensions/browser/store-assets/manifest.template.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*", "http://localhost/*"]);
  assert.deepEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"]);
  assert.equal("content_scripts" in manifest, false);
  assert.deepEqual(manifest.permissions, ["tabs", "scripting", "alarms", "storage"]);
  assert.deepEqual(manifest.web_accessible_resources, [{ resources: ["assets/providers/*.svg"], matches: ["http://*/*", "https://*/*"] }]);
  assert.ok(manifest.description.length <= 132);
});
