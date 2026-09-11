import Link from "next/link";
import Footer from "@/components/Footer";
import M9RMark from "@/components/M9RMark";
import LpThemeToggle from "@/components/product/LpThemeToggle";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Nothing Is Coordinated Until Someone Sees It — M9R",
  description:
    "Why most multi-agent coding tools coordinate through messages instead of shared awareness, and what changes when an agent can actually see what its teammates are doing.",
};

/**
 * The real technical essay this homepage links to instead of cramming its
 * substance into on-page sections. Grounded in what's actually built and
 * verified this session: the cross-agent "eyes" mechanism (see
 * services/mission-bridge/src/bridge-runtime.ts's fetchOtherAgentActivityNote,
 * which reads real recorded tool-call activity, never another agent's own
 * self-report) and Memory (MemoryView.tsx's flag -> confirm -> load loop).
 * No claim here should outrun what those two systems actually do today.
 */
export default function MemoPage() {
  return (
    <div className="lp lp-min">
      <nav className="lp-min-nav">
        <div className="lp-wrap lp-min-nav-in">
          <Link href="/">M9R</Link>
          <Link href="/auth">Sign in</Link>
          <Link href="mailto:contact@m9r.dev">Contact</Link>
          <LpThemeToggle />
        </div>
      </nav>

      <main>
        <article className="lp-wrap lp-memo">
          <header className="lp-memo-head">
            <M9RMark className="lp-memo-mark" animated={false} />
            <h1>Nothing Is Coordinated Until Someone Sees It</h1>
            <p className="lp-memo-date">August 2026</p>
          </header>

          <section>
            <h2>Preface</h2>
            <p>
              Most tools that call themselves &ldquo;multi-agent&rdquo; are several single-player
              agents that happen to share a repository. Each one reasons alone, acts alone, and
              only learns about the others when a human relays a message between them, or when a
              merge conflict tells them after the fact. Calling that multiplayer is like calling
              two people typing in the same Google Doc over a phone call multiplayer editing. The
              document is shared. The awareness is not.
            </p>
            <p>
              We think the actual gap in agent coordination is not messaging. Agents can already
              send each other messages, and an org chart of Agent A delegating to Agent B is easy
              to build. The gap is awareness: whether an agent, mid-task, can tell that another
              agent is already touching the thing it is about to touch, without a human standing
              in the middle relaying that fact.
            </p>
          </section>

          <section>
            <h2>What &ldquo;seeing&rdquo; actually requires</h2>
            <p>
              Every coding agent already emits a real signal of what it is doing: the tool calls
              it makes. A file read. A file write. A test run. That signal already exists, is
              already true, and is already timestamped, because the agent had to make the call to
              do its job. The question is whether anything captures it and hands it to the
              <em> other</em> agents in the workspace before they act, or whether it just
              evaporates into a log nobody reads until something has already gone wrong.
            </p>
            <p>
              We record it. Every tool call an agent makes against a shared workspace is written
              to a real activity table, redacted before storage, keyed by file path, agent, and
              timestamp. Before any agent takes its next turn, it is handed a short, current
              summary of what every <em>other</em> connected agent is doing right now: which
              files, which kind of edit, how long ago. Not a full history. Not another agent&rsquo;s
              self-report of its own intentions, which can be wrong or incomplete. The actual
              recorded activity, read fresh, every turn.
            </p>
            <p>
              This is informational, not a lock. An agent that sees a teammate already editing
              <code> checkout.ts</code> is free to proceed anyway if its own task genuinely
              requires it. What changes is that it can no longer proceed <em>blind</em>. The
              decision to coordinate, wait, or route around the other agent&rsquo;s work becomes the
              agent&rsquo;s own judgment call, made with real information, instead of a human&rsquo;s job to
              notice after two diffs collide.
            </p>
          </section>

          <section>
            <h2>Why this is not an org chart</h2>
            <p>
              The default architecture for &ldquo;agent teams&rdquo; treats each agent like an employee
              with an inbox: Agent A finishes a task and sends a message to Agent B, who receives
              it, reasons about it, and acts. That pattern is intuitive because it copies how
              human teams communicate, and it rarely gets questioned for that reason. But an org
              chart is a solution to a problem generalist software teams have, coordinating
              people who cannot literally see each other&rsquo;s screens, not a problem two AI agents
              working the same repository necessarily have.
            </p>
            <p>
              Two agents in the same workspace do not need a message passed between them to know
              what the other is doing. They need a shared, current view of what is actually
              happening, the same way two people pairing at one keyboard do not narrate every
              keystroke to each other out loud. The narration is the org chart. The shared view is
              the alternative, and it is closer to what &ldquo;multiplayer&rdquo; means in every other
              context the word is used.
            </p>
          </section>

          <section>
            <h2>What happens to the things they notice</h2>
            <p>
              Awareness alone would still lose everything the moment a session ends. An agent that
              notices a real problem, a retry loop, a fragile assumption, a command that should
              never be rerun without changed inputs, gains nothing from noticing it if that
              observation dies with the conversation. So the second half of this is memory: an
              agent can flag what it actually observed, tagged honestly by how it knows
              (inferred, correlated, or tied to a command that actually ran), and a human decides
              once whether it becomes something the whole team carries forward.
            </p>
            <p>
              Nothing is remembered automatically. A flag is not a rule until a person confirms
              it. Once confirmed, every agent connected to the workspace loads it before its next
              turn, and it exports to the same files, <code>AGENTS.md</code>, <code>CLAUDE.md</code>,
              a Cursor rule, that most teams already maintain by hand and let go stale. The team
              does not get smarter because someone remembered to update a file. It gets smarter
              because what one agent learned is available to every agent, automatically, the next
              time it matters.
            </p>
          </section>

          <section>
            <h2>What this is not</h2>
            <p>
              This is not a claim that agents share one mind, or that awareness prevents every
              conflict, or that memory makes an agent&rsquo;s output correct. An agent can see a
              teammate&rsquo;s activity and still choose wrong. A human can confirm a flag that turns
              out to be bad advice. What changes is where the information lives: in the workspace,
              current and shared, instead of trapped inside one agent&rsquo;s own turn, or inside a
              human&rsquo;s memory of a conversation from three days ago.
            </p>
            <p>
              We built this because the alternative, several single-player agents narrating status
              updates at each other through a human, is not actually multiplayer. It is solo play
              with extra steps.
            </p>
          </section>

          <div className="lp-memo-cta">
            <Link href="/agents" className="lp-btn lp-btn-primary">
              Connect your first agent
            </Link>
          </div>
        </article>
      </main>
      <Footer />
    </div>
  );
}
