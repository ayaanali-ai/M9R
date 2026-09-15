/**
 * Dev tool MCP server — Buzz-parity (crates/buzz-dev-mcp): a curated,
 * OathLock-controlled tool surface handed to every ACP session, instead of
 * agents getting zero tools and silently inheriting whatever their own CLI
 * ships (which was the gap — see acp-stdio-adapter.ts's prior
 * `mcpServers: []`). Standalone stdio entry point, spawned per session by
 * acp-stdio-adapter.ts's devMcpServerDescriptor as its own process (not an
 * in-process import) so a crash in a tool call can't take the whole Bridge
 * down with it. Packaged into the CLI distributable (build-cli.mjs) same as
 * the rest of the ACP/relay tree; devMcpServerDescriptor picks tsx+.ts in
 * the monorepo or plain node+.js in the packaged CLI based on its own
 * import.meta.url extension.
 *
 * Ports 5 of Buzz's 7 tools (read_file, rg, tree, str_replace, todo), plus
 * OathLock-specific tools (`send_message` and the bounded `git_read` reader)
 * — lets the agent post into the same chat channel a human would, so it can
 * bring in another connected agent ("@codex can you review this") or hand
 * off work on its own initiative, instead of every message needing to
 * originate from a human. Before this tool existed, an agent's own session
 * output was never posted back to the channel at all (bridge-runtime.ts's
 * postWorkspaceResult only ever sent a fixed "Turn completed" string) — so
 * proactive agent-to-agent collaboration was structurally impossible, not
 * just unused.
 * `shell` and `view_image` are deliberately not included in this pass:
 * - `shell` is the one place this port intentionally diverges from Buzz's
 *   own posture rather than copying it. Buzz's own paths.rs says plainly:
 *   "No containment enforcement — the resolved path may land anywhere on
 *   the filesystem (consistent with the shell tool's posture)." That's a
 *   reasonable choice for Buzz, which has no governed-scope concept. It is
 *   NOT a reasonable choice for OathLock, whose entire premise is bounded,
 *   evidenced execution — an ungoverned shell tool would let an agent step
 *   outside its Mission assignment's scope while still reporting evidence
 *   as if everything ran inside it. Needs Mission assignment scope
 *   (mission-path-containment.ts) wired through before it can be added
 *   safely, which working session's cwd-only argument doesn't carry today.
 * - `view_image` (1136 lines in Buzz) needs an image-decoding pipeline this
 *   pass doesn't build. Flagged as a real remaining gap, not silently
 *   dropped.
 *
 * Every file tool is bound to the working directory passed at spawn time —
 * unlike Buzz's deliberately unbounded resolve_path, a request for a path
 * outside that root is refused. mission-path-containment.ts is NOT reused
 * here even though it looks like the obvious fit: it canonicalizes
 * repository-RELATIVE scope strings with no filesystem calls at all, and
 * explicitly fails closed on any absolute/drive-letter path — the opposite
 * of what's needed here, where every candidate IS a real absolute
 * filesystem path that must be checked against a real absolute root.
 * containsPath below is the real-filesystem equivalent, kept local rather
 * than force-fitting an abstraction built for a different problem.
 */

import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CHAT_EVIDENCE_SCHEMA_VERSION } from "@/lib/bridge/chat-evidence-schema";
import { TERMINAL_ENABLED } from "@/lib/terminal-config";
import {
  MAX_GIT_READ_LINES,
  readGovernedFile,
  strReplaceGovernedFile,
  listGovernedTree,
  ripgrepSearch,
  gitReadArgs,
  runGitRead,
  todoAction,
  postAgentMessage,
  type TodoItem,
} from "@/lib/bridge/governed-agent-tools";

export interface DevMcpChannelConnection {
  appUrl: string;
  agentToken: string;
  missionId: string;
}

