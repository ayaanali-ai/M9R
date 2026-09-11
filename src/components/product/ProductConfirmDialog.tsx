"use client";

import { useEffect, useId, useRef } from "react";
import { Button } from "@/components/product/WorkspaceUI";

export default function ProductConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busy = false,
  tone = "danger",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  tone?: "danger" | "secondary";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    confirmRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onCancel();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previousActiveElement?.focus();
    };
  }, [busy, onCancel, open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close confirmation"
        className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-[2px]"
        onClick={busy ? undefined : onCancel}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="ol-elevated relative w-full max-w-md p-5 shadow-2xl"
      >
        <div className="ol-plate-label">Confirm action</div>
        <h2 id={titleId} className="mt-2 text-base font-semibold text-[color:var(--ol-text-primary)]">
          {title}
        </h2>
        <p id={descriptionId} className="mt-2 text-[12px] leading-relaxed text-[color:var(--ol-text-muted)]">
          {description}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <button
            ref={confirmRef}
            type="button"
            className={`ol-btn ol-btn--${tone}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Working" : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
