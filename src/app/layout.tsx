import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Fraunces, Hanken_Grotesk, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import AmbientBackground from "@/components/AmbientBackground";
import PwaRuntime from "@/components/PwaRuntime";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "") || "https://m9r.vercel.app";
const title = "M9R — Your agents work together now";
const description =
  "M9R is the shared workspace where Claude Code and Codex work the same repo together, aware of each other's edits in real time, and build memory the whole team carries forward.";
// A real screenshot of the actual light-theme homepage (headline, copy,
// the shader star mark), cropped/resized to the standard 1200x630 OG
// size -- replaces the old pre-rebrand "OathLock" asset. A generated
// (next/og ImageResponse) version was tried first but couldn't reproduce
// the real page's serif headline rendering or the WebGL shader mark, so
// a real capture is the actual right call here over a re-drawn one.
const ogImage = `${siteUrl}/og-v2.png`;

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Marketing 4-role type system (locked after studying the closest direct
// comp's own layered approach -- real distinct faces per role, not one
// face wearing different weights). Fraunces for headlines: a characterful
// serif with real personality, distinct from the rejected Instrument Serif
// test. Hanken Grotesk for body prose. IBM Plex Sans for UI/nav chrome,
// pairing naturally with the IBM Plex Mono already used for code.
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
});

const hankenGrotesk = Hanken_Grotesk({
  variable: "--font-hanken-grotesk",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const ibmPlexSans = IBM_Plex_Sans({
  variable: "--font-ibm-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

// Mono for data/labels (ids, timestamps, token counts, CLI blocks) -- swapped
// off Geist Mono specifically because Geist Sans + Geist Mono together is the
// single most recognizable "shipped from a Next.js template" signature right
// now. IBM Plex Mono keeps the same technical, legible register.
const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
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
        width: 1200,
        height: 630,
        alt: "M9R — Your agents work together now",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [ogImage],
    creator: "@m9rdev",
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
      className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} ${hankenGrotesk.variable} ${ibmPlexSans.variable} ${ibmPlexMono.variable} h-full antialiased`}
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
