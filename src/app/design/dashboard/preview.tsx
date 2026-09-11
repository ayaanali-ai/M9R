"use client";

import { useRef, useState } from "react";
import { ArrowUp, AtSign, Paperclip, Inbox, PanelLeft, Users, Radio, SquareTerminal, ClipboardCheck, Moon, Sun, Hash, MessageSquare, BookOpen } from "lucide-react";
import M9RMark from "@/components/M9RMark";
import { ChannelWelcome } from "@/components/product/ChannelWelcome";
import EtheralShadow from "@/components/product/EtheralShadow";
import { useComposerAutosize } from "@/components/product/useComposerAutosize";
import MetalSendButton from "@/components/product/MetalSendButton";
import { BorderBeam } from "border-beam";
import "@/components/product/dashboard-renovation.css";
import "./preview.css";
import "./spatial.css";

const sampleMessages = [
  { name: "Maya", body: "Let's make the dashboard feel like a place to build together. Keep the conversation at the center.", mine: false },
  { name: "Me", body: "Agreed. Less chrome, more space. Let's start with the chat shell.", mine: true },
  { name: "Codex", body: "I'll work on the layout and composer. The message transport and permissions can stay as they are.\n\nI'll bring back a local preview for review before anything goes live.", mine: false },
];

const participants = [
  { mark: "M", name: "Maya", state: "present" },
  { mark: "C", name: "Codex", state: "ready" },
  { mark: "✳", name: "Claude", state: "ready" },
] as const;

const panelRows: Record<string, Array<{ label: string; value: string }>> = {
  Review: [{ label: "Changes awaiting review", value: "2" }, { label: "Last verified", value: "8 min ago" }],
  People: participants.map(({ name, state }) => ({ label: name, value: state })),
  Live: [{ label: "Workspace session", value: "idle" }, { label: "Connected agents", value: "2 ready" }],
  Terminal: [{ label: "Local terminal", value: "available" }, { label: "Shared room", value: "not joined" }],
  Attachments: [{ label: "Files in this message", value: "none" }],
  Inbox: [{ label: "Unread activity", value: "0" }, { label: "Review requests", value: "2" }],
  Memory: [{ label: "Shared sessions", value: "12" }, { label: "Last archived", value: "today" }],
};

