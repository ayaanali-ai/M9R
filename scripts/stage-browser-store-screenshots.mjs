import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngDimensions(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let offset = 8;
  let width;
  let height;
  let first = true;
  let hasImageData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return null;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) return null;
    if (first) {
      if (type !== "IHDR" || length !== 13) return null;
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      first = false;
    }
    if (type === "IDAT") hasImageData = true;
    if (type === "IEND") return length === 0 && end === bytes.length && hasImageData && width && height ? { width, height } : null;
    offset = end;
  }
  return null;
}

export async function stageScreenshots(sourceDir, destinationDir) {
  const source = path.resolve(sourceDir);
  const destination = path.resolve(destinationDir);
  const files = (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d{2}-[a-z0-9-]+\.png$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (files.length < 1 || files.length > 5) throw new Error("provide one to five manually captured PNG files named NN-description.png");
  await mkdir(destination, { recursive: true });
  const staged = [];
  for (const name of files) {
    const sourcePath = path.join(source, name);
    const bytes = await readFile(sourcePath);
    const dimensions = pngDimensions(bytes);
    if (!dimensions || dimensions.width < 1 || dimensions.height < 1) throw new Error(`${name} is not a valid PNG image`);
    const destPath = path.join(destination, name);
    await copyFile(sourcePath, destPath, fsConstants.COPYFILE_EXCL);
    staged.push({ name, ...dimensions });
  }
  return staged;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) {
    console.error("Usage: node scripts/stage-browser-store-screenshots.mjs <source-folder> <destination-folder>");
    process.exitCode = 2;
  } else {
    try {
      for (const image of await stageScreenshots(process.argv[2], process.argv[3])) console.log(`${image.name}: ${image.width}x${image.height}`);
      console.log("Screenshots were staged, not captured or store-certified.");
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
