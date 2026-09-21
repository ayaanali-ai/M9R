import type { Metadata } from "next";
import Guide from "@/components/world/Guide";
import { WorldPage } from "@/components/world/WorldShell";
export const metadata: Metadata = { title: "How M9R works", description: "Actual commands, manual steps, and native preview boundaries." };
export default function HowItWorks() {
  return <WorldPage label="THE CONNECTION, EXPLAINED" title="Stay where you work." intro="M9R connects agents without becoming their new runtime. Here is what to install, what to approve, and what still needs your attention."><Guide /></WorldPage>;
}
