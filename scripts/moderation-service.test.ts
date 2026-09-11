// Moderation actions (ban/unban/mute/unmute/report/resolve) are governance/
// security-relevant, exactly the category audit-log.ts's own docstring says
// must not have its audit failures swallowed -- yet every one of these six
// functions used to wrap its appendAuditLogEntry call in a bare
// `.catch(() => console.error(...))`, so a ban could succeed with zero
// tamper-evident record and nothing but a server log nobody reads. This
// guards against that pattern coming back. No dependency-injection or mock
// harness exists for this module's `supabase` singleton yet, so this
// verifies behavior at the source level, matching the pattern already used
// by scripts/workspace-rules.test.ts for the same class of regression.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(process.cwd(), "src/lib/moderation-service.ts"), "utf8");

test("moderation audit-log calls are never swallowed with .catch -- a failed append must surface, not silently disappear", () => {
  assert.ok(
    !/appendAuditLogEntry\([\s\S]*?\)\)\s*\.catch\(/.test(SRC),
    "no appendAuditLogEntry call in moderation-service.ts may be wrapped in .catch(...) -- ban/mute/report actions are governance-relevant and must not record success with a silently missing audit entry",
  );
});

test("every moderation write path (ban, unban, mute, unmute, report, resolve) appends a matching audit action", () => {
  const expected: Array<[fn: string, action: string]> = [
    ["banTarget", "moderation.banned"],
    ["unbanTarget", "moderation.unbanned"],
    ["muteTarget", "moderation.muted"],
    ["unmuteTarget", "moderation.unmuted"],
    ["reportMessage", "moderation.message_reported"],
    ["setReportStatus", "moderation.report_resolved"],
  ];
  for (const [fn, action] of expected) {
    const start = SRC.indexOf(`export async function ${fn}(`);
    assert.ok(start > -1, `${fn} must exist`);
    const next = SRC.indexOf("\nexport ", start + 1);
    const body = SRC.slice(start, next === -1 ? undefined : next);
    assert.match(body, new RegExp(`action:\\s*"${action.replace(".", "\\.")}"`), `${fn} must record action "${action}"`);
    assert.match(body, /actorKind:\s*"human"/, `${fn}'s audit entry must be attributed to the human moderator, not the system`);
    assert.match(body, /await appendAuditLogEntry\(/, `${fn} must await the audit append (not fire-and-forget)`);
  }
});
