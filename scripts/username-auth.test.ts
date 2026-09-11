import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeUsername, validateUsername } from "../src/lib/username.ts";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("usernames are normalized and tightly validated", () => {
  assert.equal(normalizeUsername("  Ada_Lovelace  "), "ada_lovelace");
  assert.equal(validateUsername("ada_123").ok, true);
  assert.equal(validateUsername("ab").ok, false);
  assert.equal(validateUsername("admin").ok, false);
  assert.equal(validateUsername("ada-lovelace").ok, false);
});

test("username login is server-side and does not disclose resolved email", () => {
  const route = read("src/app/api/auth/login/route.ts");
  assert.match(route, /signInWithPassword/);
  assert.match(route, /Invalid username, email, or password/);
  assert.doesNotMatch(route, /NextResponse\.json\([^\n]*email/);
  assert.match(route, /rate/i);
});

test("signup collects a username and shows legal notice", () => {
  const form = read("src/components/product/AuthForm.tsx");
  assert.match(form, /Username/);
  assert.match(form, /username/);
  assert.match(form, /\/terms/);
  assert.match(form, /\/privacy/);
});

test("database migration enforces case-insensitive uniqueness", () => {
  const migrations = resolve(root, "supabase/migrations");
  const migration = readdirSync(migrations).find((name) => name.endsWith("_usernames_and_onboarding.sql"));
  assert.ok(migration);
  const file = readFileSync(resolve(migrations, migration), "utf8");
  assert.match(file, /add column if not exists username text/i);
  assert.match(file, /unique index/i);
  assert.match(file, /lower\(username\)/i);
  assert.match(file, /check/i);
  assert.equal(existsSync(migrations), true);
});

test("workspace shell uses username as the visible account identity", () => {
  const shell = read("src/components/product/ProductShell.tsx");
  const layout = read("src/app/dashboard/layout.tsx");
  assert.match(shell, /displayName/);
  assert.match(layout, /username/);
  assert.doesNotMatch(layout, /displayName=.*OathLock user/);
});

test("signed-in users can set or change a unique username in Settings", () => {
  const route = read("src/app/api/account/username/route.ts");
  const settings = read("src/components/product/SettingsView.tsx");
  const page = read("src/app/dashboard/settings/page.tsx");
  assert.match(route, /validateUsername/);
  assert.match(route, /auth\.getUser/);
  assert.match(route, /from\("users"\)/);
  assert.match(route, /USERNAME_TAKEN/);
  assert.match(settings, /Change username|Set username/);
  assert.match(settings, /\/api\/account\/username/);
  assert.match(page, /username/);
});

test("Settings does not advertise API key management", () => {
  const settings = read("src/components/product/SettingsView.tsx");
  assert.doesNotMatch(settings, /ApiKeysSection/);
  assert.doesNotMatch(settings, /api-keys/);
  assert.doesNotMatch(settings, />API keys</);
});

test("username updates fail clearly when the production schema is not migrated", () => {
  const route = read("src/app/api/account/username/route.ts");
  assert.match(route, /USERNAME_SCHEMA_UNAVAILABLE/);
  assert.match(route, /23505/);
  assert.match(route, /That username is already taken/);
});
