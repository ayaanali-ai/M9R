"use client";

import { useEffect } from "react";

/**
 * WatchfloorModeScript — restores the persisted Watchfloor mode (day/night)
 * with zero flash, using the Next.js 16 supported pre-hydration pattern
 * (docs: preventing-flash-before-hydration).
 *
 * Two paths, one storage key:
 *  - Hard navigation: the inline script runs synchronously during HTML
 *    parsing, before first paint — Night Watch users never see a bone flash.
 *    The server renders type "text/javascript"; the client renders
 *    "text/plain" so React never warns about a rendered script tag, and
 *    suppressHydrationWarning absorbs the deliberate type mismatch.
 *  - Soft navigation (<Link> into /dashboard): inline scripts inserted via
 *    RSC payload never execute, so useEffect applies the stored mode on
 *    mount. A same-frame effect is acceptable here: soft navigations paint
 *    from an already-themed document, so there is no flash to prevent.
 */

const STORAGE_KEY = "m9r_mode";

const PRE_PAINT_SCRIPT =
  `try{var m=localStorage.getItem("${STORAGE_KEY}");` +
  `if(m==="night"||m==="day"){var r=document.querySelector(".wf-root");` +
  `if(r)r.setAttribute("data-bs-mode",m);}}catch(e){}`;

export default function WatchfloorModeScript() {
  useEffect(() => {
    try {
      const mode = localStorage.getItem(STORAGE_KEY);
      if (mode !== "night" && mode !== "day") return;
      document.querySelector(".wf-root")?.setAttribute("data-bs-mode", mode);
    } catch {
      /* storage unavailable — keep the server default */
    }
  }, []);

  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: PRE_PAINT_SCRIPT }}
    />
  );
}
