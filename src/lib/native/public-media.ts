import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

async function readPublic(url: URL, limit: number) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "M9R-Media/1.0 (https://github.com/ayaanali-ai/M9R)" } });
  if (!response.ok || !response.body) throw new Error("Media provider returned HTTP " + response.status);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > limit) throw new Error("Media exceeded download limit");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function fetchPublicMedia(root: string, kind: "photo" | "youtube_thumbnail", input: string) {
  let sourceUrl: string, imageUrl: URL, title: string;
  if (kind === "youtube_thumbnail") {
    const url = new URL(input);
    const id = url.hostname === "youtu.be" ? url.pathname.slice(1) :
      ["youtube.com","www.youtube.com","m.youtube.com"].includes(url.hostname) ?
        (url.pathname === "/watch" ? url.searchParams.get("v") : url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)$/)?.[1]) : null;
    if (!id || !/^[\w-]{11}$/.test(id)) throw new Error("Expected a YouTube video link");
    sourceUrl = "https://www.youtube.com/watch?v=" + id;
    imageUrl = new URL("https://i.ytimg.com/vi/" + id + "/hqdefault.jpg");
    title = "Video thumbnail";
  } else {
    const api = new URL("https://commons.wikimedia.org/w/api.php");
    api.search = new URLSearchParams({ action:"query", format:"json", generator:"search", gsrsearch:input + " filetype:bitmap", gsrnamespace:"6", gsrlimit:"20", prop:"imageinfo", iiprop:"url|mime", iiurlwidth:"600" }).toString();
    type Page = { index: number; title: string; imageinfo?: {mime:string; thumburl?:string; descriptionurl:string}[] };
    const result = JSON.parse((await readPublic(api, 262144)).toString());
    const pages = Object.values(result.query?.pages ?? {}) as Page[];
    const page = pages.sort((a,b)=>a.index-b.index).find(p=>p.imageinfo?.[0]?.mime === "image/jpeg" && /^https:\/\/(?:upload|thumb)\.wikimedia\.org\/wikipedia\/commons\/thumb\//.test(p.imageinfo[0].thumburl ?? ""));
    if (!page) throw new Error("No matching JPEG thumbnail from Wikimedia Commons");
    const info = page.imageinfo![0];
    imageUrl = new URL(info.thumburl!);
    if (!["https://upload.wikimedia.org","https://thumb.wikimedia.org"].includes(imageUrl.origin) || !imageUrl.pathname.includes("/thumb/")) throw new Error("Unexpected Commons thumbnail URL");
    sourceUrl = info.descriptionurl;
    title = page.title;
  }
  const bytes = await readPublic(imageUrl, 2 * 1024 * 1024);
  if (bytes.length < 4 || bytes.readUInt16BE() !== 0xffd8 || bytes.readUInt16BE(bytes.length-2) !== 0xffd9) throw new Error("Provider did not return a JPEG");
  const dir = join(root, "media");
  await mkdir(dir, {recursive:true});
  const imagePath = join(dir, createHash("sha256").update(bytes).digest("hex") + ".jpg");
  await writeFile(imagePath, bytes);
  return { imagePath, title, sourceUrl, bytes:bytes.length };
}
