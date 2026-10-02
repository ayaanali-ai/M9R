import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const browserRoot = path.join(repoRoot, "extensions", "browser");
const templatePath = path.join(browserRoot, "store-assets", "manifest.template.json");
const iconSource = path.join(browserRoot, "store-assets", "icon-source.jpg");
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
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

function compareNames(left, right) {
  const a = left.replace(/\\/g, "/");
  const b = right.replace(/\\/g, "/");
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  const stamp = dosTimestamp();
  let offset = 0;
  const sortedEntries = [...entries].sort((a, b) => compareNames(a.name, b.name));
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

export function validateStoreManifest(manifest) {
  const fail = (reason) => { throw new Error(`store manifest failed review guard: ${reason}`); };
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("expected an object");
  if (manifest.manifest_version !== 3) fail("Manifest V3 is required");
  if (typeof manifest.name !== "string" || manifest.name.trim().length === 0 || manifest.name.length > 45) fail("name must be 1-45 characters");
  if (typeof manifest.description !== "string" || manifest.description.trim().length === 0 || manifest.description.length > 132) fail("description must be 1-132 characters");
  if (manifest.content_scripts !== undefined) fail("static content scripts are not allowed in the store build");
  if (manifest.externally_connectable !== undefined) fail("externally_connectable is not part of the store build");
  if (JSON.stringify(manifest.permissions) !== JSON.stringify(["tabs", "scripting", "alarms", "storage", "nativeMessaging", "search"])) fail("permissions must remain the reviewed minimum set");
  if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(["http://*/*", "https://*/*"])) fail("required host access must remain limited to HTTP/HTTPS sites");
  if (manifest.optional_host_permissions !== undefined) fail("site access must not require per-site prompts");
  if (manifest.chrome_url_overrides !== undefined) fail("the store build must not override Chrome's New Tab page");
  // The overlay embeds the thread pill and the message bar as extension frames inside pages (so a page's scripts cannot read what the
  // owner types), which requires exactly those two pages, plus the static provider badges, to be web-accessible. Nothing else may be.
  const war = manifest.web_accessible_resources;
  const expectedResources = ["assets/providers/*.svg", "composer.html", "pill.html"];
  if (!Array.isArray(war) || war.length !== 1
    || JSON.stringify([...(war[0].resources ?? [])].sort()) !== JSON.stringify(expectedResources)
    || JSON.stringify(war[0].matches) !== JSON.stringify(["http://*/*", "https://*/*"])
    || Object.keys(war[0]).some((key) => !["resources", "matches"].includes(key))) {
    // use_dynamic_url is deliberately not allowed: it changes the frames' origin, and the service worker's own-frame check would then refuse every owner command.
    fail("only the pill and message-bar frames and the static provider badge SVGs may be web-accessible");
  }
  if (manifest.background?.service_worker !== "src/background.js") fail("unexpected service worker entry point");
  if (manifest.action?.default_popup !== "permission.html") fail("unexpected action popup");
  return true;
}

/**
 * Every file the package refers to must be in the package: frame pages and their scripts and styles, the service worker's
 * imports, the scripts it injects, the images the styles and overlay load, and the manifest's icons. A store build that
 * silently lacks the pill or message bar is worse than no build, so this throws instead.
 */
export function verifyPackageComplete(files) {
  const names = new Set(files.keys());
  const text = (name) => files.get(name)?.toString("utf8") ?? "";
  const missing = [];
  const need = (from, ref) => {
    const clean = String(ref).split(/[?#]/)[0];
    if (!clean || /^(https?:|data:|chrome-extension:|\/\/)/.test(clean)) return;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), clean));
    if (!names.has(resolved)) missing.push(`${from} -> ${resolved}`);
  };
  const matches = (source, pattern) => [...source.matchAll(pattern)].map((m) => m[1]);
  for (const page of [...names].filter((name) => name.endsWith(".html"))) {
    for (const ref of matches(text(page), /(?:src|href)=["']([^"']+)["']/g)) need(page, ref);
  }
  for (const sheet of [...names].filter((name) => name.endsWith(".css"))) {
    for (const ref of matches(text(sheet), /url\(["']?([^"')]+)["']?\)/g)) need(sheet, ref);
  }
  for (const list of matches(text("src/background.js"), /importScripts\(([^)]*)\)/g)) {
    for (const ref of matches(list, /"([^"]+)"/g)) need("src/background.js", ref);
  }
  for (const script of [...names].filter((name) => name.startsWith("src/") && name.endsWith(".js"))) {
    for (const ref of matches(text(script), /"((?:src|assets)\/[\w.\-/]+\.(?:js|svg|png))"/g)) need("manifest.json", ref);
  }
  const manifest = JSON.parse(text("manifest.json"));
  for (const ref of Object.values(manifest.icons ?? {})) need("manifest.json", ref);
  for (const ref of Object.values(manifest.action?.default_icon ?? {})) need("manifest.json", ref);
  need("manifest.json", manifest.background?.service_worker);
  need("manifest.json", manifest.action?.default_popup);
  for (const entry of manifest.web_accessible_resources ?? []) {
    for (const resource of entry.resources) {
      if (resource.includes("*")) {
        const prefix = resource.slice(0, resource.indexOf("*"));
        if (![...names].some((name) => name.startsWith(prefix))) missing.push(`manifest.json -> ${resource} (matches nothing)`);
      } else need("manifest.json", resource);
    }
  }
  if (missing.length) throw new Error(`store package is missing files it refers to:\n  ${[...new Set(missing)].join("\n  ")}`);
  return true;
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
    validateStoreManifest(template);
    const stage = path.join(tempRoot, "package");
    await mkdir(stage, { recursive: true });
    // The pages and styles the overlay embeds as frames, and the M9R mark their styles mask onto.
    for (const name of ["permission.html", "pill.html", "composer.html", "frame.css"]) {
      await copyFile(path.join(browserRoot, name), path.join(stage, name));
    }
    await mkdir(path.join(stage, "assets"), { recursive: true });
    await copyFile(path.join(browserRoot, "assets", "m9r-mark.png"), path.join(stage, "assets", "m9r-mark.png"));
    for (const name of ["m9r-mark.jpg"]) {
      await copyFile(path.join(browserRoot, "assets", name), path.join(stage, "assets", name));
    }
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
      const icon = await sharp(iconSource).resize(size, size, { fit: "cover" }).png().toBuffer();
      await writeFile(path.join(iconsDir, `icon-${size}.png`), icon, { flag: "wx" });
    }
    template.icons = Object.fromEntries([16, 32, 48, 128].map((size) => [size, `icons/icon-${size}.png`]));
    template.action.default_icon = { 16: "icons/icon-16.png", 32: "icons/icon-32.png" };
    await writeFile(path.join(stage, "manifest.json"), `${JSON.stringify(template, null, 2)}\n`, { flag: "wx" });
    const files = (await walkFiles(stage)).sort((a, b) => compareNames(a.name, b.name));
    verifyPackageComplete(new Map(files.map((file) => [file.name, file.data])));
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
