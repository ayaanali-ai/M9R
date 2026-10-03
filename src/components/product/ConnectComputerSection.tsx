"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/product/WorkspaceUI";

interface Token { id: string; label: string; createdAt: string; lastUsedAt: string | null }

/**
 * Joins a computer's agents to the team's saved memory. A personal token is created here once and pasted into the
 * computer with `m9r cloud connect`; its agents then see the notes the team saved, and notes saved there appear here.
 */
export default function ConnectComputerSection() {
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/dashboard/settings/api-tokens", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not load your computers.");
      setTokens(data.tokens ?? []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load your computers."); }
  }, []);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  async function create() {
    setBusy(true); setError(null); setCopied(false);
    try {
      const response = await fetch("/api/dashboard/settings/api-tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "A computer" }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not create the token.");
      setFresh(data.token.token);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create the token."); }
    finally { setBusy(false); }
  }

  async function revoke(id: string) {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/dashboard/settings/api-tokens?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not turn that off.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not turn that off."); }
    finally { setBusy(false); }
  }

  // The installed program lives in the user's .m9r folder and is not on PATH, so the Windows command uses its full path.
  const windowsCommand = fresh ? String.raw`& "$env:USERPROFILE\.m9r\bin\m9r-engine.exe" cloud connect ` + fresh : "";
  const command = fresh ? `m9r cloud connect ${fresh}` : "";
  return (
    <section className="ol-panel p-4" aria-labelledby="connect-computer-title">
      <h2 id="connect-computer-title" className="text-base font-semibold">Connect a computer to team memory</h2>
      <p className="mt-1 text-sm">Agents on a connected computer see the notes your team saved, and notes saved there show up here. Create a token, then run the command on that computer once.</p>
      {error && <p role="alert" className="mt-2 text-sm">{error}</p>}
      {fresh && (
        <div className="mt-3">
          <p className="text-xs">Copy this now. It is shown only once.</p>
          <p className="mt-2 text-xs">Windows (PowerShell):</p>
          <code className="ol-mono mt-1 block break-all rounded border border-[color:var(--ol-border-subtle)] p-2 text-[12px]">{windowsCommand}</code>
          <Button variant="secondary" size="sm" onClick={() => { void navigator.clipboard?.writeText(windowsCommand).then(() => setCopied(true), () => setError("Could not copy. Select the command and copy it.")); }}>{copied ? "Copied" : "Copy command"}</Button>
          <p className="mt-3 text-xs">If <code>m9r</code> is on your PATH, this works too:</p>
          <code className="ol-mono mt-1 block break-all rounded border border-[color:var(--ol-border-subtle)] p-2 text-[12px]">{command}</code>
        </div>
      )}
      <div className="mt-3"><Button variant="primary" size="sm" disabled={busy} onClick={() => void create()}>Create a token</Button></div>
      {tokens && tokens.length > 0 && (
        <ul className="mt-3 space-y-2">
          {tokens.map((token) => (
            <li key={token.id} className="flex items-center justify-between gap-3 text-sm">
              <span>{token.label} · made {new Date(token.createdAt).toLocaleDateString()} · {token.lastUsedAt ? `last used ${new Date(token.lastUsedAt).toLocaleDateString()}` : "not used yet"}</span>
              <Button variant="danger" size="sm" disabled={busy} onClick={() => void revoke(token.id)}>Turn off</Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
