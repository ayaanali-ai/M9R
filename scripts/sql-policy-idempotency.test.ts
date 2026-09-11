import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = process.cwd();

function sqlFilesIn(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sqlFilesIn(path);
    return path.toLowerCase().endsWith(".sql") ? [path] : [];
  });
}

function policyStatement(
  line: string,
  action: "create" | "drop",
): { name: string; table: string } | null {
  const ifExists = action === "drop" ? String.raw`\s+if\s+exists` : "";
  const match = line.match(
    new RegExp(
      String.raw`^\s*${action}\s+policy${ifExists}\s+("[^"]+"|\S+)\s+on\s+([\w".]+)\s*;?`,
      "i",
    ),
  );
  return match ? { name: match[1], table: match[2].replace(/;$/, "") } : null;
}

function publicTableName(table: string) {
  return table.toLowerCase().startsWith("public.") ? table.toLowerCase() : `public.${table.toLowerCase()}`;
}

const sqlFiles = [
  ...readdirSync(root)
    .filter((entry) => entry.toLowerCase().endsWith(".sql"))
    .map((entry) => resolve(root, entry)),
  ...sqlFilesIn(resolve(root, "supabase", "migrations")),
];

test("every CREATE POLICY is immediately guarded by its matching DROP POLICY IF EXISTS", () => {
  assert.ok(sqlFiles.length > 0, "expected Supabase SQL files");

  for (const path of sqlFiles) {
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const created = policyStatement(lines[index], "create");
      if (!created) continue;

      const dropped = policyStatement(lines[index - 1] ?? "", "drop");
      assert.ok(
        dropped,
        `${relative(root, path)}:${index + 1} must have DROP POLICY IF EXISTS immediately before CREATE POLICY`,
      );
      assert.equal(
        dropped?.name,
        created.name,
        `${relative(root, path)}:${index + 1} must drop the exact policy name`,
      );
      assert.equal(
        publicTableName(dropped?.table ?? ""),
        publicTableName(created.table),
        `${relative(root, path)}:${index + 1} must drop the policy from the same table`,
      );
    }
  }
});

test("waitlist and walkthrough settings policies have explicit idempotency guards", () => {
  const schema = readFileSync(resolve(root, "supabase-schema.sql"), "utf8");
  assert.match(
    schema,
    /DROP POLICY IF EXISTS "Allow anon insert on waitlist_leads" ON public\.waitlist_leads;\s*CREATE POLICY "Allow anon insert on waitlist_leads" ON waitlist_leads/i,
  );
  for (const policy of [
    "Users can read own settings",
    "Users can insert own settings",
    "Users can update own settings",
  ]) {
    assert.match(
      schema,
      new RegExp(
        `DROP POLICY IF EXISTS "${policy}" ON public\\.user_settings;\\s*CREATE POLICY "${policy}" ON user_settings`,
        "i",
      ),
    );
  }
});
