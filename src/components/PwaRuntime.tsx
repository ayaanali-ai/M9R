"use client";

import { useEffect } from "react";

/**
 * Progressive enhancement only: the dashboard remains a normal web app when
 * service workers are unavailable, while install/offline/push-capable browsers
 * get one same-origin worker with an explicit update policy.
 */
export default function PwaRuntime() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    void navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch(() => {
        // A blocked worker must never make the dashboard unusable.
      });
  }, []);

  return null;
}
