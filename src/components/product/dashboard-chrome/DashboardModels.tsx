"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import type { AgentView } from "@/lib/agent-workspace-data";
import type { AgentRunSettings } from "@/lib/agent-run-settings";
import { effortsForModel } from "@/lib/agent-run-settings";
import type { AvailableModelOption } from "@/lib/available-model-options";
import { AgentMark } from "../WorkspaceUI";
import { DashboardMenu } from "./Chrome";

interface SettingsRead {
  defaults: AgentRunSettings;
  override: AgentRunSettings | null;
  effective: AgentRunSettings;
  models: AvailableModelOption[] | null;
  efforts: AvailableModelOption[] | null;
}
function AgentSettings({ agent, conversationId }: { agent: AgentView; conversationId?: string }) {
  const router = useRouter();
  const [data, setData] = useState<SettingsRead | null>(null);
  const [scope, setScope] = useState("connection");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const efforts = data ? effortsForModel(data, model || null) : null;
  useEffect(() => {
    const abort = new AbortController();
    const query = new URLSearchParams({ connectionId: agent.connectionId! });
    if (conversationId) query.set("conversationId", conversationId);
    void fetch(`/api/agent/connection-settings?${query}`, { signal: abort.signal }).then(async response => {
      // Check .ok before parsing: a Cloudflare 5xx returns an HTML error page, and response.json() on that throws
      // "Unexpected token '<'" -- a real error, just not the one the person sees without this.
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? "Settings unavailable.");
      }
      const body = await response.json();
      setData(body); setModel(body.defaults.model ?? "");
      setEffort(effortsForModel(body, body.defaults.model)?.some(option => option.id === body.defaults.effort) ? body.defaults.effort : "");
    }).catch(error => { if (!abort.signal.aborted) setNotice(error.message); });
    return () => abort.abort();
  }, [agent.connectionId, conversationId]);
  function changeScope(value: string) {
    setScope(value);
    const settings = value === "channel" ? data?.effective : data?.defaults;
    setModel(settings?.model ?? "");
    setEffort(data && settings && effortsForModel(data, settings.model)?.some(option => option.id === settings.effort) ? settings.effort ?? "" : "");
  }
  async function save(inherit = false) {
    setBusy(true); setNotice(null);
    try {
      const response = await fetch("/api/agent/connection-settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connectionId: agent.connectionId, model: inherit ? null : model || null, effort: inherit ? null : effort || null, ...(scope === "channel" ? { conversationId, inherit } : {}) }) });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? "Could not save settings.");
      }
      setNotice(inherit ? "Channel now inherits this agent's defaults." : "Saved. Applies before the next turn; the current turn keeps its settings.");
      setData(previous => {
        if (!previous) return previous;
        const saved = { model: model || null, effort: effort || null };
        const defaults = scope === "connection" ? saved : previous.defaults;
        const override = scope === "channel" ? (inherit ? null : saved) : previous.override;
        return { ...previous, defaults, override, effective: override ?? defaults };
      });
      router.refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not save settings."); }
    finally { setBusy(false); }
  }
  return <section className="p-3"><h3><AgentMark agentKey={agent.key} size={16} />{agent.label}</h3>
    {data && <fieldset disabled={busy} className="grid gap-2"><label className="text-xs">Apply to<select className="product-input" value={scope} onChange={event => changeScope(event.target.value)}><option value="connection">Agent defaults</option>{conversationId && <option value="channel">This channel only</option>}</select></label>
      <label className="text-xs">Model<select className="product-input" value={model} onChange={event => { setModel(event.target.value); setEffort(""); }}><option value="">Provider default</option>{data.models?.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
      <label className="text-xs">Reasoning effort<select className="product-input" value={effort} onChange={event => setEffort(event.target.value)}><option value="">Provider default</option>{efforts?.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
      {!efforts?.length && <p className="text-xs">This provider has not reported effort choices for this model.</p>}
      <button type="button" disabled={busy} onClick={() => void save()}>Save settings</button>
      {scope === "channel" && <button type="button" disabled={busy} onClick={() => void save(true)}>Inherit agent defaults</button>}
    </fieldset>}
    {notice && <p role="status" className="text-xs mt-2">{notice}</p>}
  </section>;
}
export function DashboardModels({ agents, conversationId }: { agents: AgentView[]; conversationId?: string }) {
  const connected = agents.filter(agent => agent.connectionId && agent.connected);
  return <DashboardMenu label="Agent model and effort settings" className="m9r-dash-chip m9r-dash-model-chip" trigger={<><span>Agent settings</span><ChevronDown size={12} /></>}>
    {() => <div className="m9r-dash-picker-options">{connected.length === 0 && <p>Connect an agent to choose its model and effort.</p>}{connected.map(agent => <AgentSettings key={`${agent.connectionId}:${conversationId ?? "default"}`} agent={agent} conversationId={conversationId} />)}</div>}
  </DashboardMenu>;
}
