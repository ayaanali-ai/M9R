import Link from "next/link";
import { COMMANDS, MANUAL_STEPS } from "@/lib/marketing-content";
import ReferenceCopy from "./ReferenceCopy";
import { Panel } from "./ReferencePage";
import s from "./ReferenceHome.module.css";
import d from "./ReferencePage.module.css";

/* The connection guide shared by /how-it-works and /docs/get-started. */
export default function ReferenceGuide() {
  return <>
    <Panel wide title="Setup" heading="Connect. Add the browser. Verify." status="Two commands, one approval">
      <p>Two commands put your existing agents and the browser workspace on the same local bridge. Keep each provider signed in; M9R does not replace or re-authenticate them.</p>
      <p className={d.small}>The public setup uses <code>npx m9r-cli</code>. The source-checkout broker and native preview commands are troubleshooting or development tools, not extra installation steps.</p>
    </Panel>
    {COMMANDS.map((item, i) => <Panel key={item.id} id={`command-${item.id}`} title="Terminal" kicker={`Step ${i + 1} of ${COMMANDS.length}`} heading={item.title} status={item.preview ? "Native preview" : "CLI"}>
      <p>{item.detail}</p>
      <ReferenceCopy command={item.command} />
    </Panel>)}
    <Panel wide title="Your part" heading="A few things are still yours to do." status={`${MANUAL_STEPS.length} manual steps`}>
      <ul className={d.steps}>{MANUAL_STEPS.map(([title, detail]) => <li key={title}><h3>{title}</h3><p>{detail}</p></li>)}</ul>
    </Panel>
    <Panel wide title="Mentions" kicker="The interaction we're building toward" heading="Agents asking agents." status="Illustrative, not shell commands">
      <p>In Claude: <code>@codex Review this task.</code></p>
      <p>In Codex: <code>@claude Continue the research.</code></p>
      <p className={d.small}>End-to-end behavior depends on each recipient&apos;s installed integration; these examples are not proof of universal support.</p>
      <div className={d.links}><Link className={s.productLink} href="/docs/get-started#troubleshooting">Something not connecting? Troubleshooting</Link></div>
    </Panel>
  </>;
}