/** Representative visual fixtures, not simulated provider connectivity. */
export default function DashboardPreview() {
  const [mode, setMode] = useState<"day" | "night">("day");
  const [sidebar, setSidebar] = useState(true);
  const [channel, setChannel] = useState("general");
  const [panel, setPanel] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [channelMessages, setChannelMessages] = useState<Record<string, typeof sampleMessages>>({ general: [], "dashboard-design": sampleMessages });
  const messages = channelMessages[channel];
  const populated = messages.length > 0;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useComposerAutosize(textareaRef, draft, channel);
  const actions = [{ label: "Review", Icon: ClipboardCheck }, { label: "People", Icon: Users }, { label: "Live", Icon: Radio }, { label: "Terminal", Icon: SquareTerminal }];

  return (
    <div className="wf-root m9r-design-bench" data-bs-mode={mode}>
      <div className={`product-shell m9r-workspace ${sidebar ? "" : "product-shell--collapsed"}`}>
        <div className="m9r-preview-toolbar" aria-label="Design preview controls">
          <span>LOCAL DESIGN PREVIEW · SAMPLE DATA</span>
          <button type="button" onClick={() => setChannel(channel === "general" ? "dashboard-design" : "general")}>{channel === "general" ? "Sample conversation" : "General channel"}</button>
          <button type="button" aria-label="Toggle preview theme" onClick={() => setMode(mode === "day" ? "night" : "day")}>{mode === "day" ? <Moon size={13} /> : <Sun size={13} />}</button>
        </div>
        {sidebar && <aside className="m9r-preview-sidebar">
          <div className="m9r-preview-brand"><M9RMark animated={false} /><strong>M9R</strong><button type="button" aria-label="Collapse sidebar" onClick={() => setSidebar(false)}><PanelLeft size={15} /></button></div>
          <div className="m9r-preview-space">Design workspace <span>⌄</span></div>
          <nav aria-label="Preview navigation">
            <button type="button" onClick={() => setPanel("Inbox")}><Inbox size={15} />Inbox</button>
            <button type="button" className="is-current" onClick={() => setPanel(null)}><MessageSquare size={15} />Chat</button>
            <button type="button" onClick={() => setPanel("Memory")}><BookOpen size={15} />Memory</button>
          </nav>
          <p className="m9r-preview-nav-label">Channels</p>
          <button type="button" className={`m9r-preview-channel ${channel === "general" ? "is-current" : ""}`} onClick={() => { setPanel(null); setChannel("general"); }}><Hash size={14} />general</button>
          <button type="button" className={`m9r-preview-channel ${channel === "dashboard-design" ? "is-current" : ""}`} onClick={() => { setPanel(null); setChannel("dashboard-design"); }}><Hash size={14} />dashboard-design</button>
          <p className="m9r-preview-nav-label">People & agents</p>
          <div className="m9r-preview-people-group">
            {participants.map(({ mark, name, state }) => <div className="m9r-preview-person" key={name}><span className="m9r-preview-person__mark">{mark}</span><span className="m9r-preview-person__name">{name}</span><small><i data-state={state} />sample · {state}</small></div>)}
          </div>
        </aside>}
        <main className="m9r-preview-main" data-sidebar={sidebar}>
          {!sidebar && <button type="button" className="product-nav-trigger" aria-label="Open sidebar" onClick={() => setSidebar(true)}><M9RMark animated={false} /></button>}
          <section className="wf-chat-shell" aria-label="Dashboard design preview">
            <div className="wf-chat-main">
              <EtheralShadow />
              <header className="wf-chat-header">
                <div className="m9r-channel-heading"><span className="m9r-channel-heading__eyebrow">Design workspace</span><h2><Hash size={16} aria-hidden />{channel}</h2></div>
                <div className="wf-chat-actions">{actions.map(({ label, Icon }) => <button type="button" className="wf-chat-panel-toggle" key={label} aria-label={label} aria-pressed={panel === label} data-active={panel === label} onClick={() => setPanel(panel === label ? null : label)}><Icon size={14} /><span className="wf-chat-panel-toggle__label">{label}</span></button>)}</div>
              </header>
              <ol className="wf-chat-messages scrollbar-thin" data-verbosity="normal">
                <ChannelWelcome channelKey={`design-preview:${channel}`} hasMessages={populated} showConstellation />
                {messages.map((message, index) => <li key={index}>
                  {index === 0 && <div className="wf-chat-day-divider"><span>Sample conversation</span></div>}
                  <div className="wf-chat-message" data-mine={message.mine || undefined}>
                    <div className="wf-chat-avatar">{message.name[0]}</div>
                    <div className="wf-chat-message-body"><div className="wf-chat-message-meta"><strong>{message.name}</strong><time>10:24</time></div><p>{message.body}</p></div>
                  </div>
                </li>)}
              </ol>
              <BorderBeam className="m9r-composer-beam" size="md" colorVariant="mono" strength={0.65} active theme={mode === "day" ? "light" : "dark"}>
              <form className="wf-chat-composer" onSubmit={(event) => { event.preventDefault(); if (!draft.trim()) return; setChannelMessages(current => ({ ...current, [channel]: [...current[channel], { name: "Me", body: draft, mine: true }] })); setDraft(""); }}>
                <textarea ref={textareaRef} aria-label="Preview message" placeholder="Message your team, or @mention an agent…" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (draft.trim()) event.currentTarget.form?.requestSubmit(); } }} maxLength={2000} />
                <div className="wf-chat-composer-toolbar"><div className="wf-chat-composer-actions">
                  <button type="button" aria-label="Attachments preview" onClick={() => setPanel("Attachments")}><Paperclip size={16} /></button>
                  <button type="button" aria-label="Insert preview mention" onClick={() => setDraft(`${draft}@Codex `)}><AtSign size={16} /></button>
                  <button type="button" aria-label="Inbox preview" onClick={() => setPanel("Inbox")}><Inbox size={16} /></button>
                </div><div className="wf-chat-composer-status"><MetalSendButton theme={mode === "day" ? "light" : "dark"}><button className="wf-chat-send-button" type="submit" aria-label="Add sample message" disabled={!draft.trim()}><ArrowUp size={17} /></button></MetalSendButton></div></div>
              </form>
              </BorderBeam>
            </div>
            {panel && <aside className="wf-chat-side-slot m9r-preview-panel" aria-label={`${panel} preview`}>
              <div className="m9r-preview-panel__title"><div><span>Design preview</span><h2>{panel}</h2></div><button type="button" onClick={() => setPanel(null)}>Done</button></div>
              <div className="m9r-preview-group">{(panelRows[panel] ?? []).map(row => <button type="button" className="m9r-preview-row" key={row.label}><span>{row.label}</span><small>{row.value}</small><b aria-hidden="true">›</b></button>)}</div>
              <p>Sample state only. Workspace data, live sessions and provider actions are not connected here.</p>
            </aside>}
          </section>
        </main>
      </div>
    </div>
  );
}
