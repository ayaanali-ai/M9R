import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { buildStorePackage, validateStoreManifest } from "./build-browser-store-package.mjs";
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
    assert.equal(archive.readUInt16LE(10), 0, "ZIP timestamps use a timezone-independent midnight");
    assert.equal(archive.readUInt16LE(12), 33, "ZIP entries use the ZIP epoch date");
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
    const { mkdir: makeDir, writeFile: putFile } = await import("node:fs/promises");
    await makeDir(source);
    const sharp = (await import("sharp")).default;
    const screenshot = await sharp({ create: { width: 1280, height: 800, channels: 4, background: "#101318" } }).png().toBuffer();
    await putFile(path.join(source, "01-owner-consent.png"), screenshot);
    const captures = await stageScreenshots(source, destination);
    assert.equal(captures.length, 1);
    assert.deepEqual({ width: captures[0].width, height: captures[0].height }, { width: 1280, height: 800 });
    await assert.rejects(() => stageScreenshots(source, destination), /already exists|file already exists|EEXIST/i);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("screenshot staging rejects valid PNGs that do not match the current store screenshot dimensions", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "m9r-store-shot-size-"));
  try {
    const source = path.join(temp, "source");
    const destination = path.join(temp, "staged");
    const { mkdir: makeDir, writeFile: putFile } = await import("node:fs/promises");
    await makeDir(source);
    const sharp = (await import("sharp")).default;
    const wrongSize = await sharp({ create: { width: 640, height: 400, channels: 4, background: "#101318" } }).png().toBuffer();
    await putFile(path.join(source, "01-too-small.png"), wrongSize);
    await assert.rejects(() => stageScreenshots(source, destination), /1280x800/);
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
    await assert.rejects(() => stageScreenshots(source, destination), /valid 1280x800 PNG screenshot/i);
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

test("store manifest guard rejects broad install permissions, extra APIs, and page-injected scripts", async () => {
  const baseline = JSON.parse(await readFile(new URL("../extensions/browser/store-assets/manifest.template.json", import.meta.url), "utf8"));
  assert.equal(validateStoreManifest(baseline), true);

  for (const mutate of [
    (manifest) => { manifest.permissions.push("cookies"); },
    (manifest) => { manifest.host_permissions.push("https://*/*"); },
    (manifest) => { manifest.content_scripts = [{ matches: ["<all_urls>"], js: ["src/content.js"] }]; },
    (manifest) => { manifest.web_accessible_resources[0].resources.push("src/*.js"); },
    (manifest) => { manifest.externally_connectable = { matches: ["<all_urls>"] }; },
  ]) {
    const changed = structuredClone(baseline);
    mutate(changed);
    assert.throws(() => validateStoreManifest(changed), /store manifest failed review guard/);
  }
});

test("the owner grant UI prominently discloses what may be sent before site consent", async () => {
  const page = await readFile(new URL("../extensions/browser/permission.html", import.meta.url), "utf8");
  assert.match(page, /page text, URLs, and action data/i);
  assert.match(page, /may be sent to the selected agent\/provider and authorized M9R collaborators/i);
  assert.match(page, /No page data is sent merely by granting browser permission/i);
});
