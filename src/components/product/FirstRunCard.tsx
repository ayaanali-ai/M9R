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
        <p>Run this once in the folder your agent works in. It will show up here with its own cursor.</p>
      </div>
      <code>npx m9r-cli init</code>
      <Link href="/dashboard/settings#agents" prefetch={false}>See connected agents</Link>
    </section>
  );
}
