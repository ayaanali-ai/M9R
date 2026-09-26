import { createHash, randomBytes } from "node:crypto";

export const ROOM_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export type ParsedRoomInput = { ok: true; value: string } | { ok: false; error: string };

export function parseRoomName(value: unknown): ParsedRoomInput {
  if (typeof value !== "string") return { ok: false, error: "A room name is required." };
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, error: "Room names cannot contain control characters." };
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) return { ok: false, error: "A room name is required." };
  if (name.length > 80) return { ok: false, error: "Room names must be 80 characters or fewer." };
  return { ok: true, value: name };
}

export function parseRoomInviteEmail(value: unknown): ParsedRoomInput {
  if (typeof value !== "string") return { ok: false, error: "A valid invitee email is required." };
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "A valid invitee email is required." };
  }
  return { ok: true, value: email };
}

/** Raw tokens are returned to the owner once; only this digest is persisted. */
export function generateRoomInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashRoomInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
