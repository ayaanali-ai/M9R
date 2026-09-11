export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_]{2,29}$/;
const RESERVED = new Set([
  "admin", "api", "auth", "billing", "demo", "help", "legal", "oathlock",
  "privacy", "root", "security", "settings", "support", "system", "terms",
]);

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function validateUsername(value: string): { ok: true; username: string } | { ok: false; error: string } {
  const username = normalizeUsername(value);
  if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) {
    return { ok: false, error: "Use 3–30 characters." };
  }
  if (!USERNAME_PATTERN.test(username)) {
    return { ok: false, error: "Use lowercase letters, numbers, and underscores; start with a letter or number." };
  }
  if (RESERVED.has(username)) return { ok: false, error: "That username is reserved." };
  return { ok: true, username };
}
