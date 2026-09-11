"use client";

import { useEffect, useState } from "react";
import M9RLiquidMark from "@/components/M9RLiquidMark";

const STORAGE_KEY = "m9r_mark_tint";
const DEFAULT_TINT = "#c99bff";

const SWATCHES = [
  { label: "Violet", value: "#c99bff" },
  { label: "Amber", value: "#f0a860" },
  { label: "Rust", value: "#d9704a" },
  { label: "Jade", value: "#7fd9b0" },
  { label: "Steel", value: "#9bb0d9" },
];

/**
 * Wraps M9RLiquidMark with a per-viewer tint the shader effect itself
 * doesn't change -- only its colorTint value moves. Persists to
 * localStorage so the choice survives refresh/reboot on this machine, per
 * viewer (not synced anywhere, same tradeoff as the theme toggle).
 */
export default function M9RPersonalMark({
  width = 320,
  height = 320,
}: {
  width?: number;
  height?: number;
}) {
  const [tint, setTint] = useState(DEFAULT_TINT);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      // This effect hydrates browser-only preference state after SSR.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved) setTint(saved);
    } catch {}
  }, []);

  function pick(value: string) {
    setTint(value);
    setOpen(false);
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {}
  }

  return (
    <div className="lp-mark-personalize">
      <M9RLiquidMark width={width} height={height} colorTint={tint} />
      <button
        type="button"
        className="lp-mark-personalize-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Customize mark color"
      >
        <span style={{ background: tint }} />
      </button>
      {open && (
        <div className="lp-mark-personalize-menu" role="menu">
          {SWATCHES.map((s) => (
            <button
              key={s.value}
              type="button"
              role="menuitem"
              className="lp-mark-swatch"
              onClick={() => pick(s.value)}
              aria-label={s.label}
              title={s.label}
            >
              <span style={{ background: s.value }} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
