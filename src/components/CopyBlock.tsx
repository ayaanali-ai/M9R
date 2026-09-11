"use client";

import { useState } from "react";

/**
 * CopyBlock — a monospace code block with a one-click copy button. Used on
 * /agents for the pasteable agent instruction and curl commands.
 */
export default function CopyBlock({
  text,
  label = "Copy",
  className = "",
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked; the text is selectable as a fallback.
    }
  }

  return (
    <div className={`relative rounded-md border border-[var(--lp-hair-strong)] bg-[var(--lp-panel)] ${className}`}>
      <pre className="overflow-x-auto px-4 py-3.5 pr-20 font-mono text-[13px] leading-relaxed text-[var(--lp-text)] whitespace-pre-wrap break-words">
        {text}
      </pre>
      <button
        type="button"
        onClick={copy}
        className="absolute right-2.5 top-2.5 rounded border border-[var(--lp-hair-strong)] bg-[var(--lp-panel-2)] px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-[var(--lp-steel)] transition-colors hover:border-[var(--lp-oxblood-lit)]/60 hover:text-[var(--lp-oxblood-lit)]"
      >
        {copied ? "Copied" : label}
      </button>
    </div>
  );
}
