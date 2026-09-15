"use client";

import Overlay from "./Overlay";
import styles from "./InfoPanel.module.css";

/**
 * Placeholder shell -- rides the same rise-from-bottom Overlay as Sign in.
 * Real tier/price content should move here from /pricing once this becomes
 * the only entry point (route is left in place for now as a fallback).
 */
export default function PricingPanel({ onClose }: { onClose: () => void }) {
  return (
    <Overlay label="Pricing" onClose={onClose}>
      <div className={styles.panel}>
        <span className={styles.mark} aria-hidden="true">$</span>
        <h2 className={styles.heading}>Pricing</h2>
        <p className={styles.body}>
          Full plan details live at <code>/pricing</code> today -- this panel is the
          new home for that content, in progress.
        </p>
      </div>
    </Overlay>
  );
}
