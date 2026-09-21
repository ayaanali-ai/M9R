import type { Metadata } from "next";
import { WorldPage } from "@/components/world/WorldShell";
import { FAQS } from "@/lib/marketing-content";
export const metadata: Metadata = { title: "FAQ — M9R", description: "Straight answers about setup, free access, preview features, and licensing." };
export default function FAQ() {
  return <WorldPage label="FAQ / STRAIGHT ANSWERS" title="Fair questions." intro="What it does. What it doesn’t. What is still being built.">{FAQS.map(([question, answer]) => <details key={question}><summary>{question}<span aria-hidden="true">+</span></summary><p>{answer}</p></details>)}</WorldPage>;
}
