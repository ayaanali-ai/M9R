"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { EndpointView } from "@/lib/endpoint-core";
import { ONBOARDING_STEPS } from "@/lib/native/onboarding-steps";
import type { WorkspaceActivityEvent } from "@/lib/bridge/workspace-activity-feed-service";

const ONBOARDING_KEY = "m9r-w1-onboarding-dismissed";
function subscribeOnboarding(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener("m9r:onboarding", callback);
  return () => { window.removeEventListener("storage", callback); window.removeEventListener("m9r:onboarding", callback); };
}
function onboardingSnapshot() { return window.localStorage.getItem(ONBOARDING_KEY) === "1"; }
function onboardingServerSnapshot() { return true; }

export default function WorkspaceEndpointCard() {
  const [rows, setRows] = useState<Array<EndpointView & { machineId: string | null }> | null>(null);
  const [error, setError] = useState(false);
  const onboardingDismissed = useSyncExternalStore(subscribeOnboarding, onboardingSnapshot, onboardingServerSnapshot);
  const [nativeEvents, setNativeEvents] = useState<Array<Extract<WorkspaceActivityEvent, { kind: "native" }>>>([]);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch("/api/dashboard/endpoints", { cache: "no-store" });
        if (!response.ok) throw new Error("Endpoint request failed");
        const body = await response.json() as { endpoints: Array<EndpointView & { machineId: string | null }> };
        if (active) { setRows(body.endpoints); setError(false); }
      } catch { if (active) setError(true); }
    };
    void refresh();
    const refreshActivity = async () => {
      try {
        const response = await fetch("/api/dashboard/workspace-activity", { cache: "no-store" });
        if (!response.ok) return;
        const body = await response.json() as { events: WorkspaceActivityEvent[] };
        if (active) setNativeEvents(body.events.filter((event): event is Extract<WorkspaceActivityEvent, { kind: "native" }> => event.kind === "native").slice(0, 5));
      } catch { /* Existing endpoint status remains available if Activity is down. */ }
    };
    void refreshActivity();
    const interval = window.setInterval(() => void refresh(), 30_000);
    const activityInterval = window.setInterval(() => void refreshActivity(), 30_000);
    return () => { active = false; window.clearInterval(interval); window.clearInterval(activityInterval); };
  }, []);
  return <section aria-label="Connected endpoints" className="mx-4 mb-4 rounded-xl border border-white/15 bg-black/25 p-4 text-sm text-white/85">
    <h2 className="mb-2 font-semibold">Agent endpoints</h2>
    {error && <p role="status">Endpoint status is temporarily unavailable.</p>}
    {rows?.length ? <ul className="flex flex-wrap gap-2">{rows.map((row) => <li key={row.id} className="rounded-lg border border-white/15 px-3 py-2">
      <span aria-label={row.reachability} className={`mr-2 inline-block size-2 rounded-full ${row.reachability === "live" ? "bg-green-400" : "bg-amber-400"}`} />
      <strong>{row.address}</strong> · {row.provider} · <span title={row.fidelity.note}>{row.fidelity.level}</span> · gen {row.generation}
      <span className="block text-xs text-white/55">{row.machineId ? `Machine ${row.machineId.slice(0, 8)} · ` : ""}{row.presence.lastSeenAt ? `Last seen ${new Date(row.presence.lastSeenAt).toLocaleString()}` : "Never seen"}</span>
    </li>)}</ul> : rows && <p>No endpoints are connected to this workspace yet.</p>}
    {!onboardingDismissed && rows && <div className="mt-3 border-t border-white/10 pt-3">
      <div className="flex items-center justify-between"><h3 className="font-medium">Finish setting up M9R</h3><button type="button" className="underline" onClick={() => { window.localStorage.setItem(ONBOARDING_KEY, "1"); window.dispatchEvent(new Event("m9r:onboarding")); }}>Dismiss</button></div>
      <p className="mt-1 text-xs">Claude connected: {rows.some((row) => row.provider === "claude-code" && row.reachability === "live") ? "yes" : "not detected"} · Codex connected: {rows.some((row) => row.provider === "codex" && row.reachability === "live") ? "yes" : "not detected"} · Codex hook trust and desktop restart: verify locally.</p>
      <details className="mt-2"><summary className="cursor-pointer">Setup steps</summary><ol className="mt-2 list-inside list-decimal">{ONBOARDING_STEPS.filter((step) => step.id !== "undo").map((step) => <li key={step.id}>{step.title}: {step.detail} {step.fix && <code>{step.fix}</code>}</li>)}</ol></details>
    </div>}
    {nativeEvents.length > 0 && <div className="mt-3 border-t border-white/10 pt-2"><h3 className="font-medium">Recent native activity</h3><ul>{nativeEvents.map((event) => <li key={event.id}>{event.eventKind.replaceAll("_", " ")}{event.handle ? ` · @${event.handle}` : ""} · {new Date(event.at).toLocaleString()}</li>)}</ul></div>}
  </section>;
}
