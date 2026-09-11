"use client";

import { type FormEvent, useState } from "react";
import { Button } from "@/components/product/WorkspaceUI";
import { WORKSPACE_RULE_PRESETS } from "@/lib/workspace-rules-presets";

/**
 * RuleDraftTools — manual creation and import of workspace rule drafts.
 * ----------------------------------------------------------------------------
 * Lives on the Rules page (rule authoring is registry work, not Watchfloor
 * work). Both paths create needs_review drafts only; promotion stays a separate
 * explicit human action.
 */

export default function RuleDraftTools({ onChanged }: { onChanged: () => void }) {
  const [manualTitle, setManualTitle] = useState("");
  const [manualBody, setManualBody] = useState("");
  const [manualScope, setManualScope] = useState("");
  const [manualRisk, setManualRisk] = useState("");
  const [importText, setImportText] = useState("");
  const [importSource, setImportSource] = useState("AGENTS.md");
  const [importScope, setImportScope] = useState("");
  const [importRisk, setImportRisk] = useState("");
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<"manual" | "import" | "presets" | null>(null);

  async function enableStarterRules() {
    setBusy("presets");
    setStatus(null);
    let created = 0;
    const failures: string[] = [];
    for (const preset of WORKSPACE_RULE_PRESETS) {
      try {
        const res = await fetch("/api/agent/rules/manual", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: preset.title, body: preset.body }),
        });
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(json.error || "Could not create the rule draft.");
        created += 1;
      } catch (err) {
        failures.push(`${preset.title}: ${err instanceof Error ? err.message : "failed"}`);
      }
    }
    setStatus(failures.length > 0
      ? { tone: "error", text: `${created} of ${WORKSPACE_RULE_PRESETS.length} starter rules created; failed: ${failures.join("; ")}` }
      : { tone: "ok", text: `${created} starter rule draft(s) created for review.` });
    if (created > 0) onChanged();
    setBusy(null);
  }

  async function submitManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("manual");
    setStatus(null);
    try {
      const res = await fetch("/api/agent/rules/manual", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: manualTitle,
          body: manualBody,
          risk_level: manualRisk || null,
          path_patterns: manualScope,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error || "Could not create the rule draft.");
      setManualTitle("");
      setManualBody("");
      setManualScope("");
      setManualRisk("");
      setStatus({ tone: "ok", text: "Manual rule draft created for review." });
      onChanged();
    } catch (err) {
      setStatus({ tone: "error", text: err instanceof Error ? err.message : "Could not create the rule draft." });
    } finally {
      setBusy(null);
    }
  }

  async function submitImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("import");
    setStatus(null);
    try {
      const res = await fetch("/api/agent/rules/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: importText,
          source_label: importSource || "repo instructions",
          risk_level: importRisk || null,
          path_patterns: importScope,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { created?: number; error?: string };
      if (!res.ok) throw new Error(json.error || "Could not import rule drafts.");
      setImportText("");
      setImportScope("");
      setImportRisk("");
      setStatus({ tone: "ok", text: `${json.created ?? 0} imported rule draft(s) created for review.` });
      onChanged();
    } catch (err) {
      setStatus({ tone: "error", text: err instanceof Error ? err.message : "Could not import rule drafts." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="lg:col-span-2 rounded-lg bg-[color:var(--ol-surface-2)] p-3 border border-[color:var(--ol-border-subtle)]">
        <div className="text-[13px] font-semibold text-[color:var(--ol-text-primary)]">Starter rules</div>
        <p className="mt-1 text-[12px] leading-relaxed text-[color:var(--ol-text-muted)]">
          Four ready-made rules: no hallucinated claims, no silent assumptions, no blind retries, no overclaiming. Creates them as review drafts, same as writing them by hand below. Nothing goes live until you promote each one.
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-[color:var(--ol-text-faint)]">
          Honest limit: these reach an agent as advisory instructions, the same delivery as every other workspace rule. There is no code-level guarantee an agent obeys them. What they carry is the same imperative phrasing that already makes M9R&rsquo;s own report requirement reliable in practice.
        </p>
        <Button type="button" variant="primary" size="sm" disabled={busy !== null} className="mt-3" onClick={enableStarterRules}>
          {busy === "presets" ? "Creating…" : "Enable starter rules"}
        </Button>
      </div>
      <form onSubmit={submitManual} className="rounded-lg bg-[color:var(--ol-surface-2)] p-3 border border-[color:var(--ol-border-subtle)]">
        <div className="text-[13px] font-semibold text-[color:var(--ol-text-primary)]">Create rule</div>
        <p className="mt-1 text-[12px] leading-relaxed text-[color:var(--ol-text-muted)]">
          Human-written rules are saved as review drafts. Promote a draft to make it available through <Cmd>npx m9r-cli rules</Cmd>.
        </p>
        <label className="mt-3 block text-[10px] uppercase tracking-wide text-[color:var(--ol-text-faint)]">
          Title
          <input
            value={manualTitle}
            onChange={(e) => setManualTitle(e.target.value)}
            className="mt-1 w-full rounded-md border border-[color:var(--ol-border-default)] bg-[color:var(--ol-surface-0)] px-2 py-1.5 text-[13px] normal-case tracking-normal text-[color:var(--ol-text-primary)] outline-none focus:border-[color:var(--ol-accent-border)]"
            required
          />
        </label>
        <label className="mt-2 block text-[10px] uppercase tracking-wide text-[color:var(--ol-text-faint)]">
          Rule text
          <textarea
            value={manualBody}
            onChange={(e) => setManualBody(e.target.value)}
            className="mt-1 min-h-24 w-full resize-y rounded-md border border-[color:var(--ol-border-default)] bg-[color:var(--ol-surface-0)] px-2 py-1.5 text-[13px] normal-case tracking-normal text-[color:var(--ol-text-primary)] outline-none focus:border-[color:var(--ol-accent-border)]"
            required
          />
        </label>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="block text-[10px] uppercase tracking-wide text-[color:var(--ol-text-faint)]">
            Scope/path patterns
            <input
              value={manualScope}
              onChange={(e) => setManualScope(e.target.value)}
              placeholder="src/**, scripts/**"
              className="mt-1 w-full rounded-md border border-[color:var(--ol-border-default)] bg-[color:var(--ol-surface-0)] px-2 py-1.5 text-[13px] normal-case tracking-normal text-[color:var(--ol-text-primary)] outline-none focus:border-[color:var(--ol-accent-border)]"
            />
          </label>
          <label className="block text-[10px] uppercase tracking-wide text-[color:var(--ol-text-faint)]">
            Risk level
            <select
              value={manualRisk}
              onChange={(e) => setManualRisk(e.target.value)}
              className="mt-1 w-full rounded-md border border-[color:var(--ol-border-default)] bg-[color:var(--ol-surface-0)] px-2 py-1.5 text-[13px] normal-case tracking-normal text-[color:var(--ol-text-primary)] outline-none focus:border-[color:var(--ol-accent-border)]"
            >
              <option value="">Not set</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
        </div>
        <Button type="submit" variant="primary" size="sm" disabled={busy !== null} className="mt-3">
          {busy === "manual" ? "Creating…" : "Create draft"}
        </Button>
      </form>

      <form onSubmit={submitImport} className="rounded-lg bg-[color:var(--ol-surface-2)] p-3 border border-[color:var(--ol-border-subtle)]">
        <div className="text-[13px] font-semibold text-[color:var(--ol-text-primary)]">Import rules</div>
        <p className="mt-1 text-[12px] leading-relaxed text-[color:var(--ol-text-muted)]">
          Paste AGENTS.md, CLAUDE.md, Cursor rules, or repo instructions. Imports create review drafts only.
        </p>
        <label className="mt-3 block text-[10px] uppercase tracking-wide text-[color:var(--ol-text-faint)]">
          Source label
          <input
            value={importSource}
            onChange={(e) => setImportSource(e.target.value)}
            className="mt-1 w-full rounded-md border border-[color:var(--ol-border-default)] bg-[color:var(--ol-surface-0)] px-2 py-1.5 text-[13px] normal-case tracking-normal text-[color:var(--ol-text-primary)] outline-none focus:border-[color:var(--ol-accent-border)]"
          />
        </label>
        <label className="mt-2 block text-[10px] uppercase tracking-wide text-[color:var(--ol-text-faint)]">
          Pasted instructions
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            className="mt-1 min-h-32 w-full resize-y rounded-md border border-[color:var(--ol-border-default)] bg-[color:var(--ol-surface-0)] px-2 py-1.5 text-[13px] normal-case tracking-normal text-[color:var(--ol-text-primary)] outline-none focus:border-[color:var(--ol-accent-border)]"
            required
          />
        </label>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="block text-[10px] uppercase tracking-wide text-[color:var(--ol-text-faint)]">
            Scope/path patterns
            <input
              value={importScope}
              onChange={(e) => setImportScope(e.target.value)}
              placeholder="app/**, api/**"
              className="mt-1 w-full rounded-md border border-[color:var(--ol-border-default)] bg-[color:var(--ol-surface-0)] px-2 py-1.5 text-[13px] normal-case tracking-normal text-[color:var(--ol-text-primary)] outline-none focus:border-[color:var(--ol-accent-border)]"
            />
          </label>
          <label className="block text-[10px] uppercase tracking-wide text-[color:var(--ol-text-faint)]">
            Risk level
            <select
              value={importRisk}
              onChange={(e) => setImportRisk(e.target.value)}
              className="mt-1 w-full rounded-md border border-[color:var(--ol-border-default)] bg-[color:var(--ol-surface-0)] px-2 py-1.5 text-[13px] normal-case tracking-normal text-[color:var(--ol-text-primary)] outline-none focus:border-[color:var(--ol-accent-border)]"
            >
              <option value="">Not set</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
        </div>
        <Button type="submit" variant="secondary" size="sm" disabled={busy !== null} className="mt-3">
          {busy === "import" ? "Importing…" : "Import drafts"}
        </Button>
      </form>
      {status && (
        <div
          role={status.tone === "error" ? "alert" : "status"}
          className="lg:col-span-2 rounded-md border px-3 py-2 text-[12px]"
          style={
            status.tone === "ok"
              ? { borderColor: "var(--ol-ok-border)", background: "var(--ol-ok-soft)", color: "var(--ol-ok)" }
              : { borderColor: "var(--ol-danger-border)", background: "var(--ol-danger-soft)", color: "var(--ol-danger)" }
          }
        >
          {status.text}
        </div>
      )}
    </div>
  );
}

function Cmd({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-[color:var(--ol-surface-2)] px-1 py-0.5 font-mono text-[11px] text-[color:var(--ol-text-secondary)]">{children}</code>;
}
