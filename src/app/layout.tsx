import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import AmbientBackground from "@/components/AmbientBackground";
import PwaRuntime from "@/components/PwaRuntime";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "") || "https://m9r.dev";
const title = "M9R — The air between agents";
const description =
  "Agents don’t need another home. M9R connects the agents you already use without replacing their environments.";
// A real screenshot of the current live homepage (recaptured 2026-10-04 after the
// rooms-pivot copy changes; the previous og-v2.png predated them and showed stale nav
// text). A generated (next/og ImageResponse) version was tried first but couldn't
// reproduce the real page's serif headline rendering or the WebGL shader mark, so a
// real capture is the actual right call here over a re-drawn one.
// Filename bumped to v3 (not just a content swap at the old og-v2.png URL): X/Twitter's card image cache is keyed by
// URL and held an image from well before today's changes even after a forced re-scrape confirmed the page's own
// metadata was current -- a URL it has never seen gets a genuinely fresh fetch instead of depending on it noticing
// the old URL's bytes changed.
const ogImage = `${siteUrl}/og-v3.png`;

// Stand-in for Agrandir (a licensed Pangram Pangram face -- no free/Google
// distribution) on the homepage's bold headline. Unbounded is the closest
// free geometric-display match; swap in real Agrandir woff2 files via
// next/font/local once licensed, same --font-headline variable name.
const headlineFont = localFont({
  variable: "--font-headline",
  src: [
    { path: "../../public/m9r-condensed-light.ttf", weight: "200", style: "normal" },
    { path: "../../public/m9r-condensed-medium.ttf", weight: "500", style: "normal" },
  ],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title,
  description,
  openGraph: {
    title,
    description,
    type: "website",
    url: siteUrl,
    siteName: "M9R",
    images: [
      {
        url: ogImage,
        width: 1896,
        height: 862,
        alt: "M9R — Your agents work together now",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [ogImage],
    creator: "@useM9R",
  },
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "M9R",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#141414",
};

/**
 * Sets [data-theme] before first paint so there's no flash of the wrong
 * theme. Saved choice (oathlock:theme = "light" | "dark") wins; with no
 * saved choice, defaults to light -- explicit product decision (light is
 * the primary, dark is the opt-in), not a system-preference mirror.
 */
const THEME_BOOT_SCRIPT = `(function(){try{var s=localStorage.getItem("oathlock:theme");var t=s==="light"||s==="dark"?s:"light";document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${headlineFont.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="relative min-h-full flex flex-col bg-[color:var(--ol-surface-0)] text-[color:var(--ol-text-primary)]">
        {/* Quiet, serious motion behind everything. */}
        <AmbientBackground />
        <PwaRuntime />
        {children}
      </body>
    </html>
  );
}
