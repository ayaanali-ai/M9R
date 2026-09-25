"use client";

import { useState } from "react";
import type { MessageDeliveryReport } from "@/lib/delivery-service";

export default function MessageDeliveryDetails({ messageId }: { messageId: string }) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<MessageDeliveryReport | null>(null);
  const [error, setError] = useState(false);
  async function show() {
    setOpen((previous) => !previous);
    try {
      const response = await fetch(`/api/dashboard/messages/${encodeURIComponent(messageId)}/delivery`, { cache: "no-store" });
      if (!response.ok) throw new Error("Delivery request failed");
      setReport(await response.json() as MessageDeliveryReport);
      setError(false);
    } catch { setError(true); }
  }
  return <div className="mt-1 text-xs text-white/60">
    <button type="button" onClick={() => void show()} aria-expanded={open} className="underline underline-offset-2">Delivery details</button>
    {open && (error ? <p>Delivery evidence is unavailable.</p> : report ? <ul>{report.deliveries.map((delivery) => <li key={delivery.recipient.address}>
      <strong>{delivery.recipient.address}</strong> · {delivery.state.replaceAll("_", " ")}
      <ol className="ml-3 list-inside list-decimal">{delivery.timeline.map((entry, index) => <li key={`${index}-${entry.state}`}>{entry.state.replaceAll("_", " ")} · {entry.basis} · {entry.evidence}</li>)}</ol>
    </li>)}</ul> : <p>Loading…</p>)}
  </div>;
}
