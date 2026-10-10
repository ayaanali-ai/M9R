/* eslint-disable @next/next/no-img-element */
import type { ReactNode } from "react";
import Link from "next/link";
import { Panel } from "./ReferencePage";
import s from "./ReferenceHome.module.css";
import d from "./ReferencePage.module.css";

export type LegalSection = { title: string; body: ReactNode; caps?: boolean };
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/* A long legal document: sticky contents window beside one reading window, collapsing to a +/- contents list on small screens. */
export function LegalDocument({ name, effective, notice, sections }: { name: string; effective?: string; notice?: { label: string; title: string; body: ReactNode }; sections: readonly LegalSection[] }) {
  const entries = [...(notice ? [{ id: slug(notice.title), title: notice.title, n: 0 }] : []), ...sections.map((section, index) => ({ id: slug(section.title), title: section.title, n: index + 1 }))];
  const toc = <ol className={d.tocList}>{entries.map(entry => <li key={entry.id}><a href={`#${entry.id}`}>{entry.n > 0 && <span className={d.num}>{entry.n}</span>}{entry.title}</a></li>)}</ol>;
  return <div className={d.legal}>
    <nav className={`${s.window} ${d.toc}`} aria-label={`${name} contents`}>
      <div className={s.titleBar}><span><img src="/reference-innerwebs/b319737156808921.webp" alt="" />Contents</span></div>
      <div className={`${s.productBody} ${d.tocBody}`}>{toc}</div>
      <div className={s.statusBar}><span>{sections.length} sections</span></div>
    </nav>
    <Panel title={name} kicker={effective} status={`End of ${name.toLowerCase()}`}>
      <details className={d.tocMobile}><summary>Contents<span className={d.mark} aria-hidden="true" /></summary>{toc}</details>
      {notice && <section id={slug(notice.title)} className={d.notice}><p className={s.productKicker}>{notice.label}</p><h2>{notice.title}</h2>{notice.body}</section>}
      {sections.map((section, index) => <section key={section.title} id={slug(section.title)} className={`${d.clause} ${section.caps ? d.caps : ""}`}>
        <h2><span className={d.num}>§ {index + 1}</span>{section.title}</h2>
        {typeof section.body === "string" ? <p>{section.body}</p> : section.body}
      </section>)}
    </Panel>
  </div>;
}

const POLICIES = [["/terms", "Terms of service"], ["/privacy", "Privacy policy"], ["/privacy/extension", "Extension privacy"], ["/acceptable-use", "Acceptable use"], ["/data-processing", "Data processing"], ["/security", "Security"], ["/cookies", "Cookies and storage"]] as const;

/* Cross-links between the legal pages, so every policy is reachable from any other. */
export function LegalLinks({ current }: { current: (typeof POLICIES)[number][0] }) {
  return <Panel title="Policies" heading="Other policies." status="M9R legal and policy documents" wide>
    <div className={d.links}>{POLICIES.filter(([href]) => href !== current).map(([href, label]) => <Link key={href} className={s.productLink} href={href}>{label}</Link>)}</div>
  </Panel>;
}
