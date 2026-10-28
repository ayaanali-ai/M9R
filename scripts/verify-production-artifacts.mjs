#!/usr/bin/env node

/**
 * Release gate for browser-facing and deployment output.
 *
 * Server/runtime bundles may contain references to secret environment
 * variables, but they must never contain the corresponding values. Browser
 * and generated deployment assets must contain neither values nor secret
 * names. The gate is dependency-free and safe to run in CI: it never prints
 * matched content.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const clientRoots = [
  ".next/static",
  ".open-next/assets",
  "overlay/dist",
  "pill/dist",
  "cli/dist/extension",
  "extensions/browser/pill-next",
];
const runtimeRoots = ["cli/dist", ".open-next/.build", ".open-next/worker.js"];
const deploymentRoots = [".open-next/cloudflare/next-env.mjs"];

// These are intentionally non-public names. NEXT_PUBLIC_* values are omitted:
// Supabase's URL and publishable key are browser configuration, not credentials.
const serverOnlyNames = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "LEAD_WEBHOOK_URL",
  "SIGNUP_WEBHOOK_URL",
  "SIGNUP_WEBHOOK_SECRET",
  "MISSION_RELAY_TOKEN_SECRET",
  "MISSION_RELAY_BRIDGE_TOKEN",
  "RELAY_INTERNAL_SECRET",
  "MISSION_AGENT_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_WEBHOOK_SECRET",
  "MISSION_GIT_ATTESTATION_SIGNING_KEY",
  "VAPID_PRIVATE_KEY",
  "TYPESAFE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CODEX_API_KEY",
  "CLAUDE_API_KEY",
  "GOOGLE_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "DATABASE_URL",
  "DIRECT_URL",
  "SENTRY_AUTH_TOKEN",
  "NPM_TOKEN",
  "ADMIN_PASSWORD",
  "VERCEL_OIDC_TOKEN",
  "CRON_SECRET",
];
const serverOnlyNameSet = new Set(serverOnlyNames);

// High-confidence token shapes. These patterns require a concrete value, not
// a source-code regex definition (which commonly contains character classes).
const secretPatterns = [
  ["private-key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]{80,}?-----END [A-Z0-9 ]*PRIVATE KEY-----/g],
  ["stripe-secret", /\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g],
  ["github-fine-grained-token", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{20,}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ["database-url", /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"'<>]{8,}/gi],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi],
];

const textExtensions = new Set([".js", ".mjs", ".cjs", ".css", ".html", ".htm", ".json", ".txt", ".xml", ".svg"]);

function walk(root) {
  const files = [];
  if (!existsSync(root)) return files;
  const visit = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : "unknown";
      throw new Error(`cannot read production artifact root (${code}): ${current}`);
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else files.push(full);
    }
  };
  visit(root);
  return files;
}

function parseEnvFile(path) {
  if (!existsSync(path)) return new Map();
  const values = new Map();
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    // dotenv also permits quoted multiline values (notably PEM private keys).
    // Keep accumulating until the closing quote so a full secret cannot evade
    // the exact-value check merely because it spans multiple lines.
    if ((value.startsWith("\"") || value.startsWith("'")) && !value.endsWith(value[0])) {
      const quote = value[0];
      while (index + 1 < lines.length && !value.endsWith(quote)) {
        value += `\n${lines[++index]}`;
      }
    }
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!value || match[1].startsWith("NEXT_PUBLIC_")) continue;
    values.set(match[1], value);
  }
  return values;
}

function scanText(text, envValues, includeServerOnlyNames) {
  const findings = [];
  if (includeServerOnlyNames) {
    for (const name of serverOnlyNames) {
      if (text.includes(name)) findings.push(`server-only name: ${name}`);
    }
  }
  for (const [name, value] of envValues) {
    // Very short values are not reliable evidence and tend to be feature flags.
    if (serverOnlyNameSet.has(name) && value.length >= 8 && text.includes(value)) findings.push(`value from ${name}`);
  }
  for (const [name, pattern] of secretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push(`secret shape: ${name}`);
  }
  return findings;
}

const envPath = process.env.M9R_SECRET_SCAN_ENV_FILE
  ? resolve(repoRoot, process.env.M9R_SECRET_SCAN_ENV_FILE)
  : resolve(repoRoot, ".env.local");
const envValues = parseEnvFile(envPath);
// CI/deployment systems usually inject secrets directly into the process
// environment rather than writing a local env file. Include those values in
// the exact-match check without ever printing them.
for (const name of serverOnlyNames) {
  if (process.env[name]) envValues.set(name, process.env[name]);
}
const roots = (process.env.M9R_ARTIFACT_ROOTS || clientRoots.join(","))
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => resolve(repoRoot, value));

const findings = [];
let scannedFiles = 0;
let existingRoots = 0;

for (const root of roots) {
  if (!existsSync(root)) continue;
  existingRoots += 1;
  for (const file of walk(root)) {
    const extension = extname(file).toLowerCase();
    if (extension === ".map") {
      findings.push(`${file}: source map present in a client artifact root`);
      continue;
    }
    if (!textExtensions.has(extension)) continue;
    scannedFiles += 1;
    const text = readFileSync(file, "utf8");
    for (const finding of scanText(text, envValues, true)) findings.push(`${file}: ${finding}`);
  }
}

// CLI/runtime bundles are not browser artifacts and legitimately contain the
// names of server-only environment variables. Still check them for concrete
// secret values and token-shaped literals.
for (const relativeRoot of runtimeRoots) {
  const root = resolve(repoRoot, relativeRoot);
  if (!existsSync(root)) continue;
  existingRoots += 1;
  const files = statSync(root).isFile() ? [root] : walk(root);
  for (const file of files) {
    const extension = extname(file).toLowerCase();
    if (extension === ".map") {
      findings.push(`${file}: source map present in a runtime artifact root`);
      continue;
    }
    if (!textExtensions.has(extension)) continue;
    scannedFiles += 1;
    const text = readFileSync(file, "utf8");
    for (const finding of scanText(text, envValues, false)) findings.push(`${file}: ${finding}`);
  }
}

// OpenNext's generated env module is a deployment artifact, not a browser
// bundle. It must still contain only public configuration; a previous build
// that loaded .env.local here would otherwise ship live credentials to the
// Worker upload path.
for (const relativeRoot of deploymentRoots) {
  const file = resolve(repoRoot, relativeRoot);
  if (!existsSync(file)) continue;
  existingRoots += 1;
  const extension = extname(file).toLowerCase();
  if (extension === ".map") {
    findings.push(`${file}: source map present in a deployment artifact`);
    continue;
  }
  scannedFiles += 1;
  const text = readFileSync(file, "utf8");
  for (const finding of scanText(text, envValues, true)) findings.push(`${file}: ${finding}`);
}

if (existingRoots === 0) {
  findings.push("no client artifact root exists; build the production artifacts before running this gate");
}

if (findings.length) {
  console.error(`FAIL: production artifact gate found ${findings.length} issue(s) across ${scannedFiles} text asset(s).`);
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`PASS: scanned ${scannedFiles} production asset(s); no source maps, server-only names, or secret values detected.`);
