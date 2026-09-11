import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("browser auth client fails closed when Supabase public configuration is missing", async () => {
  const source = await readFile("src/lib/supabase/browser.ts", "utf8");

  assert.match(source, /getSupabasePublicConfig\(\)/);
  assert.match(source, /if \(!config\) return null/);
});

test("server and proxy clients fail closed when public configuration is missing", async () => {
  const serverSource = await readFile("src/lib/supabase/server.ts", "utf8");
  const proxySource = await readFile("src/lib/supabase/proxy.ts", "utf8");
  const configSource = await readFile("src/lib/supabase/config.ts", "utf8");

  assert.match(serverSource, /getSupabasePublicConfig\(\)/);
  assert.match(serverSource, /if \(!config\) return null/);
  assert.match(proxySource, /getSupabasePublicConfig\(\)/);
  assert.match(proxySource, /if \(!config\)\s*\{/);
  assert.match(proxySource, /createLoginRedirect\(request\)/);
  assert.match(configSource, /NEXT_PUBLIC_SUPABASE_URL/);
  assert.match(configSource, /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
  assert.match(configSource, /if \(!url \|\| !publishableKey\)\s*\{\s*return null;/);
});

test("dashboard layout requires a verified Supabase user", async () => {
  const source = await readFile("src/app/dashboard/layout.tsx", "utf8");

  assert.match(source, /supabase\.auth\.getUser\(\)/);
  assert.match(source, /if \(!supabase\) redirect\("\/auth"\)/);
  assert.match(source, /if \(!user\) redirect\("\/auth"\)/);
});

test("signup requests email confirmation through the auth callback", async () => {
  const source = await readFile("src/components/product/AuthForm.tsx", "utf8");

  assert.match(source, /signUp\(/);
  // The confirm callback carries a safe `next` so signup returns to where the
  // human started (e.g. a claim URL) instead of always landing on /dashboard.
  assert.match(
    source,
    /emailRedirectTo:\s*`\$\{window\.location\.origin\}\/auth\/confirm\?next=\$\{encodeURIComponent\(destination\)\}`/,
  );
  assert.match(source, /!result\.data\.session/);
  assert.match(source, /Confirmation sent to/);
});

test("logout clears the Supabase session and leaves the protected workspace", async () => {
  const source = await readFile("src/components/product/ProductShell.tsx", "utf8");

  assert.match(source, /auth\.signOut\(\)/);
  assert.match(source, /router\.replace\("\/"\)/);
  assert.match(source, /router\.refresh\(\)/);
});

test("auth callback exchanges the PKCE code before redirecting to the dashboard", async () => {
  const source = await readFile("src/app/auth/confirm/route.ts", "utf8");

  assert.match(source, /searchParams\.get\("code"\)/);
  assert.match(source, /exchangeCodeForSession\(code\)/);
  assert.match(source, /if \(result\.error\)/);
  assert.match(source, /NextResponse\.redirect\(new URL\(destination, origin\)\)/);
});

test("recreated auth accounts can reuse an email without inheriting stale identity", async () => {
  const migrations = await readdir("supabase/migrations");
  const migration = migrations.find((name) => name.includes("allow_recreated_user_email"));

  assert.ok(migration, "expected a migration for recreated auth-account emails");
  const sql = await readFile(`supabase/migrations/${migration}`, "utf8");

  assert.match(sql, /drop index if exists public\.idx_users_email/i);
  assert.match(sql, /create index[^;]+on public\.users[^;]+lower\(email\)/i);
  assert.doesNotMatch(sql, /create unique index/i);
});
