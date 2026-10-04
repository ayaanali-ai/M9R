export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PAIR_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const MAX_BODY_BYTES = 64 * 1024;

export class ApiError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = "INVALID_REQUEST") {
    super(message);
    this.name = "ApiError";
  }
}

export function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  const out = new Headers(headers);
  out.set("content-type", "application/json; charset=utf-8");
  out.set("cache-control", "no-store");
  return new Response(JSON.stringify(value), { status, headers: out });
}

export async function readJson(request: Pick<Request, "headers" | "text">): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) throw new ApiError("Request body is too large.", 413, "BODY_TOO_LARGE");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new ApiError("Request body is too large.", 413, "BODY_TOO_LARGE");
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new ApiError("Request body must be valid JSON.", 400, "INVALID_JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("Request body must be a JSON object.", 400, "INVALID_JSON");
  }
  return value as Record<string, unknown>;
}

export function requireString(value: unknown, field: string, min = 1, max = 200): string {
  if (typeof value !== "string") throw new ApiError(`${field} is required.`, 400, `INVALID_${field.toUpperCase()}`);
  const result = value.trim();
  if (result.length < min || result.length > max) {
    throw new ApiError(`${field} must be ${min} to ${max} characters.`, 400, `INVALID_${field.toUpperCase()}`);
  }
  return result;
}

export function normalizeSlug(value: unknown, field: string, max = 38): string {
  const raw = requireString(value, field, 1, 80).toLowerCase();
  const slug = raw.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-").slice(0, max).replace(/-+$/g, "");
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    throw new ApiError(`${field} must contain letters, numbers, and interior hyphens.`, 400, `INVALID_${field.toUpperCase()}`);
  }
  return slug;
}

export function makePairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const digits = Array.from(bytes, (byte) => PAIR_ALPHABET[byte & 31]).join("");
  return `${digits.slice(0, 4)}-${digits.slice(4)}`;
}

export async function hashText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

export async function hmacText(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return toHex(new Uint8Array(signature));
}

export function randomTokenSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64Url(bytes);
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function parseCursor(value: string | null, field: string): number {
  const raw = value ?? "0";
  if (!/^(0|[1-9][0-9]{0,14})$/.test(raw)) throw new ApiError(`${field} must be a non-negative cursor.`, 400, "INVALID_CURSOR");
  const number = Number(raw);
  if (!Number.isSafeInteger(number)) throw new ApiError(`${field} is outside the supported range.`, 400, "INVALID_CURSOR");
  return number;
}

export function parseLimit(value: string | null, fallback = 100): number {
  if (value === null) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError("limit must be between 1 and 200.", 400, "INVALID_LIMIT");
  return limit;
}

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
