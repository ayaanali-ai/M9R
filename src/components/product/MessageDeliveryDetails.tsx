"use client";

import { useState } from "react";
import type { MessageDeliveryReport } from "@/lib/delivery-service";

export default function MessageDeliveryDetails({ messageId }: { messageId: string }) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<MessageDeliveryReport | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  async function show() {
    if (loading) return;
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (loaded) return;
    setLoading(true);
    setError(false);
    try {
      const response = await fetch(`/api/dashboard/messages/${encodeURIComponent(messageId)}/delivery`, { cache: "no-store" });
      if (!response.ok) throw new Error("Delivery request failed");
      setReport(await response.json() as MessageDeliveryReport);
      setLoaded(true);
    } catch { setError(true); }
    finally { setLoading(false); }
  }
  const panelId = `delivery-${messageId}`;
  return <div className="mt-1 text-xs text-white/60" aria-busy={loading}>
    <button type="button" onClick={() => void show()} aria-expanded={open} aria-controls={panelId} disabled={loading} className="underline underline-offset-2">
      {error ? "Retry delivery details" : "Delivery details"}
    </button>
    {open && <div id={panelId}>
      {error ? <p role="alert">Delivery evidence is unavailable. Try again.</p> : loading ? <p role="status">Loading delivery evidence…</p> : report ? report.deliveries.length ? <ul>
        {report.deliveries.map((delivery) => <li key={`${delivery.recipient.address}-${delivery.recipient.endpointId ?? "unbound"}`} className="mt-2">
          <strong>{delivery.recipient.address}</strong> · {delivery.state.replaceAll("_", " ")} · {delivery.attempt > 1 ? `retry ${delivery.attempt - 1} (attempt ${delivery.attempt})` : "attempt 1"}
          {delivery.failureCode && <span> · failure: {delivery.failureCode}</span>}
          {delivery.declined && <span> · declined for now; may be offered again</span>}
          {delivery.viaConsultation && <span> · consultation only</span>}
          {delivery.pendingUntilTurnBoundary && <span> · waiting for the current turn to finish</span>}
          <ol className="ml-3 list-inside list-decimal">
            {delivery.timeline.map((entry, index) => <li key={`${index}-${entry.state}`}>
              {entry.state.replaceAll("_", " ")} · {entry.basis} · {entry.evidence} · <time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time>
              {entry.persisted === true ? " · receipt persisted" : entry.persisted === false ? " · receipt only in bridge memory" : ""}
            </li>)}
          </ol>
          {delivery.notes.length > 0 && <ul aria-label="Delivery notes">{delivery.notes.map((note, index) => <li key={`${note.at}-${index}`}>{note.meaning} · {note.evidence}</li>)}</ul>}
        </li>)}
      </ul> : <p role="status">No agent delivery target was found for this message.</p> : <p role="status">Delivery evidence has not loaded.</p>}
    </div>}
  </div>;
}
