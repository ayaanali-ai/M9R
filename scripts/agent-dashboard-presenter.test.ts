/**
 * Agent dashboard presenter + resilient runs read — truthfulness tests
 * ----------------------------------------------------------------------------
 * Proves the dashboard does not make historical/stale test data look like live
 * activity, and that a started run still renders even when the deployed schema is
 * a migration step behind (the Run A "missing run" root cause).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  dedupeConnections,
  connectionLiveness,
  sessionRunLinks,
  sessionLink,
  partitionSessionsByLink,
  partitionRecommendationsByLink,
  linkedSessionIdSet,
  shortId,
  STALE_AFTER_MS,
  isRecentlySeenConnection,
  type ConnectionRow,
} from "../src/lib/agent-dashboard-presenter.ts";
import {
  selectRunsResilient,
  isMissingColumnError,
  CORE_RUN_COLUMNS,
  OPTIONAL_RUN_COLUMNS,
} from "../src/lib/agent-runs-read.ts";

const NOW = Date.parse("2026-06-30T00:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function conn(p: Partial<ConnectionRow>): ConnectionRow {
  return {
    id: Math.random().toString(36).slice(2),
    workspace_id: "workspace-1",
    agent_kind: "claude-code",
    repo_hint: "runleak",
    status: "active",
    created_at: iso(60_000),
    last_seen_at: iso(60_000),
    ...p,
  };
}

// ---------------------------------------------------------------------------
// Connected agents — dedupe + liveness
// ---------------------------------------------------------------------------

test("connected agents are deduped/grouped by workspace + agent kind", () => {
  const conns = [
    conn({ repo_hint: "runleak", last_seen_at: iso(10_000) }),
    conn({ repo_hint: "runleak", last_seen_at: iso(5_000) }), // most recent for runleak
    conn({ repo_hint: "runleak", last_seen_at: iso(99_000) }),
    conn({ workspace_id: "workspace-2", repo_hint: "other-repo", last_seen_at: iso(1_000) }),
  ];
  const { groups, hiddenCount } = dedupeConnections(conns, NOW);
  assert.equal(groups.length, 2, "one card per workspace+kind");
  const runleak = groups.find((g) => g.repo_hint === "runleak")!;
  assert.equal(runleak.total, 3);
  assert.equal(runleak.latest.last_seen_at, iso(5_000), "keeps the most recent in the group");
  assert.equal(hiddenCount, 2, "two older runleak connections hidden");
});

test("callsign dedupe uses workspace and canonical agent kind, not a mutable repo hint", () => {
  const { groups, hiddenCount } = dedupeConnections([
    conn({ workspace_id: "workspace-shared", agent_kind: "codex", repo_hint: "old-repo", last_seen_at: iso(60_000) }),
    conn({ workspace_id: "workspace-shared", agent_kind: "CODEX", repo_hint: "renamed-repo", last_seen_at: iso(1_000) }),
    conn({ workspace_id: "workspace-other", agent_kind: "codex", repo_hint: "renamed-repo", last_seen_at: iso(500) }),
  ], NOW);

  assert.equal(groups.length, 2, "a repo rename must not create a second callsign in the same workspace");
  assert.equal(groups[0].key, "workspace-other||codex");
  const shared = groups.find((group) => group.key === "workspace-shared||codex")!;
  assert.equal(shared.total, 2);
  assert.equal(shared.latest.repo_hint, "renamed-repo", "display metadata still comes from the latest connection");
  assert.equal(hiddenCount, 1);
});

test("Watchfloor mode can preserve distinct same-provider connections", () => {
  const first = conn({ id: "connection-a", agent_kind: "codex" });
  const second = conn({ id: "connection-b", agent_kind: "codex" });
  const { groups, hiddenCount } = dedupeConnections([first, second], NOW, { preserveDistinctConnections: true });
  assert.deepEqual(groups.map((group) => group.latest.id).sort(), ["connection-a", "connection-b"]);
  assert.equal(hiddenCount, 0);
  assert.equal(groups.every((group) => group.total === 1), true);
});

test("dedupe falls back to created_at when last_seen_at is null (most recently created wins)", () => {
  // A repo whose connections were never seen: the most recently CREATED one
  // should represent the group, so a stale never-seen row can't win.
  const conns = [
    conn({ repo_hint: "neverseen", last_seen_at: null, created_at: iso(90_000) }),
    conn({ repo_hint: "neverseen", last_seen_at: null, created_at: iso(20_000) }), // newest creation
    conn({ repo_hint: "neverseen", last_seen_at: null, created_at: iso(60_000) }),
  ];
  const { groups, hiddenCount } = dedupeConnections(conns, NOW);
  assert.equal(groups.length, 1, "one group for the repo");
  assert.equal(groups[0].latest.created_at, iso(20_000), "keeps the most recently created");
  assert.equal(groups[0].liveness, "not_seen", "a never-seen connection is not shown as active");
  assert.equal(hiddenCount, 2, "two older never-seen connections hidden");
});

test("stale and never-seen connections are not shown as active live agents", () => {
  assert.equal(connectionLiveness(null, NOW), "not_seen");
  assert.equal(connectionLiveness(iso(STALE_AFTER_MS + 1000), NOW), "stale");
  assert.equal(connectionLiveness(iso(1000), NOW), "active");

  const { groups } = dedupeConnections(
    [
      conn({ workspace_id: "workspace-fresh", repo_hint: "fresh", last_seen_at: iso(1000) }),
      conn({ workspace_id: "workspace-old", repo_hint: "old", last_seen_at: iso(STALE_AFTER_MS + 5000) }),
      conn({ workspace_id: "workspace-never", repo_hint: "new-never", last_seen_at: null }),
    ],
    NOW,
  );
  const byRepo = Object.fromEntries(groups.map((g) => [g.repo_hint, g.liveness]));
  assert.equal(byRepo.fresh, "active");
  assert.equal(byRepo.old, "stale");
  assert.equal(byRepo["new-never"], "not_seen");
});

test("only recently-seen connections are eligible for live routing", () => {
  assert.equal(isRecentlySeenConnection({ last_seen_at: iso(1_000) }, NOW), true);
  assert.equal(isRecentlySeenConnection({ last_seen_at: iso(STALE_AFTER_MS + 1) }, NOW), false);
  assert.equal(isRecentlySeenConnection({ last_seen_at: null }, NOW), false);
});

// ---------------------------------------------------------------------------
// Sessions — run-linked vs unlinked
// ---------------------------------------------------------------------------

test("recent sessions are classified run-linked vs unlinked", () => {
  const runs = [
    { id: "run-1", latest_session_id: "sess-a" },
    { id: "run-2", latest_session_id: null },
  ];
  const links = sessionRunLinks(runs);
  assert.deepEqual(sessionLink("sess-a", links), { runId: "run-1", linked: true });
  assert.deepEqual(sessionLink("sess-orphan", links), { runId: null, linked: false });
  assert.equal(shortId("4f42addb-105b-4aaa-862e-3e094da14a4c"), "4f42addb");
});

test("session links ignore blank ids and trim padded run session ids", () => {
  const links = sessionRunLinks([
    { id: "run-blank", latest_session_id: "   " },
    { id: "run-live", latest_session_id: " sess-live " },
  ]);

  assert.equal(links.has("   "), false, "blank session ids must not create fake links");
  assert.deepEqual(sessionLink("sess-live", links), { runId: "run-live", linked: true });
});

test("partitionSessionsByLink keeps only run-linked sessions in the main set", () => {
  const runs = [{ id: "run-1", latest_session_id: "sess-live" }];
  const links = sessionRunLinks(runs);
  const sessions = [
    { id: "sess-live", summary: "current run" },
    { id: "sess-old-1", summary: "old test 1" },
    { id: "sess-old-2", summary: "old test 2" },
  ];
  const { linked, unlinked } = partitionSessionsByLink(sessions, links);
  assert.deepEqual(linked.map((s) => s.id), ["sess-live"]);
  assert.deepEqual(unlinked.map((s) => s.id), ["sess-old-1", "sess-old-2"]);
  // Old unlinked sessions must NOT appear in the main (linked) set.
  assert.ok(!linked.some((s) => s.id.startsWith("sess-old")));
});

test("recommendations are split into run-linked vs legacy by source session id", () => {
  const runs = [{ latest_session_id: "sess-live" }, { latest_session_id: null }];
  const linkedIds = linkedSessionIdSet(runs);
  assert.deepEqual([...linkedIds], ["sess-live"]);
  const recs = [
    { id: "rec-live", sourceReportId: "sess-live" }, // from a run-linked session
    { id: "rec-old", sourceReportId: "sess-old" }, // from an unlinked session
    { id: "rec-null", sourceReportId: null }, // legacy with no provenance
  ];
  const { linked, legacy } = partitionRecommendationsByLink(recs, linkedIds);
  assert.deepEqual(linked.map((r) => r.id), ["rec-live"]);
  assert.deepEqual(legacy.map((r) => r.id), ["rec-old", "rec-null"]);
});

// ---------------------------------------------------------------------------
// Current runs render from real agent_runs even when schema is behind
// ---------------------------------------------------------------------------

test("isMissingColumnError recognizes a Postgres undefined-column error", () => {
  assert.equal(isMissingColumnError({ code: "42703" }), true);
  assert.equal(isMissingColumnError({ message: 'column agent_runs.behavior does not exist' }), true);
  assert.equal(isMissingColumnError({ code: "23505", message: "duplicate" }), false);
  assert.equal(isMissingColumnError(null), false);
});

test("a started run still renders when optional columns are missing (Run A fix)", async () => {
  // Simulate the deployed schema lacking rule_health/behavior: the full select
  // errors with 42703, the core select succeeds. The run must still come back.
  const coreRow = {
    id: "4f42addb-105b-4aaa-862e-3e094da14a4c",
    connection_id: "conn-1",
    agent_kind: "claude-code",
    repo_hint: "runleak",
    task_title: "Run A: baseline OathLock product trial",
    status: "completed",
    current_phase: "completed",
    rules_loaded_count: 0,
    latest_session_id: "sess-a",
    started_at: iso(60_000),
    last_seen_at: iso(1000),
    completed_at: iso(1000),
    error_message: null,
  };

  const build = (cols: string) => {
    if (cols.includes("behavior") || cols.includes("rule_health")) {
      return Promise.resolve({ data: null, error: { code: "42703", message: "column agent_runs.behavior does not exist" } });
    }
    return Promise.resolve({ data: [coreRow], error: null });
  };

  const rows = await selectRunsResilient<typeof coreRow & { rule_health: null; behavior: null }>(build);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "4f42addb-105b-4aaa-862e-3e094da14a4c");
  assert.equal(rows[0].task_title, "Run A: baseline OathLock product trial");
  // Optional fields are nulled on fallback, never fabricated.
  assert.equal(rows[0].rule_health, null);
  assert.equal(rows[0].behavior, null);
});

test("the full select is used when optional columns exist", async () => {
  const fullRow = { id: "r1", rule_health: { evaluated: true }, behavior: { retries: 0 } };
  let usedCols = "";
  const build = (cols: string) => {
    usedCols = cols;
    return Promise.resolve({ data: [fullRow], error: null });
  };
  const rows = await selectRunsResilient<{ id: string; rule_health: { evaluated: boolean }; behavior: { retries: number } }>(build);
  assert.ok(usedCols.includes(OPTIONAL_RUN_COLUMNS.split(",")[0].trim()));
  assert.equal(rows[0].rule_health.evaluated, true);
  assert.ok(CORE_RUN_COLUMNS.includes("task_title"));
});
