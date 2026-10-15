import Link from "next/link";

/**
 * Shown above the chat only until an agent is connected, then never again. It replaces the old
 * endpoint strip, setup checklist and native-activity list that sat above the chat permanently.
 */
export default function FirstRunCard() {
  return (
    <section className="m9r-firstrun" aria-label="Connect your first agent">
      <div>
        <h2>Connect your first agent</h2>
        {/* `connect`, not `init`: it finds every installed agent CLI (Claude Code, Codex, OpenCode) on PATH and opens
            one approval page for all of them, with no need to run it from inside a particular agent's own session. */}
        <p>Run this once from any terminal. It finds the agent CLIs installed on this machine and shows them here with their own cursors.</p>
      </div>
      <code>npx m9r-cli connect</code>
      <Link href="/dashboard/settings#agents" prefetch={false}>See connected agents</Link>
    </section>
  );
}
