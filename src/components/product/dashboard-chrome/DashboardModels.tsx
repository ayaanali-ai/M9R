"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown } from "lucide-react";
import type { AgentView } from "@/lib/agent-workspace-data";
import { AgentMark } from "../WorkspaceUI";
import { DashboardMenu, DashboardSearch } from "./Chrome";

/** Grouped model menu backed by M9R's connection-owned model API. */
export function DashboardModels({ agents }: { agents: AgentView[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = agents.filter(agent => agent.connectionId && agent.connected);
  const single = connected.length === 1 ? connected[0] : null;
  async function choose(agent: AgentView, model: string | null) {
    if (busy || !agent.connectionId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/agent/connections/${encodeURIComponent(agent.connectionId)}/model`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Could not change the model.");
      router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change the model."); }
    finally { setBusy(false); }
  }
  return <DashboardMenu label="Choose model" className="m9r-dash-chip m9r-dash-model-chip" trigger={<><AgentMark agentKey={single?.key ?? "other"} size={14} /><span>{single?.availableModels?.find(model => model.id === single.model)?.label ?? single?.model ?? (single ? "Provider default" : "Models")}</span><ChevronDown size={12} /></>}>
    {() => <><DashboardSearch value={query} onChange={setQuery} label="Search models" /><div className="m9r-dash-picker-options">
      {connected.length === 0 && <p>Connect an agent to choose its model.</p>}
      {connected.map(agent => <section key={agent.id}><h3><AgentMark agentKey={agent.key} size={16} />{agent.label}</h3>
        {[{ id: "", label: "Provider default" }, ...(agent.availableModels ?? [])].filter(model => model.label.toLowerCase().includes(query.toLowerCase())).map(model => <button type="button" key={model.id} disabled={busy} onClick={() => void choose(agent, model.id || null)}><span>{model.label}</span>{(agent.model ?? "") === model.id && <Check size={14} />}</button>)}
        {!agent.availableModels?.length && <p>This agent has not reported its model list yet.</p>}
      </section>)}
    </div>{error && <p role="alert" className="m9r-dash-error">{error}</p>}</>}
  </DashboardMenu>;
}
