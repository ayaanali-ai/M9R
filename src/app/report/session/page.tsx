"use client";

/**
 * Agent session result — web display surface.
 *
 * The smallest real web surface for an agent-session result. A human pastes the
 * JSON returned by POST /api/agent/session (what the CLI prints / the API
 * returns) and sees the result rendered, including Rule Health when the session
 * loaded workspace rules. No live agent token is used here — this renders a
 * returned/stored result, it does not call the Agent Join API.
 *
 * Rule Health is shown only when the response actually carries a `rule_health`
 * object (never faked). When it carries one but `evaluated` is false, the panel
 * shows the honest empty state.
 */

import { useMemo, useState } from "react";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { RuleHealthPanel } from "@/components/report/RuleHealthPanel";
import { parseSessionResultJson } from "@/lib/agent-session-result";

const PLACEHOLDER = `Paste the JSON returned by POST /api/agent/session here.

It looks like:
{
  "ok": true,
  "source_quality": "fair",
  "parser_confidence": { "confidence": "high" },
  "findings_count": 1,
  "rules": { "recommended": false },
  "rule_health": { "evaluated": true, "summary": { ... }, "items": [ ... ] }
}`;

export default function SessionResultPage() {
  const [raw, setRaw] = useState("");
  const parsed = useMemo(() => parseSessionResultJson(raw), [raw]);
  const hasInput = raw.trim().length > 0;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#ededed]">
      <Nav />
      <main className="mx-auto max-w-3xl px-6 pt-24 pb-16">
        <div className="mb-6">
          <div className="mb-2 font-mono text-[11px] uppercase tracking-wider text-lime">
            Agent session result
          </div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Session result viewer</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
            Paste the JSON returned by <code className="text-zinc-300">POST /api/agent/session</code>{" "}
            (the same result the M9R CLI prints). When the session loaded workspace rules, the
            Rule Health panel shows how each one fared.
          </p>
        </div>

        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          spellCheck={false}
          rows={8}
          placeholder={PLACEHOLDER}
          className="w-full rounded-xl border border-zinc-800 bg-black/30 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-zinc-200 outline-none transition-colors placeholder:text-zinc-700 focus:border-zinc-600"
        />

        {hasInput && !parsed && (
          <div className="mt-4 rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2 text-[12px] text-amber-200/90">
            That doesn&apos;t look like a session result. Paste the full JSON response from{" "}
            <code>/api/agent/session</code>.
          </div>
        )}

        {parsed && (
          <div className="mt-6 space-y-5">
            {/* Result summary — the normal session result fields. */}
            <section className="rounded-xl border border-[#222] bg-[#111] p-4">
              <div className="mb-3 text-[11px] font-semibold uppercase tracking-[1px] text-zinc-500">
                Result
              </div>
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-[#222] bg-[#222] sm:grid-cols-4">
                <Stat label="Status" value={parsed.ok ? "ok" : "not ok"} />
                <Stat
                  label="Source quality"
                  value={parsed.sourceQualityLabel ?? parsed.sourceQuality ?? "—"}
                />
                <Stat
                  label="Parser confidence"
                  value={
                    parsed.parserConfidence
                      ? String(parsed.parserConfidence.confidence ?? "—")
                      : "—"
                  }
                />
                <Stat label="Findings" value={String(parsed.findingsCount)} />
              </div>
              <p className="mt-3 text-[12px] leading-relaxed text-zinc-400">
                Rule recommendation:{" "}
                <span className="text-zinc-200">
                  {parsed.rules?.recommended ? "recommended" : "none"}
                </span>
                {parsed.rules?.message ? `: ${parsed.rules.message}` : ""}
              </p>
              {parsed.nextStep && (
                <p className="mt-2 text-[12px] leading-relaxed text-zinc-500">{parsed.nextStep}</p>
              )}
            </section>

            {/* Rule Health — only rendered when the response carries one. */}
            {parsed.ruleHealth && <RuleHealthPanel ruleHealth={parsed.ruleHealth} />}
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[#0d0d0d] px-3 py-2.5">
      <div className="text-base font-semibold text-zinc-100">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
    </div>
  );
}
