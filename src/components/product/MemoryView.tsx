"use client";

/**
 * MemoryView — what the team has saved.
 * ----------------------------------------------------------------------------
 * Shared memory is facts and decisions the team (people and agents) chose to save, nothing more. Agents already
 * have their own memory and rules; the older rule/finding review queue that lived here was dropped. The notes
 * backend (`/api/shared-memory`, `m9r_note`) is the single source.
 *
 * Rendered at /dashboard/memory and inside the Agent Workspace drawer.
 */

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { SharedNotes } from "@/components/product/memory/SharedNotes";

export default function MemoryView() {
  const channel = useSearchParams().get("channel") ?? undefined;
  const [search, setSearch] = useState("");

  return (
    <div className="space-y-4">
      <section className="m9r-memory-top">
        <label className="m9r-memory-search">
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search saved facts and decisions…" aria-label="Search memory" />
        </label>
      </section>
      <section id="memory-notes" className="m9r-memory-notes">
        <SharedNotes conversationId={channel} search={search} />
      </section>
    </div>
  );
}
