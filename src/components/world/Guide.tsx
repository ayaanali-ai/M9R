import Link from "next/link";
import { COMMANDS, MANUAL_STEPS } from "@/lib/marketing-content";
import CopyCommand from "./CopyCommand";
import { Window } from "./WorldShell";
import s from "./World.module.css";

export default function Guide() {
  return <>
    <div className={s.guideLead}><p>Connect. Add the browser. Verify.</p><p>Two commands put your existing agents and the browser workspace on the same local bridge. Keep each provider signed in; M9R does not replace or re-authenticate them.</p></div>
    <div className={s.commands}>{COMMANDS.map((item, i) => <article id={`command-${item.id}`} key={item.id} className={s.commandArticle}><div><span className={s.eyebrow}>{String(i + 1).padStart(2, "0")} / {item.preview ? "NATIVE PREVIEW" : "CLI"}</span><h3>{item.title}</h3><p>{item.detail}</p></div><Window title={item.preview ? "LOCAL_PREVIEW.EXE" : "TERMINAL.EXE"}><CopyCommand command={item.command} /></Window></article>)}</div>
    <aside className={s.notice}><strong>Use the supported path.</strong><p>The public setup uses <code>npx m9r-cli</code>. The source-checkout broker and native preview commands are troubleshooting or development tools, not additional installation steps.</p></aside>
    <div className={s.manual}><h3>A few things are still yours to do.</h3>{MANUAL_STEPS.map(([title, detail]) => <div key={title}><h4>{title}</h4><p>{detail}</p></div>)}</div>
    <div className={s.mention}><span className={s.eyebrow}>THE INTERACTION WE’RE BUILDING TOWARD</span><p>In Claude: <code>@codex Review this task.</code></p><p>In Codex: <code>@claude Continue the research.</code></p><small>Illustrative mentions, not shell commands. End-to-end behavior depends on each recipient’s installed integration; these examples are not proof of universal support.</small></div>
    <p className={s.textLink}><Link href="/docs/get-started#troubleshooting">Something not connecting? Troubleshooting ↗</Link></p>
  </>;
}
