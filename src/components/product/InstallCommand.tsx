"use client";

import { useState } from "react";

const DEFAULT_COMMAND = "npx m9r-cli init";

/**
 * A real, click-to-copy command, matching the pattern the closest direct
 * comp leads with instead of burying setup in a later section. Command name
 * stays `oathlock` deliberately -- the CLI binary/package itself is a
 * separate, much larger rename than the marketing surface, not in scope for
 * this pass. Reused on /agents for the other real commands (doctor, etc),
 * not just the install line.
 */
export default function InstallCommand({ className = "", command = DEFAULT_COMMAND }: { className?: string; command?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can fail silently (permissions, insecure context);
      // the command is still selectable text, so nothing else to do here.
    }
  }

  return (
    <button type="button" className={`lp-min-install ${className}`.trim()} onClick={copy}>
      <span className="lp-min-install-prompt">$</span>
      <code>{command}</code>
      <span className="lp-min-install-copy">{copied ? "copied" : "copy"}</span>
    </button>
  );
}
