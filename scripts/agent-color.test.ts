import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentColor, workspaceHumanCount } from "../src/lib/agent-color";

type Row = { created_by: string | null; revoked_at: string | null };

function fakeSupabase(options: { connections: Row[]; rpcColor?: string; rpcError?: boolean }) {
  return {
    from(table: string) {
      assert.equal(table, "agent_connections");
      return {
        select: () => ({
          eq: () => ({
            is: () => ({
              not: () => ({ data: options.connections.filter((r) => r.revoked_at === null && r.created_by !== null), error: null }),
            }),
          }),
        }),
      };
    },
    rpc: (name: string) => {
      assert.equal(name, "allocate_workspace_member_color");
      if (options.rpcError) return Promise.resolve({ data: null, error: new Error("boom") });
      return Promise.resolve({ data: options.rpcColor ?? "#7AA2F7", error: null });
    },
  } as never;
}

test("a solo workspace (one human) colors by agent, never calling the per-person allocator", async () => {
  const supabase = fakeSupabase({ connections: [{ created_by: "u1", revoked_at: null }, { created_by: "u1", revoked_at: null }] });
  assert.equal(await workspaceHumanCount(supabase, "w1"), 1);
  const color = await resolveAgentColor(supabase, { workspaceId: "w1", connectedBy: "u1", agentKind: "claude-code" });
  assert.equal(color, "#D97757", "a solo workspace must use the static per-agent brand color, not a per-person allocation");
});

test("a multi-human workspace colors by person via the durable allocator", async () => {
  const supabase = fakeSupabase({
    connections: [{ created_by: "u1", revoked_at: null }, { created_by: "u2", revoked_at: null }],
    rpcColor: "#34D399",
  });
  assert.equal(await workspaceHumanCount(supabase, "w1"), 2);
  const color = await resolveAgentColor(supabase, { workspaceId: "w1", connectedBy: "u2", agentKind: "codex" });
  assert.equal(color, "#34D399", "multiple distinct humans must resolve through the per-person allocator, not the static per-agent map");
});

test("a revoked connection's owner does not count toward the human total", async () => {
  const supabase = fakeSupabase({ connections: [{ created_by: "u1", revoked_at: null }, { created_by: "u2", revoked_at: "2026-10-18T00:00:00Z" }] });
  assert.equal(await workspaceHumanCount(supabase, "w1"), 1, "a revoked member must not keep a workspace in multi-person coloring mode");
});

test("a failed allocator call falls back to per-agent color instead of throwing", async () => {
  const supabase = fakeSupabase({ connections: [{ created_by: "u1", revoked_at: null }, { created_by: "u2", revoked_at: null }], rpcError: true });
  const color = await resolveAgentColor(supabase, { workspaceId: "w1", connectedBy: "u1", agentKind: "codex" });
  assert.equal(color, "#F2EFE9", "an allocator failure must not crash rendering; it falls back to the static per-agent color");
});

test("an agent with no connecting user (connectedBy null) always uses per-agent color", async () => {
  const supabase = fakeSupabase({ connections: [{ created_by: "u1", revoked_at: null }, { created_by: "u2", revoked_at: null }] });
  const color = await resolveAgentColor(supabase, { workspaceId: "w1", connectedBy: null, agentKind: "claude-code" });
  assert.equal(color, "#D97757");
});
