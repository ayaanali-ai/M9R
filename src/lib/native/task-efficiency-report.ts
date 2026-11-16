import { createHash } from "node:crypto";
import { reportedTurnUsage, type ReportedTurnUsage } from "./provider-usage-core";
import { ALL_STAGE_TIMING_PHASES, TOP_LEVEL_STAGE_TIMING_PHASES, type Task } from "./inbox-core";

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
type Interval = [number, number];
const usageKeys = ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens", "totalTokens"] as const;

/** Wall-clock union, not the sum of overlapping agents or nested phases. */
export function intervalUnionMs(intervals: readonly Interval[], from: number, to: number): number {
  const sorted = intervals.map(([start, end]) => [Math.max(from, start), Math.min(to, end)] as Interval)
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end >= start).sort((a, b) => a[0] - b[0]);
  let total = 0, start: number | undefined, end: number | undefined;
  for (const [left, right] of sorted) {
    if (start === undefined || end === undefined) { start = left; end = right; }
    else if (left > end) { total += end - start; start = left; end = right; }
    else end = Math.max(end, right);
  }
  return total + (start !== undefined && end !== undefined ? end - start : 0);
}

export interface EfficiencyReview {
  artifactCorrect: boolean | null;
  ownerInterventions: number | null;
  /** Explicit review evidence, not an agent completion claim. Not copied into report text. */
  evidence: string;
}
export interface EfficiencyRates {
  inputAccounting: "exclusive" | "includes-cache-read";
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheReadUsdPerMillion: number;
  cacheWriteUsdPerMillion: number;
}
export interface EfficiencyReportOptions {
  format: "claude" | "codex";
  from: string;
  to: string;
  tasks?: readonly Task[];
  taskIds?: readonly string[];
  review?: EfficiencyReview;
  rates?: EfficiencyRates;
}

interface ToolCall { name: string; at: number; line: number; fingerprint: string; operation: string | null }
interface ToolResult { at: number; textBytes: number; imageBlocks: number; imageBytes: number; unknownImageBlocks: number; error: boolean | null; truncated: boolean }

/** Offline only. Keeps counters, hashes and correlation, never copies prompts,
 * arguments, screenshots, narrated diagnoses or raw errors into the report. */
