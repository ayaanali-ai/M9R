"use client";

import Overlay from "./Overlay";
import styles from "./InfoPanel.module.css";

/** Placeholder shell -- see PricingPanel for the migration note. */
export default function MemoPanel({ onClose }: { onClose: () => void }) {
  return (
    <Overlay label="Memo" onClose={onClose}>
      <div className={styles.panel}>
        <span className={styles.mark} aria-hidden="true">✎</span>
        <h2 className={styles.heading}>Memo</h2>
        <p className={styles.body}>
          The full memo lives at <code>/memo</code> today -- this panel is the new
          home for that content, in progress.
        </p>
      </div>
    </Overlay>
  );
}
