"use client";

/**
 * AccountMenu — the top-right avatar with a Grok/Linear-style popup.
 * ----------------------------------------------------------------------------
 * Click the avatar to open a mini menu: who you're signed in as, quick links to
 * Profile / Settings / Workspaces, and Log out. Closes on click-outside or Esc.
 */

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { usePopover } from "@/components/product/usePopover";
import { createClient } from "@/lib/supabase/browser";

export default function AccountMenu({ email, userId }: { email: string; userId: string }) {
  const router = useRouter();
  const { open, setOpen, ref } = usePopover<HTMLDivElement>();
  const [signingOut, setSigningOut] = useState(false);
  const initial = email.trim().charAt(0).toUpperCase() || "O";

  async function signOut() {
    setSigningOut(true);
    await createClient()?.auth.signOut();
    router.replace("/");
    router.refresh();
  }

  return (
    <div className="account-menu-wrap" ref={ref}>
      <button
        type="button"
        className="topbar-avatar"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen((v) => !v)}
      >
        {initial}
      </button>

      {open && (
        <div className="popover-menu account-popover" role="menu">
          {/* Identity header */}
          <div className="flex items-center gap-2.5 px-3 py-2.5">
            <span className="account-popover-avatar">{initial}</span>
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-[color:var(--ol-text-primary)]">{email}</div>
              <div className="truncate font-mono text-[9px] text-[color:var(--ol-text-faint)]">{userId.slice(0, 18)}…</div>
            </div>
          </div>

          <div className="popover-divider" />

          <MenuLink href="/dashboard/settings" label="Profile" onClick={() => setOpen(false)} icon="user" />
          <MenuLink href="/dashboard/settings" label="Settings" onClick={() => setOpen(false)} icon="settings" />
          <MenuLink href="/dashboard/projects" label="Workspaces" onClick={() => setOpen(false)} icon="grid" />

          <div className="popover-divider" />

          <button type="button" className="popover-item text-[color:var(--ol-text-secondary)]" onClick={signOut} disabled={signingOut}>
            <span className="popover-item-glyph" aria-hidden>
              {signingOut ? (
                <span className="product-mini-loader" />
              ) : (
                <svg viewBox="0 0 16 16" fill="none">
                  <path d="M6 3H3.5v10H6M9 5l3 3-3 3M5 8h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </span>
            {signingOut ? "Signing out…" : "Log out"}
          </button>
        </div>
      )}
    </div>
  );
}

function MenuLink({
  href,
  label,
  icon,
  onClick,
}: {
  href: string;
  label: string;
  icon: "user" | "settings" | "grid";
  onClick: () => void;
}) {
  const paths = {
    user: <><circle cx="8" cy="5.5" r="2.5" /><path d="M3.5 13c.6-2.3 2.4-3.5 4.5-3.5s3.9 1.2 4.5 3.5" /></>,
    settings: <><circle cx="8" cy="8" r="2" /><path d="M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M3.8 3.8l1 1M11.2 11.2l1 1M12.2 3.8l-1 1M4.8 11.2l-1 1" /></>,
    grid: <><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" /></>,
  };
  return (
    <Link href={href} role="menuitem" className="popover-item text-[color:var(--ol-text-secondary)]" onClick={onClick}>
      <span className="popover-item-glyph" aria-hidden>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
          {paths[icon]}
        </svg>
      </span>
      {label}
    </Link>
  );
}
