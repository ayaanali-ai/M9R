"use client";

import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import { MetalFx } from "metal-fx";

type MetalSendButtonProps = {
  children: ReactNode;
  theme?: "light" | "dark" | "auto";
};

let clientReady = false;
function subscribe(listener: () => void) {
  const frame = requestAnimationFrame(() => { clientReady = true; listener(); });
  return () => cancelAnimationFrame(frame);
}

/** Defers WebGL feature detection until after hydration. metal-fx intentionally
 * renders a plain child when WebGL2 is unavailable, but its capability check
 * otherwise makes the server and browser trees differ on first paint. */
export default function MetalSendButton({ children, theme = "auto" }: MetalSendButtonProps) {
  const getSnapshot = useCallback(() => clientReady, []);
  const ready = useSyncExternalStore(subscribe, getSnapshot, () => false);
  return <div className="m9r-metal-send">
    {children}
    {ready && <MetalFx className="m9r-metal-send__effect" preset="silver" variant="circle" theme={theme} strength={0.8} innerShadow normalizeHostStyles={false}><span aria-hidden="true" /></MetalFx>}
  </div>;
}
