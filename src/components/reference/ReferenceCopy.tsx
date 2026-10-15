"use client";

import { useState } from "react";
import s from "./ReferenceHome.module.css";
import d from "./ReferencePage.module.css";

export default function ReferenceCopy({ command }: { command: string }) {
  const [status, setStatus] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setStatus("Copied");
    } catch {
      setStatus("Select the command to copy it");
    }
  }
  return <div className={d.command}>
    <code>{command}</code>
    <button type="button" className={`${s.ok} ${d.copy}`} onClick={copy} aria-label={`Copy ${command}`}>Copy</button>
    <span className={d.copyStatus} role="status">{status}</span>
  </div>;
}
