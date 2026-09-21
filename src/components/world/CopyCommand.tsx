"use client";

import { useState } from "react";
import s from "./World.module.css";

export default function CopyCommand({ command }: { command: string }) {
  const [status, setStatus] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setStatus("Copied");
    } catch {
      setStatus("Select the command to copy manually.");
    }
  }
  return <div className={s.command}><code>{command}</code><button type="button" onClick={copy} aria-label={`Copy ${command}`}>Copy ↗</button><span className={s.copyStatus} role="status">{status}</span></div>;
}
