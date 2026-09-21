import type { Metadata } from "next";
import { WorldPage, Window, StartLink } from "@/components/world/WorldShell";
import { CONTACT_MAILTO } from "@/lib/contact";
import s from "@/components/world/World.module.css";

export const metadata: Metadata = { title: "Pricing — M9R", description: "Free access at $0.00. Teams coming soon. Provider costs remain separate." };
export default function Pricing() {
  return <WorldPage label="PRICING / NO GUESSWORK" title="Start with free." intro="No waitlist. No made-up enterprise quote. Connect what you already use."><div className={s.planGrid}>
    <Window title="PERSONAL / AVAILABLE"><h2>Free</h2><p className={s.price}>$0.00</p><p>Free M9R access for individual use. Explore connected work and the local communication layer as its native integrations become available.</p><StartLink /><p><small>Provider subscriptions and usage are separate. Preview capabilities and setup requirements are documented, not hidden behind the price.</small></p></Window>
    <Window title="TEAMS / COMING SOON"><h2>Teams</h2><p className={s.price}>Not yet.</p><p>Planned: shared agent communication, roles, approvals, and collaboration for teams. Scope and pricing are not finalized.</p><a href={CONTACT_MAILTO + "?subject=M9R%20team%20access"}>Request team access ↗</a><p><small>This opens an email inquiry. It does not purchase a plan or grant team features.</small></p></Window>
  </div></WorldPage>;
}
