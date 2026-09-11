import Link from "next/link";

/**
 * BackLink — a small, consistent back-navigation affordance.
 *
 * Used on standalone entry pages (auth, upload, uploaded report) so users
 * always have a calm, obvious way back to where they came from. Styling and
 * the hover micro-motion live in `.back-link` (globals.css) so every instance
 * looks and feels identical.
 */
export default function BackLink({
  href,
  label = "Back",
  className = "",
}: {
  href: string;
  label?: string;
  className?: string;
}) {
  return (
    <Link href={href} className={`back-link ${className}`}>
      <svg viewBox="0 0 12 12" fill="none" aria-hidden>
        <path d="M7.5 2.5 4 6l3.5 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {label}
    </Link>
  );
}
