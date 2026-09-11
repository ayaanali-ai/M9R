"use client";

import Link from "next/link";
import M9RMark from "@/components/M9RMark";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/browser";

/* -------------------------------------------------------------------------- */
/* Primary navigation links                                                   */
/* -------------------------------------------------------------------------- */

const links = [
  // "Agents" is the flagship surface — the rule-quality loop starts here, so it
  // gets the featured chip treatment below.
  { href: "/agents", label: "Agents" },
  { href: "/security", label: "Security" },
  { href: "/pricing", label: "Pricing" },
];

export default function Nav() {
  const pathname = usePathname();

  // Reflect the signed-in session in the nav. Uses the same @supabase/ssr
  // browser client (cookie-backed) the server reads, so client and server agree.
  // `undefined` = still resolving (avoid flashing the wrong CTA on first paint).
  const [signedIn, setSignedIn] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let active = true;
    const supabase = createClient();
    if (!supabase) {
      // Resolve asynchronously (not a synchronous setState in the effect body)
      // so the nav settles to "signed out" right after mount, same as below.
      Promise.resolve().then(() => {
        if (active) setSignedIn(false);
      });
      return () => {
        active = false;
      };
    }
    supabase.auth.getUser().then(({ data }) => {
      if (active) setSignedIn(Boolean(data.user));
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSignedIn(Boolean(session?.user));
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  return (
    <nav className="lp-header">
      <div className="lp-wrap lp-header-in">
        <Link href="/" className="lp-brand">
          <M9RMark animated={false} className="lp-brand-mark" />
          M9R
        </Link>

        <div className="flex items-center gap-4">
          <div className="lp-nav">
            {links.map((link) => {
              const active = pathname === link.href;
              if (link.href === "/agents") {
                return (
                  <Link key={link.href} href={link.href} className="lp-nav-chip">
                    {link.label}
                  </Link>
                );
              }
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  style={active ? { color: "var(--lp-ink)" } : undefined}
                >
                  {link.label}
                </Link>
              );
            })}
          </div>

          <Link href={signedIn ? "/dashboard" : "/auth"} className="lp-btn lp-btn-ghost lp-btn-sm">
            Enter workspace →
          </Link>
        </div>
      </div>
    </nav>
  );
}
