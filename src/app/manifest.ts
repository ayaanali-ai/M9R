import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "M9R",
    short_name: "M9R",
    description: "A shared workspace where humans and coding agents work together.",
    start_url: "/dashboard/agents",
    scope: "/",
    display: "standalone",
    background_color: "#0d1117",
    theme_color: "#0d1117",
    orientation: "any",
    icons: [
      {
        src: "/oathlock-logo-transparent.png",
        sizes: "1360x1360",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
