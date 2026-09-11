import { createHmac, timingSafeEqual } from "node:crypto";

const RELAY_TOKEN_AUDIENCE = "oathlock-mission-relay";
const DEFAULT_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 900;
const MIN_SECRET_LENGTH = 32;

export type MissionRelayTokenKind = "human" | "bridge";

export interface MissionRelayTokenClaims {
  subject: string;
  kind: MissionRelayTokenKind;
  workspaceId: string;
  issuedAt: number;
  expiresAt: number;
}

interface TokenPayload {
  aud: string;
  sub: string;
  kind: MissionRelayTokenKind;
  workspaceId: string;
  iat: number;
  exp: number;
}

function requiredSecret(secret: string | undefined): string {
  if (!secret || secret.length < MIN_SECRET_LENGTH) throw new Error("Mission Relay signing secret is missing or too short.");
  return secret;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sign(input: string, secret: string): string {
  return createHmac("sha256", requiredSecret(secret)).update(input).digest("base64url");
}

export function mintMissionRelayToken(input: {
  subject: string;
  kind: MissionRelayTokenKind;
  workspaceId: string;
  nowSeconds?: number;
  ttlSeconds?: number;
}, secret = process.env.MISSION_RELAY_TOKEN_SECRET): string {
  const signingSecret = requiredSecret(secret);
  const subject = input.subject.trim();
  const workspaceId = input.workspaceId.trim();
  if (!subject || subject.length > 256) throw new Error("Mission Relay token subject is invalid.");
  if (!workspaceId || workspaceId.length > 256) throw new Error("Mission Relay token workspace is invalid.");
  const ttlSeconds = Math.min(Math.max(Math.floor(input.ttlSeconds ?? DEFAULT_TTL_SECONDS), 30), MAX_TTL_SECONDS);
  const issuedAt = Math.floor(input.nowSeconds ?? Date.now() / 1_000);
  const payload: TokenPayload = {
    aud: RELAY_TOKEN_AUDIENCE,
    sub: subject,
    kind: input.kind,
    workspaceId,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
  };
  const header = encode({ alg: "HS256", typ: "OATHLOCK_RELAY" });
  const body = encode(payload);
  const unsigned = `${header}.${body}`;
  return `${unsigned}.${sign(unsigned, signingSecret)}`;
}

export function verifyMissionRelayToken(token: string, secret = process.env.MISSION_RELAY_TOKEN_SECRET, nowSeconds = Math.floor(Date.now() / 1_000)): MissionRelayTokenClaims | null {
  try {
    const signingSecret = requiredSecret(secret);
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts;
    const expected = sign(`${header}.${body}`, signingSecret);
    const actualBytes = Buffer.from(signature, "base64url");
    const expectedBytes = Buffer.from(expected, "base64url");
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null;
    const parsedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { alg?: unknown; typ?: unknown };
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<TokenPayload>;
    if (parsedHeader.alg !== "HS256" || parsedHeader.typ !== "OATHLOCK_RELAY") return null;
    if (payload.aud !== RELAY_TOKEN_AUDIENCE || (payload.kind !== "human" && payload.kind !== "bridge")) return null;
    if (typeof payload.sub !== "string" || !payload.sub || typeof payload.workspaceId !== "string" || !payload.workspaceId) return null;
    if (typeof payload.iat !== "number" || typeof payload.exp !== "number" || payload.exp <= nowSeconds || payload.iat > nowSeconds + 60) return null;
    return {
      subject: payload.sub,
      kind: payload.kind,
      workspaceId: payload.workspaceId,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    };
  } catch {
    return null;
  }
}
