import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const cli = readFileSync(join(process.cwd(), "src/lib/oathlock-cli-core.ts"), "utf8");
const page = readFileSync(join(process.cwd(), "src/app/dashboard/approvals/page.tsx"), "utf8");
const globalStyles = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

test("bearer run-start approval requests are discoverable without weakening decision authority", () => {
  assert.match(cli, /Human action required: approve this run at/);
  assert.match(cli, /\^\\\/dashboard\\\/approvals\\\/apr_\[a-f0-9\]\{24\}\$/);
  assert.match(page, /\.eq\("workspace_id", workspaceId\)/);
  assert.match(page, /href=\{`\/dashboard\/approvals\/\$\{encodeURIComponent\(request\.id\)\}`\}/);
  assert.doesNotMatch(page, /decision:\s*"approved"/);
});

test("approval routes inherit the shared Geist UI font instead of a browser serif fallback", () => {
  assert.match(globalStyles, /body\s*\{[\s\S]*?font-family:\s*var\(--font-ui\), Arial, Helvetica, sans-serif;/);
  assert.match(globalStyles, /--font-sans:\s*var\(--font-ui\);/);
  assert.doesNotMatch(globalStyles, /body\s*\{[\s\S]*?font-family:\s*var\(--font-sans\), Arial, Helvetica, sans-serif;/);
});
