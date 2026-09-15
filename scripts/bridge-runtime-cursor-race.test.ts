import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("the first-scan staleness check is decided per message against the MESSAGE's own timestamp, not the conversation's", () => {
  // Regression test for a real, confirmed message-loss bug: the check used
  // to run once per conversation, before the per-message loop, comparing the
  // CONVERSATION's created_at against when the bridge started. Nearly every
  // real conversation predates "whenever this bridge instance last started,"
  // so that comparison was true for brand-new messages too -- confirmed
  // live: a message sent to a pre-existing DM minutes after a bridge restart
  // was silently fast-forwarded past, never delivered, no error anywhere.
  // The fix moves the same staleness check inside the per-message loop and
  // compares each message's own created_at instead.
  const src = read("services/mission-bridge/src/bridge-runtime.ts");
  assert.doesNotMatch(
    src,
    /shouldProcessInitialWorkspaceMessages\(conversation\.created_at/,
    "the staleness check must never compare against the conversation's created_at -- that discards brand-new messages in any pre-existing conversation",
  );
  const scanStart = src.indexOf("async function scanWorkspaceMessages");
  const loopStart = src.indexOf("for (const message of messages)", scanStart);
  const loopEnd = src.indexOf("\n      if (messages.length > 0 && !deferred)", loopStart);
  const loopBody = src.slice(loopStart, loopEnd);
  assert.match(
    loopBody,
    /shouldProcessInitialWorkspaceMessages\(message\.created_at, bridgeStartedAtMs\)/,
    "the staleness check must run per message, inside the loop, against that message's own created_at",
  );
});

test("scanWorkspaceMessages reads the workspace cursor before ensureDynamicSessionForConversation, not after", () => {
  // Regression test for a real production bug: when a single message @mentions
  // multiple providers, each bridge's own ensureDynamicSessionForConversation
  // call can take many seconds (real ACP subprocess spawn time). During that
  // window, a DIFFERENT concurrent path (the workspace.event relay handler,
  // triggered by e.g. another mentioned provider's own reply arriving first)
  // can independently advance this bridge's in-memory cursor. If the poll
  // loop re-reads that cursor only AFTER ensureDynamicSessionForConversation
  // resolves, the unrelated advance makes it look like this message was
  // already handled -- so the loop silently abandons a message it had
  // already committed real work to (a live session, already started), with
  // no error and no further log line, forever (the cursor is a durable
  // high-water mark, so the message is never re-offered on a later poll
  // either). The fix: decide staleness synchronously, with nothing async
  // between the cursor read and the skip decision, before ever calling
  // ensureDynamicSessionForConversation.
  const src = read("services/mission-bridge/src/bridge-runtime.ts");
  const scanStart = src.indexOf("async function scanWorkspaceMessages");
  assert.ok(scanStart > -1, "scanWorkspaceMessages not found");
  const loopStart = src.indexOf("for (const message of messages)", scanStart);
  assert.ok(loopStart > -1, "scanWorkspaceMessages' per-message loop not found");
  const loopEnd = src.indexOf("\n      if (messages.length > 0 && !deferred)", loopStart);
  assert.ok(loopEnd > -1, "end of scanWorkspaceMessages' per-message loop not found");
  const loopBody = src.slice(loopStart, loopEnd);

  const cursorReadIndex = loopBody.indexOf("decodeWorkspaceCursor(workspaceMessageCursors.get(conversation.id))");
  const ensureCallIndex = loopBody.indexOf("await ensureDynamicSessionForConversation(conversation.id, missionId,");
  assert.ok(cursorReadIndex > -1, "cursor read not found in the poll loop");
  assert.ok(ensureCallIndex > -1, "ensureDynamicSessionForConversation call not found in the poll loop");
  assert.ok(
    cursorReadIndex < ensureCallIndex,
    "the cursor staleness check must run BEFORE ensureDynamicSessionForConversation's await, " +
      "not after it -- otherwise a concurrent relay event can advance the cursor mid-flight " +
      "and silently strand a message this bridge already started a real session for",
  );

  // Nothing async may separate the read from the skip decision -- an `await`
  // between them would reopen the exact race this test guards against.
  const between = loopBody.slice(cursorReadIndex, ensureCallIndex);
  assert.doesNotMatch(between, /\bawait\b/, "no await may sit between the cursor read and ensureDynamicSessionForConversation");
});

test("the workspace.event relay handler defers until metadata is loaded and checks cursor freshness before ensureDynamicSessionForConversation", () => {
  const src = read("services/mission-bridge/src/bridge-runtime.ts");
  const handlerStart = src.indexOf('if (frame.type !== "workspace.event") return;');
  assert.ok(handlerStart > -1, "workspace.event handler not found");
  const handlerEnd = src.indexOf("\n  }", handlerStart);
  const handlerBody = src.slice(handlerStart, handlerEnd);
  const metadataGuardIndex = handlerBody.indexOf("workspaceConversationCreatedAt.has(frame.channelId)");
  const cursorReadIndex = handlerBody.indexOf("decodeWorkspaceCursor(workspaceMessageCursors.get(frame.channelId))");
  const freshnessGuardIndex = handlerBody.indexOf("cursorIsAfter(current, workspaceMessage)");
  const ensureIndex = handlerBody.indexOf("await ensureDynamicSessionForConversation(frame.channelId!, missionId, workspaceMessage)");
  assert.ok(metadataGuardIndex > -1, "workspace.event must wait for the conversation metadata loaded by the REST scan");
  assert.ok(cursorReadIndex > -1, "workspace.event cursor read not found");
  assert.ok(freshnessGuardIndex > -1, "workspace.event cursor freshness check not found");
  assert.ok(ensureIndex > -1, "ensureDynamicSessionForConversation call not found in workspace.event handler");
  assert.ok(metadataGuardIndex < ensureIndex, "metadata must be loaded before the relay event is routed");
  assert.ok(cursorReadIndex < ensureIndex, "cursor freshness must be decided before async session creation");
  assert.ok(freshnessGuardIndex < ensureIndex, "stale relay events must be skipped before async session creation");
  assert.doesNotMatch(handlerBody.slice(cursorReadIndex, ensureIndex), /\bawait\b/, "no await may sit between the relay cursor read and session creation");
});

test("the workspace-cursor and workspace-scan fetches carry an AbortSignal timeout, so a hung production response can no longer stall a poll cycle forever", () => {
  const src = read("services/mission-bridge/src/bridge-runtime.ts");
  const loadCursorStart = src.indexOf("async function loadWorkspaceCursor");
  const loadCursorEnd = src.indexOf("\n  }", loadCursorStart);
  assert.match(src.slice(loadCursorStart, loadCursorEnd), /signal: AbortSignal\.timeout\(10_000\)/);

  const saveCursorStart = src.indexOf("async function saveWorkspaceCursor");
  const saveCursorEnd = src.indexOf("\n  }", saveCursorStart);
  assert.match(src.slice(saveCursorStart, saveCursorEnd), /signal: AbortSignal\.timeout\(10_000\)/);

  const scanStart = src.indexOf("async function scanWorkspaceMessages");
  const scanEnd = src.indexOf("\n  async function", scanStart + 1);
  const scanBody = src.slice(scanStart, scanEnd);
  const timeoutCount = (scanBody.match(/signal: AbortSignal\.timeout\(10_000\)/g) ?? []).length;
  assert.ok(timeoutCount >= 3, `expected at least 3 timeout-guarded fetches in scanWorkspaceMessages, found ${timeoutCount}`);
});

test("the mission lookup and whoami fetches reachable from the single-flight scan also carry an AbortSignal timeout", () => {
  // Regression test for a real production incident: these two fetches sit on
  // ensureDynamicSessionForConversation's path, which scanWorkspaceMessages
  // awaits directly -- and the scan is single-flight (scheduleWorkspaceScan's
  // workspaceScanInFlight guard). An unbounded hang in either one used to
  // stop that bridge's polling permanently: the poll timer kept firing every
  // 2.5s, but every tick hit the in-flight guard and silently no-op'd,
  // forever, with the process staying alive (its heartbeat is a separate
  // interval) and nothing ever logged, because nothing threw and nothing
  // completed.
  const src = read("services/mission-bridge/src/bridge-runtime.ts");

  const missionLookupIndex = src.indexOf("await fetch(`${appUrl}/api/missions/${encodeURIComponent(missionId)}`");
  assert.ok(missionLookupIndex > -1, "mission lookup fetch not found");
  const missionLookupCallEnd = src.indexOf(");", missionLookupIndex);
  assert.match(src.slice(missionLookupIndex, missionLookupCallEnd), /signal: AbortSignal\.timeout\(10_000\)/);

  const whoamiStart = src.indexOf("async function refreshOwnConnectionId");
  const whoamiEnd = src.indexOf("\n  }", whoamiStart);
  assert.match(src.slice(whoamiStart, whoamiEnd), /signal: AbortSignal\.timeout\(10_000\)/);
});

test("scheduleWorkspaceScan's single-flight latch has a hard deadline, so a future unbounded await elsewhere degrades to a bounded stall instead of killing the poll loop forever", () => {
  const src = read("services/mission-bridge/src/bridge-runtime.ts");
  assert.match(src, /WORKSPACE_SCAN_DEADLINE_MS\s*=\s*120_000/);

  const fnStart = src.indexOf("function scheduleWorkspaceScan()");
  assert.ok(fnStart > -1, "scheduleWorkspaceScan not found");
  const fnEnd = src.indexOf("\n  }", fnStart);
  const fnBody = src.slice(fnStart, fnEnd);

  assert.match(fnBody, /Promise\.race\(\[scan, abandoned\]\)/, "the latch must race the real scan against the deadline, not just await the scan");
  // The abandoned scan settles LATER, after a newer scan has already claimed
  // the latch -- clearing workspaceScanInFlight unconditionally in that case
  // would drop single-flight for the newer scan. Only the current generation
  // may clear it.
  assert.match(fnBody, /if \(workspaceScanInFlight === settled\) workspaceScanInFlight = null;/, "latch release must be generation-guarded");
});

test("a failed workspace-cursor load skips the conversation instead of being treated as a brand-new channel", () => {
  // Regression test for a silent, permanent message-loss path. loadWorkspaceCursor
  // used to mark a conversation "loaded" even when the cursor fetch failed or
  // returned non-ok. The caller then saw no cursor, took the first-scan branch
  // (`if (!cursor && !shouldProcessInitialWorkspaceMessages(...))`) and
  // fast-forwarded the DURABLE high-water mark past every message in the
  // channel -- discarding unprocessed messages forever, with nothing logged.
  // A transient `fetch failed` from a stale pooled keep-alive socket is a
  // confirmed, recurring failure class against production, so this path was
  // reachable in normal operation.
  const src = read("services/mission-bridge/src/bridge-runtime.ts");
  const start = src.indexOf("async function loadWorkspaceCursor");
  assert.ok(start > -1, "loadWorkspaceCursor not found");
  const end = src.indexOf("\n  async function saveWorkspaceCursor", start);
  const body = src.slice(start, end);

  assert.match(body, /Promise<boolean>/, "loadWorkspaceCursor must report whether the cursor was actually loaded");
  assert.doesNotMatch(
    body.slice(0, body.indexOf("workspaceMessageCursors.set")),
    /workspaceCursorLoaded\.add/,
    "a failed cursor load must NOT mark the conversation loaded -- that is what strands the channel's backlog",
  );
  assert.match(
    src,
    /if \(!\(await loadWorkspaceCursor\(conversation\.id\)\)\) continue;/,
    "the poll loop must skip a conversation whose cursor could not be read, not fall through to the first-scan branch",
  );
});

test("a deferred message stops the scan instead of letting the next message carry the cursor past it", () => {
  // Regression test for silent, permanent message loss. When
  // ensureDynamicSessionForConversation returned "deferred", the loop used to
  // `continue`. The NEXT message then reached advanceWorkspaceCursor, and
  // because the durable cursor is a simple high-water mark, that advance moved
  // it past the deferred message too -- so the deferred message was never
  // re-offered on any later scan, with nothing logged.
  const src = read("services/mission-bridge/src/bridge-runtime.ts");

  const scanStart = src.indexOf("async function scanWorkspaceMessages");
  const loopStart = src.indexOf("for (const message of messages)", scanStart);
  const loopEnd = src.indexOf("\n      if (messages.length > 0 && !deferred)", loopStart);
  const loopBody = src.slice(loopStart, loopEnd);
  const pollDeferIndex = loopBody.indexOf("=== \"deferred\") {");
  assert.ok(pollDeferIndex > -1, "the poll loop's deferred branch was not found");
  const pollDeferBranch = loopBody.slice(pollDeferIndex, loopBody.indexOf("\n        }", pollDeferIndex));
  assert.match(pollDeferBranch, /\bbreak;/, "a deferred message must break out of the scan, not continue past it");
  assert.doesNotMatch(pollDeferBranch, /\bcontinue;/);
  assert.match(pollDeferBranch, /console\.warn\(/, "deferring a message must be logged, not silent");

  const relayLoopStart = src.indexOf("for (const value of messages)");
  assert.ok(relayLoopStart > -1, "the relay handler's batch loop was not found");
  const handlerBody = src.slice(relayLoopStart, src.indexOf("if (!deferred && nextCursor)", relayLoopStart));
  const relayDeferIndex = handlerBody.indexOf("=== \"deferred\") {");
  assert.ok(relayDeferIndex > -1, "the relay handler's deferred branch was not found");
  const relayDeferBranch = handlerBody.slice(relayDeferIndex, handlerBody.indexOf("\n          }", relayDeferIndex));
  assert.match(relayDeferBranch, /\bbreak;/, "the relay path has the same high-water-mark cursor and needs the same stop");
  assert.doesNotMatch(relayDeferBranch, /\bcontinue;/);
  assert.match(relayDeferBranch, /console\.warn\(/);
});

test("one failed turn posts exactly one failure notice, not one per queued message in the batch", () => {
  // Regression test for a confirmed incident: a 43-message backlog batched
  // into ONE combined prompt produced ONE provider timeout, but the fallback
  // notice was posted inside `for (const item of batch)`, putting 40 identical
  // "Turn did not complete: ..." messages in the channel within ~50 seconds
  // (40 distinct parent_message_ids in the DB).
  const src = read("services/mission-bridge/src/bridge-runtime.ts");
  const start = src.indexOf("async function runQueuedPrompts");
  assert.ok(start > -1, "runQueuedPrompts not found");
  const end = src.indexOf("\n  async function handleWorkspaceMessage", start);
  const body = src.slice(start, end);

  assert.doesNotMatch(
    body,
    /for \(const item of batch\) \{[^}]*postWorkspaceResult/,
    "the failure notice must not be posted once per batch item -- the batch is one merged prompt with one outcome",
  );
  assert.equal(
    (body.match(/postTurnFallbackOnce\(/g) ?? []).length,
    2,
    "both the not-observed path and the catch path must go through the single-post helper",
  );
  // Anchored to the same parent the combined prompt itself uses.
  assert.match(body, /const anchor = batch\[batch\.length - 1\];/);
  assert.match(body, /postWorkspaceResult\(anchor\.conversationId, anchor\.message\.id,/);
});

test("scanWorkspaceMessages never swallows a failing app response silently", () => {
  // A repeating per-origin network failure or a non-ok status used to be
  // indistinguishable from a healthy idle scan: `if (!response.ok) return;`
  // and `.catch(() => null)` reset the failure streak, logged nothing, wrote
  // no turn-timing rows, and left the process heartbeating normally. Observed
  // live as two bridges going completely silent for minutes with exactly one
  // error line between them.
  const src = read("services/mission-bridge/src/bridge-runtime.ts");
  const start = src.indexOf("async function scanWorkspaceMessages");
  const end = src.indexOf("\n  async function heartbeat", start);
  const body = src.slice(start, end);

  assert.doesNotMatch(body, /if \(!response\.ok\) return;/, "a non-ok conversation list must surface as a scan failure, not a silent success");
  assert.match(body, /throw new Error\(`Workspace conversation list returned \$\{response\.status\}\.`\)/);
  assert.doesNotMatch(body, /\.catch\(\(\) => null\);\n\s*if \(!messagesResponse/, "the message fetch must log its failure reason");
  assert.match(body, /Workspace message fetch failed for/);
  assert.match(body, /Workspace message fetch returned \$\{messagesResponse\.status\}/);
});
