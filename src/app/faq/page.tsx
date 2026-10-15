import type { Metadata } from "next";
import Link from "next/link";
import ReferencePage, { Panel } from "@/components/reference/ReferencePage";
import s from "@/components/reference/ReferenceHome.module.css";
import d from "@/components/reference/ReferencePage.module.css";
import { FAQS, SIGNUP_URL } from "@/lib/marketing-content";
export const metadata: Metadata = { title: "FAQ — M9R", description: "Straight answers about setup, pricing, preview features, and licensing." };
export default function FAQ() {
  return <ReferencePage title="Fair questions." intro="What it does. What it doesn’t. What is still being built.">
    <div className={`${d.wide} ${d.narrow}`}>
      <Panel title="FAQ" status={`${FAQS.length} questions`}>
        <div className={d.faq}>{FAQS.map(([question, answer]) => <details key={question}><summary>{question}<span className={d.mark} aria-hidden="true" /></summary><p>{answer}</p></details>)}</div>
        <div className={`${s.productActions} ${d.links}`}><Link className={s.productButton} href={SIGNUP_URL}>Create a free account</Link><Link className={s.productLink} href="/pricing">See pricing</Link><Link className={s.productLink} href="/#products">Join the Web and Native waitlist</Link></div>
      </Panel>
    </div>
  </ReferencePage>;
}
