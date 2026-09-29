import { createPublicKey, verify } from "node:crypto";

export interface EngineUpdateManifest {
  schema: "m9r-update/1";
  channel: "stable";
  version: string;
  platform: "windows-x64";
  artifact: { url: string; sha256: string; bytes: number };
}

function parseManifest(value: unknown): EngineUpdateManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const artifact = data.artifact;
  if (data.schema !== "m9r-update/1" || data.channel !== "stable" || data.platform !== "windows-x64" ||
      typeof data.version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(data.version) ||
      !artifact || typeof artifact !== "object" || Array.isArray(artifact)) return null;
  const asset = artifact as Record<string, unknown>;
  if (typeof asset.url !== "string" || typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      typeof asset.bytes !== "number" || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > 500_000_000) return null;
  let url: URL;
  try { url = new URL(asset.url); } catch { return null; }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash ||
      url.pathname !== `/ayaanali-ai/M9R/releases/download/m9r-engine-v${data.version}/m9r-engine-windows-x64.zip` ||
      url.href !== asset.url) return null;
  return data as unknown as EngineUpdateManifest;
}

/** Verify the exact published bytes before interpreting any URL or version in the manifest. */
export function verifyUpdateManifest(raw: Buffer, signatureBase64: string, pinnedPublicKeyPem: string):
  | { ok: true; manifest: EngineUpdateManifest }
  | { ok: false; error: string } {
  if (raw.length === 0 || raw.length > 16_384 || !/^[A-Za-z0-9+/]{86}==$/.test(signatureBase64)) return { ok: false, error: "invalid manifest envelope" };
  try {
    const key = createPublicKey(pinnedPublicKeyPem);
    if (key.asymmetricKeyType !== "ed25519" || !verify(null, raw, key, Buffer.from(signatureBase64, "base64"))) return { ok: false, error: "manifest signature is invalid" };
    const manifest = parseManifest(JSON.parse(raw.toString("utf8")) as unknown);
    return manifest ? { ok: true, manifest } : { ok: false, error: "manifest fields or release URL are invalid" };
  } catch { return { ok: false, error: "manifest could not be verified" }; }
}
