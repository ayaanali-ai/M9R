import Link from "next/link";
import { COMMANDS, MANUAL_STEPS } from "@/lib/marketing-content";
import CopyCommand from "./CopyCommand";
import { Window } from "./WorldShell";
import s from "./World.module.css";

export default function Guide() {
  return <>
    <div className={s.guideLead}><p>Install. Approve. Connect.</p><p>Keep your agents where they are. Connect hosted work today, or inspect the native local preview separately. These are different setup paths.</p></div>
    <div className={s.commands}>{COMMANDS.map((item, i) => <article id={`command-${item.id}`} key={item.id} className={s.commandArticle}><div><span className={s.eyebrow}>{String(i + 1).padStart(2, "0")} / {item.preview ? "NATIVE PREVIEW" : "CLI"}</span><h3>{item.title}</h3><p>{item.detail}</p></div><Window title={item.preview ? "LOCAL_PREVIEW.EXE" : "TERMINAL.EXE"}><CopyCommand command={item.command} /></Window></article>)}</div>
    <aside className={s.notice}><strong>Copy the command that actually exists.</strong><p>The installed binary is <code>m9r-cli</code>. Native preview commands are present in this checkout, but their availability in the published npm package has not been verified. Run <code>m9r-cli --help</code> to check your installed version.</p></aside>
    <div className={s.manual}><h3>A few things are still yours to do.</h3>{MANUAL_STEPS.map(([title, detail]) => <div key={title}><h4>{title}</h4><p>{detail}</p></div>)}</div>
    <div className={s.mention}><span className={s.eyebrow}>THE INTERACTION WE’RE BUILDING TOWARD</span><p>In Claude: <code>@codex Review this task.</code></p><p>In Codex: <code>@claude Continue the research.</code></p><small>Illustrative mentions, not shell commands. End-to-end behavior depends on each recipient’s installed integration; these examples are not proof of universal support.</small></div>
    <p className={s.textLink}><Link href="/docs/get-started#troubleshooting">Something not connecting? Troubleshooting ↗</Link></p>
  </>;
}
