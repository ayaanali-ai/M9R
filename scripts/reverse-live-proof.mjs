/**
 * Bounded reverse-provider proof requester.
 *
 * The resident profile credential is used only as an Authorization header and
 * is never logged or written. The result artifact contains opaque record IDs
 * and routing state only.
 */
import { readFile, writeFile } from "node:fs/promises";

const [residentPath, outputPath, existingRunArg, requestLabel = "initial"] = process.argv.slice(2);
const existingRunId = existingRunArg && existingRunArg !== "." ? existingRunArg : undefined;
if (!residentPath || !outputPath) throw new Error("resident profile and output paths are required");

const resident = JSON.parse(await readFile(residentPath, "utf8"));
const profile = resident.profiles.find((item) => item.name === "claude-gate11e");
if (!profile?.token) throw new Error("Claude resident profile is unavailable");

const headers = { authorization: `Bearer ${profile.token}`, "content-type": "application/json" };
let runId = existingRunId;
if (!runId) {
  const start = await fetch("https://oathlock.vercel.app/api/agent/run/start", {
    method: "POST",
    headers,
    body: JSON.stringify({
      task_title: "Reverse live proof: Claude awakens Codex",
      repo_hint: "runleak",
      run_mode: "coordinated",
    }),
  });
  const started = await start.json().catch(() => ({}));
  if (!start.ok) throw new Error(`start failed (${start.status})`);
  runId = started.run_id;
}
const request = await fetch(`https://oathlock.vercel.app/api/agent/runs/${runId}/request-help`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    type: "CHECK_REQUESTED",
    need: `Return one read-only acknowledgement (${requestLabel}).`,
    allowed: "Read-only response.",
    not_allowed: "No changes, secrets, or delegation.",
    preferred_provider: "codex",
    repository_binding_id: profile.repositoryBindingId,
    required_capabilities: ["review"],
    allowed_paths: ["docs/proof/"],
    prohibited_paths: ["src/", "supabase/", ".oathlock/"],
    max_duration_ms: 120000,
    max_estimated_tokens: 1000,
  }),
});
const routed = await request.json().catch(() => ({}));
if (!request.ok) throw new Error(`request-help failed (${request.status}): ${routed.error ?? "unknown"}`);

await writeFile(outputPath, JSON.stringify({
  runId,
  requestId: routed.request_id ?? routed.id ?? null,
  routing: routed.routing ?? null,
}), "utf8");
console.log("Claude created the coordinated run and requested bounded Codex assistance.");
