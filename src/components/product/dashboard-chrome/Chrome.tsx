"use client";

/** Dashboard chrome adapted from OpenMausBot Sidebar / ChatView / Composer.
 * Copyright 2026 Milind Soni and OpenMausBot contributors (Apache-2.0).
 * Props replace the upstream global store and Electron bridge.
 * Attribution and source hashes are recorded in third_party/dashboard-reference/README.md.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, Check, ChevronDown, MoreHorizontal, PanelLeftClose, Plus, Search, X } from "lucide-react";
import CursorAvatar from "./CursorAvatar";

const GRADIENTS: Record<string, [string, string, string]> = {
  codex: ["#9FE6B5", "#3FAE6E", "#1C7A4C"],
  "claude-code": ["#F7C9A2", "#D88062", "#A74737"],
  opencode: ["#B7C7FF", "#798BE4", "#474798"],
  other: ["#A4DAF5", "#4B9BCE", "#245D98"],
};

export function DashboardAvatar({ agent = "codex", size = 56, working = false }: { agent?: string; size?: number; working?: boolean }) {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return <CursorAvatar size={size} gradient={GRADIENTS[agent] ?? GRADIENTS.other} state={working ? "thinking" : "idle"} paused={reduced || !working} effects={false} title={null} />;
}

export interface DashboardAction { label: string; icon?: ReactNode; onSelect: () => void; active?: boolean; disabled?: boolean }

/** Native button semantics, keyboard dismissal, outside-click dismissal and focus return. */
export function DashboardMenu({ label, trigger, children, className = "", align = "right" }: { label: string; trigger: ReactNode; children: (close: () => void) => ReactNode; className?: string; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const close = () => setOpen(false);
  useEffect(() => {
    if (wasOpen.current && !open && root.current?.contains(document.activeElement)) button.current?.focus();
    wasOpen.current = open;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); button.current?.focus(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key); };
  }, [open]);
  return <div className={`m9r-dash-menu-anchor ${className}`} ref={root}>
    <button type="button" ref={button} aria-label={label} title={label} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>{trigger}</button>
    {open && <div className="m9r-dash-menu" data-align={align} role="dialog" aria-label={label}>{children(close)}</div>}
  </div>;
}

export function DashboardSidebarTop({ onCollapse, onAttention, actions }: { onCollapse: () => void; onAttention: () => void; actions: DashboardAction[] }) {
  return <div className="m9r-dash-sidebar-top">
    <span className="m9r-dash-window-dots" aria-hidden="true"><i /><i /><i /></span>
    <div className="m9r-dash-sidebar-top-actions">
      <button type="button" onClick={onCollapse} aria-label="Collapse sidebar" title="Collapse sidebar"><PanelLeftClose size={20} /></button>
      <button type="button" onClick={onAttention} aria-label="Activity" title="Activity"><Activity size={20} /></button>
      <DashboardMenu label="New" trigger={<Plus size={20} />}>{close => actions.map(action => <button type="button" key={action.label} disabled={action.disabled} onClick={() => { close(); action.onSelect(); }}>{action.icon}<span>{action.label}</span></button>)}</DashboardMenu>
    </div>
  </div>;
}

export function DashboardSearch({ value, onChange, label = "Search" }: { value: string; onChange: (value: string) => void; label?: string }) {
  return <div className="m9r-dash-search-wrap"><label className="m9r-dash-search"><Search size={14} /><input type="search" aria-label={label} placeholder="Search" value={value} onChange={event => onChange(event.target.value)} onKeyDown={event => { if (event.key === "Escape") onChange(""); }} /></label></div>;
}

export function DashboardContactContents({ name, preview, time, agent, working }: { name: string; preview: string; time?: string; agent?: string; working?: boolean }) {
  return <><span className="m9r-dash-contact-avatar"><DashboardAvatar agent={agent} working={working} />{working && <i aria-label="Working" />}</span><span className="m9r-dash-contact-copy"><span className="m9r-dash-contact-heading"><strong>{name}</strong>{time && <time>{time}</time>}</span><span className="m9r-dash-contact-preview">{preview}</span></span></>;
}

export function DashboardChatHeader({ name, agent, model, threads, actions, menuActions = [], search, onSearch }: {
  name: string; agent?: string; model?: ReactNode; threads?: ReactNode; actions?: ReactNode; menuActions?: DashboardAction[]; search?: string; onSearch?: (value: string) => void;
}) {
  return <header className="m9r-dash-chat-header">
    <div className="m9r-dash-chat-header-row"><div className="m9r-dash-chat-identity"><DashboardAvatar agent={agent} size={28} /><h2>{name}</h2></div>
      <div className="m9r-dash-chat-controls">{threads}{model}{actions}{(menuActions.length > 0 || onSearch) && <DashboardMenu label="Conversation actions" trigger={<MoreHorizontal size={18} />}>
        {close => <>{onSearch && <DashboardSearch value={search ?? ""} onChange={onSearch} label="Find in conversation" />}{menuActions.map(action => <button type="button" key={action.label} disabled={action.disabled} onClick={() => { close(); action.onSelect(); }}>{action.icon}<span>{action.label}</span>{action.active && <Check size={14} />}</button>)}</>}
      </DashboardMenu>}</div>
    </div>
  </header>;
}

export function DashboardPicker({ label, value, options, onSelect, icon, busy = false, error }: { label: string; value: string; options: Array<{ id: string; label: string; detail?: string }>; onSelect: (id: string) => void; icon?: ReactNode; busy?: boolean; error?: string | null }) {
  const [query, setQuery] = useState("");
  return <DashboardMenu label={label} className="m9r-dash-chip" trigger={<>{icon}<span>{value}</span><ChevronDown size={12} /></>}>
    {close => <><DashboardSearch value={query} onChange={setQuery} label={`Search ${label.toLowerCase()}`} /><div className="m9r-dash-picker-options">{options.filter(option => option.label.toLowerCase().includes(query.toLowerCase())).map(option => <button type="button" key={option.id} disabled={busy} onClick={() => { onSelect(option.id); close(); }}><span><strong>{option.label}</strong>{option.detail && <small>{option.detail}</small>}</span>{value === option.label && <Check size={14} />}</button>)}{options.length === 0 && <p>No options available.</p>}</div>{error && <p role="alert">{error}</p>}</>}
  </DashboardMenu>;
}

export function DashboardPanel({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return <section className="m9r-dash-panel"><header><h2>{title}</h2><button type="button" onClick={onClose} aria-label={`Close ${title}`}><X size={18} /></button></header><div className="m9r-dash-panel-content">{children}</div></section>;
}