export function createTaskEfficiencyReport(options: EfficiencyReportOptions) {
  const from = Date.parse(options.from), to = Date.parse(options.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error("An explicit valid from/to window is required.");
  if (!["claude", "codex"].includes(options.format)) throw new Error("Unsupported transcript format.");
  if (options.tasks && !options.taskIds?.length) throw new Error("Task IDs are required when joining task state.");
  if (options.review !== undefined && (!options.review || typeof options.review.evidence !== "string" || !options.review.evidence.trim()
    || !(options.review.artifactCorrect === null || typeof options.review.artifactCorrect === "boolean")
    || !(options.review.ownerInterventions === null || Number.isSafeInteger(options.review.ownerInterventions) && options.review.ownerInterventions >= 0))) throw new Error("Review requires evidence and explicit nullable outcome/intervention fields.");
  if (options.rates !== undefined && (!options.rates || !["exclusive", "includes-cache-read"].includes(options.rates.inputAccounting)
    || Object.entries(options.rates).some(([key, value]) => key !== "inputAccounting" && number(value) === null)
    || [options.rates.inputUsdPerMillion, options.rates.outputUsdPerMillion, options.rates.cacheReadUsdPerMillion, options.rates.cacheWriteUsdPerMillion].some(value => number(value) === null))) throw new Error("Invalid explicit API rates.");
  const messages = new Map<string, { at: number; line: number; usage: ReportedTurnUsage }>();
  const calls = new Map<string, ToolCall>(), results = new Map<string, ToolResult>();
  const types: Record<string, number> = Object.create(null);
  const codexSnapshots = new Map<string, { at: number; line: number; usage: ReportedTurnUsage }>();
  const compactions: Array<{ line: number; at: string; preTokens: number | null; postTokens: number | null; reportedDurationMs: number | null }> = [];
  let lineCount = 0, malformedLines = 0, missingTimestamp = 0, inWindowRows = 0, anonymousUsageRecords = 0;
  let usageSnapshots = 0, userTextEntries = 0, resultWireBytes = 0, codexSessionStartsInWindow = false;
  let firstRowAt: number | null = null, lastRowAt: number | null = null;

  const addCall = (id: unknown, name: unknown, args: unknown, at: number, line: number) => {
    if (typeof id !== "string" || typeof name !== "string") return;
    if (calls.has(id)) return; // streamed assistant blocks repeat the same tool-use ID
    const safeName = /^[a-zA-Z0-9_.:-]{1,160}$/.test(name) ? name : "unrecognized-tool-name";
    const input = object(args);
    calls.set(id, { name: safeName, at, line, fingerprint: hash([safeName, args]),
      operation: typeof input.operationId === "string" ? hash([input.taskId, input.operationId]) : null });
  };
  const addResult = (id: unknown, content: unknown, at: number, error: unknown) => {
    if (typeof id !== "string" || results.has(id)) return;
    let textBytes = 0, imageBlocks = 0, imageBytes = 0, unknownImageBlocks = 0, truncated = false;
    let status = typeof error === "boolean" ? error : null;
    const visit = (blocks: unknown) => {
      if (typeof blocks === "string") {
        truncated ||= /OUTPUT TRUNCATED|exceeds.*token limit/i.test(blocks);
        try {
          const value = object(JSON.parse(blocks));
          if (typeof value.ok === "boolean") status = !value.ok || status === true;
          if (typeof value.isError === "boolean") status = value.isError || status === true;
          // MCP image content can be nested inside Codex's function result JSON.
          if (Array.isArray(value.content)) {
            textBytes += Buffer.byteLength(JSON.stringify({ ...value, content: undefined }));
            visit(value.content);
            return;
          }
        } catch { /* prose is not a typed success/failure receipt */ }
        textBytes += Buffer.byteLength(blocks);
      } else if (Array.isArray(blocks)) {
        for (const raw of blocks) {
          const block = object(raw);
          if (block.type === "text" && typeof block.text === "string") visit(block.text);
          if (block.type === "image") {
            const data = typeof block.data === "string" ? block.data : object(block.source).data;
            imageBlocks++;
            if (typeof data === "string") imageBytes += Buffer.byteLength(data, "base64");
            else unknownImageBlocks++;
          }
        }
      }
    };
    visit(content);
    resultWireBytes += Buffer.byteLength(JSON.stringify(content) ?? "null");
    results.set(id, { at, textBytes, imageBlocks, imageBytes, unknownImageBlocks, error: status, truncated });
  };

  return {
    addLine(line: string) {
      lineCount++;
      if (!line.trim()) return;
      let row: Json;
      try { row = object(JSON.parse(line)); } catch { malformedLines++; return; }
      const at = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
      if (!Number.isFinite(at)) { missingTimestamp++; return; }
      const inside = at >= from && at <= to;
      if (options.format === "codex" && row.type === "session_meta" && inside) codexSessionStartsInWindow = true;
      const payload = object(row.payload);
      if (options.format === "codex" && row.type === "event_msg" && payload.type === "token_count" && at <= to) {
        const raw = object(object(payload.info).total_token_usage);
        const usage = reportedTurnUsage(raw);
        if (usage) {
          // Do not add last_token_usage: token_count may repeat it. The same
          // cumulative snapshot can also appear in token_usage_record rows.
          const key = String(at); // latest correction at one reported timestamp wins
          codexSnapshots.set(key, { at, line: lineCount, usage });
        }
      }
      if (!inside) return;
      inWindowRows++;
      firstRowAt = firstRowAt === null ? at : Math.min(firstRowAt, at);
      lastRowAt = lastRowAt === null ? at : Math.max(lastRowAt, at);
      const type = typeof row.type === "string" && /^[a-zA-Z0-9_-]{1,60}$/.test(row.type) ? row.type : "unknown";
      types[type] = (types[type] ?? 0) + 1;
      if (options.format === "claude") {
        const message = object(row.message), usage = reportedTurnUsage(message.usage);
        if (usage) {
          usageSnapshots++;
          if (typeof message.id !== "string") anonymousUsageRecords++;
          else {
            const previous = messages.get(message.id);
            if (!previous || at >= previous.at) {
              const merged = { ...usage };
              for (const key of usageKeys) merged[key] ??= previous?.usage[key] ?? null;
              messages.set(message.id, { at, line: lineCount, usage: merged });
            }
          }
        }
        if (Array.isArray(message.content)) for (const raw of message.content) {
          const block = object(raw);
          if (block.type === "tool_use") addCall(block.id, block.name, block.input, at, lineCount);
          if (block.type === "tool_result") addResult(block.tool_use_id, block.content, at, block.is_error);
          if (message.role === "user" && block.type === "text") userTextEntries++;
        }
        if (row.subtype === "compact_boundary") {
          const metadata = object(row.compactMetadata);
          compactions.push({ line: lineCount, at: new Date(at).toISOString(), preTokens: number(metadata.preTokens),
            postTokens: number(metadata.postTokens), reportedDurationMs: number(metadata.durationMs) });
        }
      } else if (row.type === "response_item") {
        if (payload.type === "function_call" || payload.type === "custom_tool_call") {
          let args: unknown = payload.arguments ?? payload.input;
          if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* hash opaque arguments */ } }
          addCall(payload.call_id, payload.name, args, at, lineCount);
        }
        if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") addResult(payload.call_id, payload.output, at, null);
        if (payload.type === "message" && payload.role === "user") userTextEntries++;
      }
    },
    finish() {
      const sums: ReportedTurnUsage = { inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, totalTokens: null };
      const knownSamples: Record<string, number> = {};
      let usageUnits = 0, counterResets = 0, boundarySpanningSamples = 0;
      const accumulate = (usage: ReportedTurnUsage) => {
        usageUnits++;
        for (const key of usageKeys) if (usage[key] !== null) {
          sums[key] = (sums[key] ?? 0) + usage[key]!; knownSamples[key] = (knownSamples[key] ?? 0) + 1;
        }
      };
      if (options.format === "claude") for (const value of messages.values()) accumulate(value.usage);
      else {
        let previous: { at: number; usage: ReportedTurnUsage } | undefined;
        for (const value of [...codexSnapshots.values()].sort((a, b) => a.at - b.at || a.line - b.line)) {
          if (value.at < from) { previous = value; continue; }
          const delta = { ...sums };
          for (const key of usageKeys) delta[key] = null;
          let reset = false;
          for (const key of usageKeys) {
            const before = previous?.usage[key] ?? (codexSessionStartsInWindow ? 0 : null), current = value.usage[key];
            if (before !== null && current !== null) {
              if (current < before) reset = true;
              else delta[key] = current - before;
            }
          }
          if (reset) counterResets++;
          else accumulate(delta);
          if (!previous && !codexSessionStartsInWindow || previous && previous.at < from) boundarySpanningSamples++;
          previous = value;
        }
      }
      const toolIntervals: Interval[] = [], topStageIntervals: Interval[] = [];
      const byTool: Record<string, { calls: number; results: number; failedResults: number; unknownResults: number; textBytes: number; imageBlocks: number; imageDecodedBytes: number | null; unknownImageBlocks: number; waitMs: number }> = Object.create(null);
      const largestResults: Array<{ callLine: number; tool: string; textBytes: number; imageBlocks: number }> = [];
      const operations = new Set<string>();
      const fingerprints = new Set<string>();
      let repeatedOperationIds = 0, repeatedArguments = 0, unpairedCalls = 0, errors = 0, unknownResults = 0, truncations = 0;
      for (const [id, call] of calls) {
        const summary = byTool[call.name] ??= { calls: 0, results: 0, failedResults: 0, unknownResults: 0, textBytes: 0, imageBlocks: 0, imageDecodedBytes: 0, unknownImageBlocks: 0, waitMs: 0 };
        summary.calls++;
        if (fingerprints.has(call.fingerprint)) repeatedArguments++;
        fingerprints.add(call.fingerprint);
        if (call.operation) { if (operations.has(call.operation)) repeatedOperationIds++; operations.add(call.operation); }
        const result = results.get(id);
        if (!result) { unpairedCalls++; continue; }
        summary.results++; summary.textBytes += result.textBytes; summary.imageBlocks += result.imageBlocks;
        summary.unknownImageBlocks += result.unknownImageBlocks;
        summary.imageDecodedBytes = summary.unknownImageBlocks ? null : (summary.imageDecodedBytes ?? 0) + result.imageBytes;
        if (result.error === true) { summary.failedResults++; errors++; }
        if (result.error === null) { summary.unknownResults++; unknownResults++; }
        if (result.truncated) truncations++;
        if (result.at >= call.at) { toolIntervals.push([call.at, result.at]); summary.waitMs += result.at - call.at; }
        largestResults.push({ callLine: call.line, tool: call.name, textBytes: result.textBytes, imageBlocks: result.imageBlocks });
      }
      const phases: Record<string, { events: number; intervalMs: number; recordedDurationMs: number | null; boundaryCrossingEvents: number; errors: number }> = Object.create(null);
      const tasks = options.tasks?.filter(task => options.taskIds?.includes(task.id)) ?? [];
      for (const task of tasks) for (const event of task.stageTiming ?? []) {
        if (!ALL_STAGE_TIMING_PHASES.includes(event.phase)) continue;
        const start = Date.parse(event.startedAt), end = Date.parse(event.endedAt);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end < from || start > to) continue;
        const phase = phases[event.phase] ??= { events: 0, intervalMs: 0, recordedDurationMs: 0, boundaryCrossingEvents: 0, errors: 0 };
        phase.events++; phase.intervalMs += Math.max(0, Math.min(to, end) - Math.max(from, start));
        const duration = number(event.durationMs);
        phase.recordedDurationMs = duration === null || phase.recordedDurationMs === null ? null : phase.recordedDurationMs + duration;
        if (start < from || end > to) phase.boundaryCrossingEvents++;
        if (event.status === "error") phase.errors++;
        if (TOP_LEVEL_STAGE_TIMING_PHASES.includes(event.phase)) topStageIntervals.push([start, end]);
      }
      const accounted = intervalUnionMs([...toolIntervals, ...topStageIntervals], from, to);
      const rate = options.rates;
      const completeForRates = usageUnits > 0 && ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens"].every(key => knownSamples[key] === usageUnits);
      const rawInput = sums.inputTokens;
      const billedInput = rawInput !== null && rate?.inputAccounting === "includes-cache-read" ? rawInput - (sums.cachedInputTokens ?? 0) : rawInput;
      const apiEstimateUsd = rate && completeForRates && billedInput !== null && billedInput >= 0 && !counterResets && !boundarySpanningSamples
        ? (billedInput * rate.inputUsdPerMillion + sums.outputTokens! * rate.outputUsdPerMillion
          + sums.cachedInputTokens! * rate.cacheReadUsdPerMillion + sums.cacheWriteInputTokens! * rate.cacheWriteUsdPerMillion) / 1_000_000 : null;
      return {
        schemaVersion: 1, format: options.format, window: { from: options.from, to: options.to, wallMs: to - from,
          observedTranscriptSpanMs: firstRowAt !== null && lastRowAt !== null ? lastRowAt - firstRowAt : null },
        scope: "One transcript, by timestamp. Selected task IDs constrain state evidence only; timestamps alone do not prove all transcript activity belongs to those tasks.",
        parsing: { lines: lineCount, inWindowRows, malformedLines, missingTimestamp, recordTypes: types },
        usage: { counters: sums, usageUnits, knownSamples, streamedUsageRecords: usageSnapshots, anonymousUsageRecords,
          counterResets, boundarySpanningSamples,
          accounting: options.format === "claude" ? "Latest known fields per message.id; cache fields reported separately. No sum of streaming snapshots."
            : "Differences of cumulative token_count totals; never sum last_token_usage or duplicate token_usage_record rows. Boundary-spanning deltas are not exact window attribution.",
          uniqueContentTokens: null },
        cost: { apiEstimateUsd, configuredRates: rate ?? null, providerReportedUsd: null, subscriptionAllowancePercent: null,
          providerReportedCostSource: "Not collected by this transcript decoder; no missing cost is replaced with zero.",
          note: "Configured API estimates are not subscription bills or allowance consumption. Unknown or boundary-incomplete counters are not priced." },
        tools: { observedCalls: calls.size, observedResults: results.size, unpairedCalls,
          orphanResults: [...results.keys()].filter(id => !calls.has(id)).length, typedFailedResults: errors, unknownResults,
          repeatedArguments, repeatedOperationIds, truncationNotices: truncations, serializedResultBytes: resultWireBytes,
          byTool, largestResults: largestResults.sort((a, b) => b.textBytes - a.textBytes).slice(0, 10),
          note: "Repeated arguments/operation IDs are candidates, not proof of wasted work or retry cause. Tool wait spans include transport and execution; unknown receipts are not success. Observed zero does not prove recording coverage." },
        timing: { toolWaitUnionMs: toolIntervals.length ? intervalUnionMs(toolIntervals, from, to) : null,
          topStageUnionMs: topStageIntervals.length ? intervalUnionMs(topStageIntervals, from, to) : null,
          unattributedWallMs: to - from - accounted, phases, compactions,
          note: "Unattributed time includes thinking, queues, network, idle and missing evidence; it is not measured provider reasoning. Nested phase totals overlap and must not be added to tool wall time. Phase intervalMs is window-clipped; recordedDurationMs retains whole reported events including boundary crossers. Queue waits are not CPU execution time." },
        outcomes: { ownerReview: options.review ? { artifactCorrect: options.review.artifactCorrect, ownerInterventions: options.review.ownerInterventions,
          evidenceDigest: hash(options.review.evidence) } : null,
          artifactCorrect: options.review?.artifactCorrect ?? null, ownerInterventions: options.review?.ownerInterventions ?? null, userTextEntries,
          taskReports: tasks.map(task => ({ taskId: task.id, receipt: task.receipt?.state ?? "unknown", agentReportedCompletion: task.completion?.status ?? null,
            wholeTaskPhaseSummary: task.stageTimingSummary ? Object.fromEntries(Object.entries(task.stageTimingSummary)
              .filter(([phase]) => (ALL_STAGE_TIMING_PHASES as readonly string[]).includes(phase))
              .map(([phase, summary]) => [phase, { count: number(summary?.count), totalDurationMs: number(summary?.totalDurationMs),
                maxDurationMs: number(summary?.maxDurationMs), errorCount: number(summary?.errorCount) }])) : null,
            wholeTaskProviderUsage: task.providerUsage ? { droppedSamples: number(task.providerUsage.droppedSamples),
              samples: task.providerUsage.samples.map(sample => ({ dispatchDigest: hash(sample.dispatchId),
                provider: /^[a-zA-Z0-9_-]{1,80}$/.test(sample.provider) ? sample.provider : "unknown",
                recordedAt: Number.isFinite(Date.parse(sample.recordedAt)) ? new Date(sample.recordedAt).toISOString() : null,
                counters: reportedTurnUsage(sample.counters), providerReportedCostUsd: number(sample.providerReportedCostUsd) })) } : null,
            rawTimingMayBeIncomplete: Boolean(task.stageTimingSummaryMayBeIncomplete || Object.entries(task.stageTimingSummary ?? {}).some(([phase, summary]) =>
              (summary?.count ?? 0) > (task.stageTiming ?? []).filter(event => event.phase === phase).length)) })),
          missingTaskIds: (options.taskIds ?? []).filter(id => !tasks.some(task => task.id === id)),
          note: "Agent completion and narrated explanations do not verify artifact correctness or interventions. Review values are explicitly supplied review evidence, not automatic verification." },
      };
    },
  };
}