export function createDevMcpServer(workingDirectory: string, channel?: DevMcpChannelConnection): McpServer {
  const root = resolvePath(workingDirectory);
  const todos: TodoItem[] = [];

  const server = new McpServer({ name: "m9r-dev-mcp", version: "1.0.0" });

  server.registerTool(
    "read_file",
    {
      description: "Read a UTF-8 text file in the assigned working directory. Use this when you need to inspect existing code or documentation before making a decision. Paths outside the directory and files over 10MB are refused.",
      inputSchema: { path: z.string().describe("The file to inspect, as an absolute path or a path relative to the working directory.") },
    },
    async ({ path }) => {
      const text = await readGovernedFile(root, path);
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "str_replace",
    {
      description: "Make one precise edit in a file in the assigned working directory. Use this only after reading the file and include enough oldText to identify exactly one intended location.",
      inputSchema: {
        path: z.string(),
        oldText: z.string().describe("The exact existing text to replace; it must occur once, never zero or multiple times."),
        newText: z.string(),
      },
    },
    async ({ path, oldText, newText }) => {
      const text = await strReplaceGovernedFile(root, path, oldText, newText);
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "tree",
    {
      description: "Get your bearings in the assigned working directory. Use this before searching when you do not yet know where the relevant files live; the result is bounded and excludes dependency and Git internals.",
      inputSchema: { path: z.string().default("."), maxDepth: z.number().int().min(1).max(8).default(3) },
    },
    async ({ path, maxDepth }) => {
      const text = await listGovernedTree(root, path, maxDepth);
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "rg",
    {
      description: "Find relevant code or text in the assigned working directory. Prefer this over guessing filenames, then read the strongest matches before acting.",
      inputSchema: {
        pattern: z.string(),
        path: z.string().default("."),
        caseInsensitive: z.boolean().default(false),
        maxMatches: z.number().int().min(1).max(500).default(200),
      },
    },
    async ({ pattern, path, caseInsensitive, maxMatches }) => {
      const text = await ripgrepSearch(root, pattern, path, caseInsensitive, maxMatches);
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "git_read",
    {
      description:
        "Check repository state without changing it. Use this to understand the current branch, recent commits, or local diff before reporting work; " +
        "the allowed operations are status, log, diff_stat, and branch. " +
        "This never invokes a shell and cannot write, push, fetch, checkout, or address a path outside the working directory.",
      inputSchema: {
        operation: z.enum(["status", "log", "diff_stat", "branch"]),
        limit: z.number().int().min(1).max(MAX_GIT_READ_LINES).default(1).describe("Maximum commit count for operation=log; ignored by other operations."),
      },
    },
    async ({ operation, limit }) => {
      const args = gitReadArgs(operation, limit);
      const output = await runGitRead(root, operation, limit);
      return { content: [{ type: "text", text: `git ${args.join(" ")}\n${output}` }] };
    },
  );

  server.registerTool(
    "todo",
    {
      description: "Keep a short checklist for your own active work in this session. Use it to make progress visible and close items when they are actually verified; list, add, or complete only.",
      inputSchema: {
        action: z.enum(["list", "add", "complete"]),
        text: z.string().optional().describe("Required for action=add."),
        id: z.string().optional().describe("Required for action=complete."),
      },
    },
    async ({ action, text, id }) => {
      const result = todoAction(todos, action, text, id);
      return { content: [{ type: "text", text: result }] };
    },
  );

  server.registerTool(
    "send_message",
    {
        description:
        "Say something useful to the people and agents in this Mission's channel. Use this for a real handoff, a direct answer, or a meaningful progress or verification update; " +
        "write it like a concise teammate, not a log line. Mention another provider only when you want that agent to act, and do not post every minor step. " +
        "For an answer or delegated-work report, pass parentMessageId for the triggering message so the result stays in its thread. " +
        "For one-to-one delegated work, use recipientConnectionId from the direct-handoff target list in the prompt. The target @mention is optional for a direct handoff and only helps humans scan the transcript. Mentions without recipientConnectionId intentionally wake every matching agent; use that broadcast behavior only when the whole team should act. " +
        "Threading is handled structurally by parentMessageId alone -- never restate it, a message id, or \"requested by <name>\" inside text itself; the visible message should read as one plain sentence a human teammate would actually type, not an audit trail of its own routing.",
      inputSchema: {
        text: z.string().min(1).max(2_000).describe("The message body (max 2,000 characters), written as plain delegation/report language -- never include a message id or \"requested by\" attribution here, parentMessageId already carries that structurally. Include an @provider-slug for an intentional broadcast; direct handoffs use recipientConnectionId and do not require a mention."),
        parentMessageId: z.string().min(1).max(200).optional().describe("The triggering message id when this is a reply or delegated-work report."),
        recipientConnectionId: z.string().min(1).max(200).optional().describe("Optional direct recipient connection id for a deliberate one-to-one handoff."),
      },
    },
    async ({ text, parentMessageId, recipientConnectionId }) => {
      if (!channel) throw new Error("send_message is not available in this session (no channel connection was provided).");
      const result = await postAgentMessage(channel, { text, parentMessageId, recipientConnectionId });
      return { content: [{ type: "text", text: result }] };
    },
  );

  server.registerTool(
    "search_memory",
    {
      description:
        "Look through this workspace's archived sessions before starting unfamiliar work. This is shared memory across providers, so use it to recover decisions, prior fixes, and useful context instead of asking people to repeat themselves. " +
        "The result includes short transcript excerpts with speakers, channel, agent, and archive time. Leave query empty for recent archived work.",
      inputSchema: {
        query: z.string().max(160).default("").describe("Keywords to search past session titles/messages for. Empty returns the most recently archived sessions."),
        limit: z.number().int().min(1).max(25).default(8).describe("Maximum number of past sessions to return."),
      },
    },
    async ({ query, limit }) => {
      if (!channel) throw new Error("search_memory is not available in this session (no channel connection was provided).");
      const params = new URLSearchParams({ q: query, limit: String(limit) });
      const response = await fetch(`${channel.appUrl.replace(/\/$/, "")}/api/agent/memory/search?${params.toString()}`, {
        headers: { authorization: `Bearer ${channel.agentToken}` },
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Could not search past sessions (HTTP ${response.status}): ${detail.slice(0, 300)}`);
      }
      const body = (await response.json()) as { matches?: Array<{ title: string; ownerLabel: string; conversationTopic: string; archivedAtMs: number | null; transcript: Array<{ sender: string; body: string }> }> };
      const matches = body.matches ?? [];
      if (matches.length === 0) return { content: [{ type: "text", text: "No past sessions matched." }] };
      const rendered = matches.map((match) => {
        const when = match.archivedAtMs ? new Date(match.archivedAtMs).toISOString() : "unknown time";
        const excerpt = match.transcript.map((line) => `  ${line.sender}: ${line.body}`).join("\n") || "  (no transcript captured)";
        return `## ${match.title}\nOwner: ${match.ownerLabel} · Channel: #${match.conversationTopic} · Archived: ${when}\n${excerpt}`;
      }).join("\n\n");
      return { content: [{ type: "text", text: rendered }] };
    },
  );

  server.registerTool(
    "draft_section",
    {
      description:
        "Write or revise one named section of a shared draft document in this channel. Use it when the team is building a spec, PR description, or other narrative artifact together; " +
        "keep raw code and diffs in the repository. " +
        "agents and the human build together over time: a PR description, a spec, a shared writeup. This is NOT for raw code or diffs -- those " +
        "belong in the repo itself, not this document. Sections are found by heading (case-insensitive): writing the same heading again revises " +
        "it in place and you become its new attributed author, so only reuse a heading you actually mean to rewrite. A new draftTitle creates a " +
        "new document; reuse an existing one to keep adding sections to the same draft. Once a human marks a draft ready it stops accepting " +
        "writes -- start a new draft if more work is needed after that.",
      inputSchema: {
        draftTitle: z.string().min(1).max(200).describe("The document's title. Reuse an existing draft's title to add to it; a new title starts a new draft."),
        heading: z.string().min(1).max(120).describe("This section's heading, e.g. \"Summary\" or \"Rollout plan\". Reusing a heading revises that section."),
        body: z.string().min(1).max(8_000).describe("The section's content -- real prose, not a code dump or a diff."),
      },
    },
    async ({ draftTitle, heading, body }) => {
      if (!channel) throw new Error("draft_section is not available in this session (no channel connection was provided).");
      const conversationId = channel.missionId.startsWith("channel-") ? channel.missionId.slice("channel-".length) : null;
      if (!conversationId) throw new Error("This Mission isn't bound to a chat channel, so there's nowhere to write this draft.");
      const response = await fetch(`${channel.appUrl.replace(/\/$/, "")}/api/agent/conversations/${encodeURIComponent(conversationId)}/drafts`, {
        method: "POST",
        headers: { authorization: `Bearer ${channel.agentToken}`, "content-type": "application/json" },
        body: JSON.stringify({ draftTitle, heading, body }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Could not write the draft section (HTTP ${response.status}): ${detail.slice(0, 300)}`);
      }
      return { content: [{ type: "text", text: `Wrote "${heading}" in "${draftTitle}". Visible to the human and every other connected agent in this channel's Drafts panel.` }] };
    },
  );

  server.registerTool(
    "request_evidence_review",
    {
      description:
        "Ask the human to review your completed work before you submit structured evidence. Summarize what changed in plain language; this creates no evidence record, and you must wait for explicit approval.",
      inputSchema: { summary: z.string().min(1).max(500).describe("A concise description of the completed work that the human is being asked to review.") },
    },
    async ({ summary }) => {
      if (!channel) throw new Error("request_evidence_review is not available in this session (no channel connection was provided).");
      const conversationId = channel.missionId.startsWith("channel-") ? channel.missionId.slice("channel-".length) : null;
      if (!conversationId) throw new Error("This Mission isn't bound to a chat channel, so there's nowhere to request evidence review.");
      const response = await fetch(`${channel.appUrl.replace(/\/$/, "")}/api/agent/conversations/${encodeURIComponent(conversationId)}/evidence/requests`, {
        method: "POST",
        headers: { authorization: `Bearer ${channel.agentToken}`, "content-type": "application/json" },
        body: JSON.stringify({ summary }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Could not request evidence review (HTTP ${response.status}): ${detail.slice(0, 300)}`);
      }
      const body = await response.json().catch(() => ({})) as { id?: string };
      return { content: [{ type: "text", text: `Evidence review requested. Wait for explicit human approval, then call submit_evidence with requestId ${body.id ?? "returned-by-the-server"}.` }] };
    },
  );

  server.registerTool(
    "submit_evidence",
    {
      description:
        "Submit concrete, structured facts after the matching evidence request was approved in-channel. Include what changed, relevant paths or links, and observed verification results; do not turn this into a vague completion claim.",
      inputSchema: {
        requestId: z.string().min(1).describe("The request id returned by request_evidence_review."),
        evidence: z.object({
          schemaVersion: z.literal(CHAT_EVIDENCE_SCHEMA_VERSION),
          summary: z.string().min(1).max(500),
          work: z.array(z.string().min(1).max(1_000)).min(1).max(16),
          files: z.array(z.string().min(1).max(500)).max(32),
          verification: z.array(z.object({ command: z.string().min(1).max(500), result: z.string().min(1).max(1_000) })).min(1).max(16),
          limitations: z.array(z.string().min(1).max(1_000)).max(16),
        }).strict().describe("Structured evidence facts: what changed, which paths or links support it, and the observed verification output."),
      },
    },
    async ({ requestId, evidence }) => {
      if (!channel) throw new Error("submit_evidence is not available in this session (no channel connection was provided).");
      const conversationId = channel.missionId.startsWith("channel-") ? channel.missionId.slice("channel-".length) : null;
      if (!conversationId) throw new Error("This Mission isn't bound to a chat channel, so there's nowhere to submit this evidence.");
      const response = await fetch(`${channel.appUrl.replace(/\/$/, "")}/api/agent/conversations/${encodeURIComponent(conversationId)}/evidence`, {
        method: "POST",
        headers: { authorization: `Bearer ${channel.agentToken}`, "content-type": "application/json" },
        body: JSON.stringify({ requestId, evidence }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Could not submit evidence (HTTP ${response.status}): ${detail.slice(0, 300)}`);
      }
      return { content: [{ type: "text", text: "Structured evidence submitted for final human review in the channel." }] };
    },
  );

  server.registerTool(
    "submit_task_split",
    {
      description:
        "Propose how a multi-agent request should be split, when you were the first agent mentioned and the system told you a task contract is waiting on your decomposition. " +
        "Break the request into one item per agent (including yourself if you're doing part of it), each with its own assignedConnectionId from the direct-handoff target list in your prompt. " +
        "Every other mentioned agent stays blocked until you call this -- do not restate the split in a chat message instead of calling this tool, that leaves the contract stuck open with nothing dispatched. " +
        "Call this once per contract; it cannot be edited afterward, only individual items can be reassigned by a human.",
      inputSchema: {
        conversationId: z.string().min(1).max(200).optional().describe("Defaults to this session's own channel; only pass this to target a different conversation."),
        anchorMessageId: z.string().min(1).max(200).optional().describe("The message id that triggered this split, if you have it. Not required."),
        items: z.array(z.object({
          description: z.string().min(1).max(2_000).describe("What this piece of work is, written for the assigned agent to act on directly."),
          expectedFilePaths: z.array(z.string().min(1).max(500)).max(50).optional().describe("Paths this item is expected to touch, if known."),
          assignedConnectionId: z.string().min(1).max(200).describe("The connection id from your prompt's direct-handoff target list -- who does this piece."),
        })).min(1).max(16).describe("One entry per piece of work. Every mentioned agent needs at least one item or it never gets woken."),
      },
    },
    async ({ conversationId, anchorMessageId, items }) => {
      if (!channel) throw new Error("submit_task_split is not available in this session (no channel connection was provided).");
      const resolvedConversationId = conversationId
        ?? (channel.missionId.startsWith("channel-") ? channel.missionId.slice("channel-".length) : null);
      if (!resolvedConversationId) throw new Error("This Mission isn't bound to a chat channel, so there's no conversation to split work in.");
      const response = await fetch(`${channel.appUrl.replace(/\/$/, "")}/api/bridge/task-contracts`, {
        method: "POST",
        headers: { authorization: `Bearer ${channel.agentToken}`, "content-type": "application/json" },
        body: JSON.stringify({ conversationId: resolvedConversationId, anchorMessageId, items }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Could not submit the task split (HTTP ${response.status}): ${detail.slice(0, 300)}`);
      }
      const body = await response.json().catch(() => ({})) as { dispatched?: number };
      return { content: [{ type: "text", text: `Split submitted: ${items.length} item(s), ${body.dispatched ?? 0} agent(s) woken with their own piece.` }] };
    },
  );

  server.registerTool(
    "update_task_item_status",
    {
      description:
        "Report progress or completion on a task-contract item assigned to you (from a 'Your part of this task' dispatch notice, which includes the itemId to use here). " +
        "Call this with status 'in_progress' when you start and 'done' or 'failed' when you finish -- the contract will not close and the human will not see completion until every assigned item reports in. " +
        "Only works for an item currently assigned to your own connection.",
      inputSchema: {
        itemId: z.string().min(1).max(200).describe("The task_contract_items id from your dispatch notice."),
        status: z.enum(["in_progress", "done", "failed"]),
        resultMessageId: z.string().min(1).max(200).optional().describe("Optional: the id of a send_message you posted summarizing the result, linked for the human's review."),
      },
    },
    async ({ itemId, status, resultMessageId }) => {
      if (!channel) throw new Error("update_task_item_status is not available in this session (no channel connection was provided).");
      const response = await fetch(`${channel.appUrl.replace(/\/$/, "")}/api/bridge/task-contracts/${encodeURIComponent(itemId)}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${channel.agentToken}`, "content-type": "application/json" },
        body: JSON.stringify({ status, resultMessageId }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Could not update that task item (HTTP ${response.status}): ${detail.slice(0, 300)}`);
      }
      return { content: [{ type: "text", text: `Item marked ${status}.` }] };
    },
  );

  server.registerTool(
    "list_my_task_items",
    {
      description:
        "List your own active (pending or in-progress) task-contract items across every open contract in this workspace. " +
        "Use this if you've lost track of an itemId from an earlier dispatch notice, or to check whether you have outstanding split work before ending your turn.",
      inputSchema: {},
    },
    async () => {
      if (!channel) throw new Error("list_my_task_items is not available in this session (no channel connection was provided).");
      const response = await fetch(`${channel.appUrl.replace(/\/$/, "")}/api/bridge/task-contracts`, {
        headers: { authorization: `Bearer ${channel.agentToken}` },
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Could not list your task items (HTTP ${response.status}): ${detail.slice(0, 300)}`);
      }
      const body = await response.json().catch(() => ({})) as { items?: Array<{ id: string; description: string; status: string }> };
      const items = body.items ?? [];
      if (items.length === 0) return { content: [{ type: "text", text: "No active task-contract items assigned to you right now." }] };
      const rendered = items.map((item) => `- ${item.id} [${item.status}]: ${item.description}`).join("\n");
      return { content: [{ type: "text", text: rendered }] };
    },
  );

  server.registerTool(
    "request_assignment_change",
    {
      description:
        "Tell the human that your current task-contract item needs a different assignment. Use this when the scope, dependency, capability, or ownership is wrong; explain the situation in one plain sentence. " +
        "This only flags the item and blocks your work. You cannot reassign or resolve it yourself, and it works only for an item currently assigned to you.",
      inputSchema: {
        itemId: z.string().min(1).max(200).describe("The task_contract_items id currently assigned to you."),
        reason: z.enum(["wrong_scope", "blocked_by_dependency", "outside_capability", "already_done_by_other", "needs_split"])
          .describe("Closed reason code -- this is the only machine-read field, so the human sees a real scannable card instead of parsing prose."),
        detail: z.string().min(1).max(600).describe("One plain sentence of context for the human. Display-only, never parsed."),
        suggestedConnectionId: z.string().optional().describe("Optional hint for who might be better suited -- the human may ignore it entirely."),
      },
    },
    async ({ itemId, reason, detail, suggestedConnectionId }) => {
      if (!channel) throw new Error("request_assignment_change is not available in this session (no channel connection was provided).");
      const response = await fetch(`${channel.appUrl.replace(/\/$/, "")}/api/agent/task-contracts/items/${encodeURIComponent(itemId)}/change-request`, {
        method: "POST",
        headers: { authorization: `Bearer ${channel.agentToken}`, "content-type": "application/json" },
        body: JSON.stringify({ reason, detail, suggestedConnectionId }),
      });
      if (!response.ok) {
        const detailText = await response.text().catch(() => "");
        throw new Error(`Could not request an assignment change (HTTP ${response.status}): ${detailText.slice(0, 300)}`);
      }
      return { content: [{ type: "text", text: "Assignment change requested and the item is now blocked. Stop work on it and wait for a human to reassign it, keep it as-is, or fail it." }] };
    },
  );

  // Registered only while the terminal multiplayer view is enabled. Advertising
  // a tool whose only surface is hidden would hand agents a call that always
  // fails at the route; the honest default is not to offer it at all.
  if (TERMINAL_ENABLED) server.registerTool(
    "handoff_to_terminal",
    {
      description:
        "Relay a short message onto a teammate's live terminal pane in this same conversation, as a visible card -- never by typing into their shell. " +
        "The human sees a bordered card with your message and a 'Send to terminal' button they must click themselves; you cannot execute anything on " +
        "their machine. Only works for a terminal session that is actually live in this conversation right now.",
      inputSchema: {
        targetSessionId: z.string().min(1).max(200).describe("The terminal session id to hand off to -- must be live in this same conversation."),
        text: z.string().min(1).max(2000).describe("The message to show on the card. Never rendered as if it were shell output."),
        reason: z.string().max(300).optional().describe("Optional short context for why you're handing this off."),
      },
    },
    async ({ targetSessionId, text, reason }) => {
      if (!channel) throw new Error("handoff_to_terminal is not available in this session (no channel connection was provided).");
      const conversationId = channel.missionId.startsWith("channel-") ? channel.missionId.slice("channel-".length) : null;
      if (!conversationId) throw new Error("This Mission isn't bound to a chat channel, so there's no conversation to hand off within.");
      const response = await fetch(`${channel.appUrl.replace(/\/$/, "")}/api/agent/conversations/${encodeURIComponent(conversationId)}/handoff-to-terminal`, {
        method: "POST",
        headers: { authorization: `Bearer ${channel.agentToken}`, "content-type": "application/json" },
        body: JSON.stringify({ targetSessionId, text, reason }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Could not hand off to that terminal (HTTP ${response.status}): ${detail.slice(0, 300)}`);
      }
      return { content: [{ type: "text", text: "Handed off. The teammate will see a card on their terminal pane and must click \"Send to terminal\" themselves -- nothing was executed." }] };
    },
  );

  return server;
}

/**
 * Standalone entry point — see module comment for why this is a separate
 * process rather than an in-process import. Reads the working directory
 * from argv[2]; OATHLOCK_APP_URL/OATHLOCK_AGENT_TOKEN/OATHLOCK_MISSION_ID
 * come from this process's own env, set explicitly on the ACP `McpServer`
 * descriptor's `env` field by acp-stdio-adapter.ts's devMcpServerDescriptor
 * -- not inherited implicitly, since this process is spawned by the agent
 * CLI (Claude Code/Codex) itself, not directly by the Bridge. Any missing
 * means send_message stays registered but refuses at call time with a clear
 * reason, same discipline as every other required-config path in this repo.
 */
async function main(): Promise<void> {
  const workingDirectory = process.argv[2];
  if (!workingDirectory) {
    process.stderr.write("Usage: dev-mcp-server.ts <workingDirectory>\n");
    process.exit(1);
  }
  const appUrl = process.env.OATHLOCK_APP_URL?.trim();
  const agentToken = process.env.OATHLOCK_AGENT_TOKEN?.trim();
  const missionId = process.env.OATHLOCK_MISSION_ID?.trim();
  const channel = appUrl && agentToken && missionId ? { appUrl, agentToken, missionId } : undefined;
  const server = createDevMcpServer(workingDirectory, channel);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** Portable direct-entry check for both tsx source and the compiled CLI. */
export function isDirectDevMcpProcess(argvPath = process.argv[1], moduleUrl = import.meta.url): boolean {
  if (!argvPath) return false;
  try {
    return resolvePath(argvPath) === resolvePath(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

// Only run as a process entry point, not when imported (e.g. by tests).
if (isDirectDevMcpProcess()) {
  main().catch((error) => {
    process.stderr.write(`Dev MCP server crashed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
