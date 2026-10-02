"use client";

import { useRef, useState } from "react";
import { ArrowUp, AtSign, Bug, CalendarDays, Monitor, Paperclip, Plus, Puzzle, Settings, ShieldCheck, X } from "lucide-react";
import { DashboardChatHeader, DashboardContactContents, DashboardMenu, DashboardPanel, DashboardPicker, DashboardSearch, DashboardSidebarTop } from "@/components/product/dashboard-chrome/Chrome";
import { useComposerAutosize } from "@/components/product/useComposerAutosize";
import { dashboardFont } from "@/components/product/dashboard-chrome/dashboard-font";
import "@/components/product/dashboard-renovation.css";
import "./preview.css";

type PreviewMessage = { id: number; body: string; mine?: boolean };
type PreviewBot = { id: string; name: string; agent: string; model: string; messages: PreviewMessage[] };
const models = [{ id: "claude-sonnet", label: "Claude Sonnet 5" }, { id: "gpt", label: "GPT-6" }, { id: "provider", label: "Provider default" }];
const firstBot: PreviewBot = { id: "bramble", name: "Bramble", agent: "codex", model: "claude-sonnet", messages: [{ id: 1, body: "Hey — I’m Bramble. Nice to meet you." }] };

/** Local fixture of the SAME chrome and styles used by the authenticated dashboard. */
export default function DashboardPreview() {
  const [bots, setBots] = useState<PreviewBot[]>([firstBot]);
  const [selectedId, setSelectedId] = useState(firstBot.id);
  const [sidebar, setSidebar] = useState(true);
  const [mode, setMode] = useState<"night" | "day">("night");
  const [query, setQuery] = useState("");
  const [find, setFind] = useState("");
  const [draft, setDraft] = useState("");
  const [panel, setPanel] = useState<string | null>(null);
  const [question, setQuestion] = useState(true);
  const [files, setFiles] = useState<string[]>([]);
  const [newName, setNewName] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const attachment = useRef<HTMLInputElement>(null);
  const bot = bots.find(item => item.id === selectedId) ?? bots[0];
  useComposerAutosize(textarea, draft, bot.id);
  function addMessage(body: string) {
    const text = body.trim();
    if (!text) return;
    setBots(current => current.map(item => item.id === bot.id ? { ...item, messages: [...item.messages, { id: Date.now(), body: text, mine: true }] } : item));
    setDraft("");
    setFiles([]);
    setQuestion(false);
  }
  function createBot() {
    const name = newName.trim();
    if (!name) return;
    const id = `local-${Date.now()}`;
    setBots(current => [...current, { id, name, agent: "other", model: "provider", messages: [] }]);
    setSelectedId(id); setNewName(""); setQuestion(false); setPanel(null);
  }
  return <div className="wf-root m9r-dash-preview-root" data-bs-mode={mode}>
    <div className={`${dashboardFont.variable} product-shell m9r-workspace m9r-dash-preview ${sidebar ? "" : "product-shell--collapsed"}`}>
      {sidebar && <aside className="m9r-dash-preview-sidebar">
        <DashboardSidebarTop onCollapse={() => setSidebar(false)} onAttention={() => setPanel("Activity")} actions={[
          { label: "New agent", icon: <Plus size={16} />, onSelect: () => setPanel("New agent") },
          { label: "New channel", icon: <Plus size={16} />, onSelect: () => setPanel("New channel") },
        ]} />
        <DashboardSearch value={query} onChange={setQuery} label="Search agents and conversations" />
        <nav className="m9r-dash-preview-contacts" aria-label="Conversations">
          {bots.filter(item => item.name.toLowerCase().includes(query.toLowerCase())).map(item => <button key={item.id} type="button" className="m9r-dash-contact" aria-current={item.id === bot.id ? "page" : undefined} onClick={() => { setSelectedId(item.id); setFind(""); }}>
            <DashboardContactContents name={item.name} agent={item.agent} time="6:02 PM" preview={question && item.id === "bramble" ? "What do you mostly want help with?" : item.messages.at(-1)?.body ?? "Start a conversation"} />
          </button>)}
          {bots.every(item => !item.name.toLowerCase().includes(query.toLowerCase())) && <p className="m9r-dash-preview-muted">No conversations found.</p>}
        </nav>
        <div className="m9r-dash-sidebar-footer">
          <nav className="m9r-dash-footer-nav" aria-label="Tools">
            <button type="button" onClick={() => setPanel("Automations")}><CalendarDays size={20} />Automations</button>
            <button type="button" onClick={() => setPanel("Connected apps")}><Puzzle size={20} />Connected apps</button>
          </nav>
          <div className="m9r-dash-profile-row">
            <DashboardMenu label="Profile" className="m9r-dash-profile-menu" align="left" trigger={<><span className="m9r-dash-profile-avatar">?</span><span>You</span></>}>{close => <><p>Local preview · sample data</p><button type="button" onClick={() => { setMode(mode === "night" ? "day" : "night"); close(); }}>Switch to {mode === "night" ? "light" : "dark"} appearance</button><button type="button" onClick={() => { setQuestion(true); setBots([firstBot]); setSelectedId(firstBot.id); close(); }}>Reset sample</button></>}</DashboardMenu>
            <button type="button" aria-label="Settings" onClick={() => setPanel("Settings")}><Settings size={18} /></button>
          </div>
        </div>
      </aside>}
      <main className="m9r-dash-preview-main" data-sidebar={sidebar}>
        {!sidebar && <button type="button" className="m9r-dash-preview-open" aria-label="Open sidebar" onClick={() => setSidebar(true)}>☰</button>}
        <section className="wf-chat-shell">
          <div className="wf-chat-main">
            <DashboardChatHeader name={bot.name} agent={bot.agent}
              threads={<DashboardPicker label="Choose thread" value="Thread" icon={<Plus size={12} />} options={bots.map(item => ({ id: item.id, label: item.name }))} onSelect={setSelectedId} />}
              model={<DashboardPicker label="Choose model" value={models.find(model => model.id === bot.model)?.label ?? bot.model} options={models} icon={<span className="m9r-dash-provider-mark">✳</span>} onSelect={model => setBots(current => current.map(item => item.id === bot.id ? { ...item, model } : item))} />}
              actions={<><button type="button" aria-label="Computer" title="Computer" onClick={() => setPanel(panel === "Computer" ? null : "Computer")} data-active={panel === "Computer"}><Monitor size={18} /></button><button type="button" aria-label="Inspector" title="Inspector" onClick={() => setPanel(panel === "Inspector" ? null : "Inspector")} data-active={panel === "Inspector"}><Bug size={18} /></button></>}
              search={find} onSearch={setFind} menuActions={[{ label: "Agent settings", onSelect: () => setPanel("Agent settings") }, { label: "New thread", onSelect: () => setPanel("New channel") }]} />
            <ol className="wf-chat-messages">
              <li className="m9r-dash-preview-date">Today 6:02 PM</li>
              {bot.messages.filter(message => message.body.toLowerCase().includes(find.toLowerCase())).map(message => <li key={message.id}><div className="wf-chat-message" data-mine={message.mine || undefined}><div className="wf-chat-message-body"><p>{message.body}</p></div></div></li>)}
              {question && bot.id === "bramble" && !find && <li className="m9r-dash-question">
                <div className="m9r-dash-question-heading"><strong>What do you mostly want help with?</strong><button type="button" aria-label="Dismiss question" onClick={() => setQuestion(false)}><X size={16} /></button></div>
                <p>Pick whatever’s closest; we can always expand from there.</p>
                <div className="m9r-dash-question-options">{["Work & projects", "Writing & research", "Life admin", "A bit of everything"].map((answer, index) => <button type="button" key={answer} onClick={() => addMessage(answer)}><kbd>{String.fromCharCode(65 + index)}</kbd>{answer}</button>)}</div>
                <form onSubmit={event => { event.preventDefault(); addMessage(draft); }}><input aria-label="Your answer" placeholder="Type your own answer" value={draft} onChange={event => setDraft(event.target.value)} /></form>
              </li>}
            </ol>
            <div className="m9r-composer-frame">
              {files.length > 0 && <div className="m9r-dash-preview-files">{files.map(name => <span key={name}>{name}<button type="button" aria-label={`Remove ${name}`} onClick={() => setFiles(current => current.filter(file => file !== name))}><X size={12} /></button></span>)}</div>}
              <form className="wf-chat-composer" onSubmit={event => { event.preventDefault(); addMessage(draft + (files.length ? "\n" + files.join("\n") : "")); }}>
                <div className="wf-chat-composer-field"><textarea ref={textarea} aria-label={`Message ${bot.name}`} placeholder={`Message ${bot.name}`} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /></div>
                <div className="wf-chat-composer-toolbar"><div className="wf-chat-composer-actions">
                  <input ref={attachment} hidden type="file" multiple onChange={event => { setFiles(Array.from(event.target.files ?? [], file => file.name)); event.target.value = ""; }} />
                  <button type="button" className="wf-chat-toolbar-icon" aria-label="Attach a file" onClick={() => attachment.current?.click()}><Paperclip size={17} /></button>
                  <button type="button" className="wf-chat-toolbar-icon" aria-label="Mention agent" onClick={() => { setDraft(current => current + `@${bot.name} `); textarea.current?.focus(); }}><AtSign size={17} /></button>
                </div><div className="wf-chat-composer-status"><button type="submit" className="wf-chat-send-button" disabled={!draft.trim() && !files.length} aria-label="Send sample message"><ArrowUp size={17} /></button></div></div>
              </form>
            </div>
            <span className="m9r-dash-preview-label">Local preview · sample data</span>
          </div>
          {panel && <aside className="wf-chat-side-slot"><DashboardPanel title={panel} onClose={() => setPanel(null)}>
            {panel.startsWith("New ") ? <form className="m9r-dash-preview-form" onSubmit={event => { event.preventDefault(); createBot(); }}><label>Name<input autoFocus value={newName} onChange={event => setNewName(event.target.value)} required maxLength={80} /></label><button type="submit" disabled={!newName.trim()}>Create {panel === "New agent" ? "agent" : "channel"}</button></form>
              : panel === "Settings" ? <div className="m9r-dash-preview-form"><label>Appearance<select value={mode} onChange={event => setMode(event.target.value as "night" | "day")}><option value="night">Midnight</option><option value="day">Daylight</option></select></label><p>M9R</p></div>
              : panel === "Agent settings" ? <div className="m9r-dash-preview-form"><label>Name<input value={bot.name} onChange={event => setBots(current => current.map(item => item.id === bot.id ? { ...item, name: event.target.value } : item))} /></label><label>Model<select value={bot.model} onChange={event => setBots(current => current.map(item => item.id === bot.id ? { ...item, model: event.target.value } : item))}>{models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label></div>
              : panel === "Computer" ? <><div className="m9r-dash-computer-preview"><Monitor size={32} /><span>No computer connected</span></div><p>Connect a live session in the dashboard to view it here.</p></>
              : panel === "Inspector" ? <><div className="m9r-dash-inspector-row"><ShieldCheck size={16} /><strong>Conversation</strong></div><dl><dt>Messages</dt><dd>{bot.messages.length}</dd><dt>Model</dt><dd>{models.find(model => model.id === bot.model)?.label}</dd><dt>Source</dt><dd>Local sample</dd></dl></>
              : <p>{panel === "Connected apps" ? "No apps connected in this local preview." : panel === "Automations" ? "No automations in this local preview." : "No pending activity."}</p>}
          </DashboardPanel></aside>}
        </section>
      </main>
    </div>
  </div>;
}
