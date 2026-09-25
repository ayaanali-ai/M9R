import type { NextConfig } from "next";
import path from "path";
import { missionRelayConnectSource } from "./src/lib/mission-relay-csp";

// Development may attach directly to the loopback runtime. Production embeds
// the runtime-owned provider workspace instead, so hosted JavaScript never
// receives the shell WebSocket or terminal input.
const localRuntimeConnectSources = " ws://127.0.0.1:43117 ws://localhost:43117";
const localRuntimeFrameSources = " http://127.0.0.1:43117 http://localhost:43117";
const configuredMissionRelaySource = missionRelayConnectSource(process.env.MISSION_RELAY_PUBLIC_URL);
const missionRelayConnectSources = configuredMissionRelaySource ? ` ${configuredMissionRelaySource}` : "";

const isCloudflareBuild = process.env.CLOUDFLARE_BUILD === "true";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  typescript: {
    ignoreBuildErrors: isCloudflareBuild,
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "monaco-editor/editor/editor.api": path.resolve(__dirname, "node_modules/monaco-editor/esm/vs/editor/editor.api.js"),
    };
    return config;
  },
  async rewrites() {
    return [{ source: "/try", destination: "/try/index.html" }];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "object-src 'none'",
              `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'"}`,
              "script-src-attr 'none'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self'",
              `connect-src 'self' https://eymtshaxpkmojsggdtkh.supabase.co${missionRelayConnectSources}${localRuntimeConnectSources}`,
              `frame-src 'self'${localRuntimeFrameSources}`,
              "worker-src 'self' blob:",
              "manifest-src 'self'",
              "frame-ancestors 'none'",
              "form-action 'self'",
              "base-uri 'self'",
            ].join("; "),
          },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
      {
        // Real, live-caught bug: the global Cross-Origin-Resource-Policy:
        // same-origin above is correct for the app itself, but it also
        // applied to the one asset that MUST be loadable cross-origin by
        // definition -- the link-preview image every external crawler
        // (Twitterbot, Slack, iMessage) has to fetch from its own origin to
        // render a card at all. Confirmed directly: the image loaded fine
        // from this app's own origin (curl, browser) but rendered as a
        // broken image inside a real X compose-box card, and same-origin
        // CORP is exactly the header that blocks a cross-origin embed like
        // that. Overrides back to cross-origin for just this one file.
        source: "/og-v2.png",
        headers: [{ key: "Cross-Origin-Resource-Policy", value: "cross-origin" }],
      },
    ];
  },
};

export default nextConfig;
