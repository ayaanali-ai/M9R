import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const browserRoot = path.join(repoRoot, "extensions", "browser");
const templatePath = path.join(browserRoot, "store-assets", "manifest.template.json");
const iconSource = path.join(repoRoot, "public", "star-logo.png");
const ZIP_EPOCH = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimestamp(date = ZIP_EPOCH) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  const stamp = dosTimestamp();
  let offset = 0;
  const sortedEntries = [...entries].sort((a, b) => a.name.replace(/\\/g, "/").localeCompare(b.name.replace(/\\/g, "/"), "en"));
  for (const entry of sortedEntries) {
    const name = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

async function walkFiles(root, current = root) {
  const entries = [];
  for (const item of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, item.name);
    if (item.isDirectory()) entries.push(...await walkFiles(root, absolute));
    else if (item.isFile()) entries.push({ name: path.relative(root, absolute).replace(/\\/g, "/"), data: await readFile(absolute) });
  }
  return entries;
}

export async function buildStorePackage(outputPath) {
  const output = path.resolve(outputPath);
  const tempRoot = await mkdtemp(path.join(tmpdir(), "m9r-store-package-"));
  try {
    const template = JSON.parse(await readFile(templatePath, "utf8"));
    if (template.manifest_version !== 3 || template.content_scripts || template.host_permissions.some((host) => !host.includes("127.0.0.1") && !host.includes("localhost"))) {
      throw new Error("store manifest failed the local-only required-host guard");
    }
    const stage = path.join(tempRoot, "package");
    await mkdir(stage, { recursive: true });
    await copyFile(path.join(browserRoot, "permission.html"), path.join(stage, "permission.html"));
    await mkdir(path.join(stage, "src"), { recursive: true });
    for (const entry of await walkFiles(path.join(browserRoot, "src"))) {
      const destination = path.join(stage, "src", entry.name);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, entry.data, { flag: "wx" });
    }
    const providerAssets = path.join(stage, "assets", "providers");
    await mkdir(providerAssets, { recursive: true });
    for (const name of ["claude.svg", "codex.svg", "opencode.svg"]) {
      await copyFile(path.join(browserRoot, "assets", "providers", name), path.join(providerAssets, name));
    }
    const iconsDir = path.join(stage, "icons");
    await mkdir(iconsDir, { recursive: true });
    let sharp;
    try { sharp = (await import("sharp")).default; }
    catch { throw new Error("The store package needs the repository's existing sharp image tooling; no dependency was installed."); }
    for (const size of [16, 32, 48, 128]) {
      const icon = await sharp(iconSource).resize(size, size, { fit: "contain" }).png().toBuffer();
      await writeFile(path.join(iconsDir, `icon-${size}.png`), icon, { flag: "wx" });
    }
    template.icons = Object.fromEntries([16, 32, 48, 128].map((size) => [size, `icons/icon-${size}.png`]));
    template.action.default_icon = { 16: "icons/icon-16.png", 32: "icons/icon-32.png" };
    await writeFile(path.join(stage, "manifest.json"), `${JSON.stringify(template, null, 2)}\n`, { flag: "wx" });
    const files = (await walkFiles(stage)).sort((a, b) => a.name.localeCompare(b.name, "en"));
    const archive = buildZip(files);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, archive, { flag: "wx" });
    return { output, files: files.map((file) => file.name), bytes: archive.length };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputPath = process.argv[2] || path.join(repoRoot, "dist", "m9r-web-presence-store.zip");
  try {
    const result = await buildStorePackage(outputPath);
    console.log(`Created ${result.output} (${result.files.length} files, ${result.bytes} bytes).`);
    console.log("This is a packaging artifact only; it has not been installed, browser-tested, or submitted.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
