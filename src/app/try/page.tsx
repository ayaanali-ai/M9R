import type { Metadata } from "next";
import TryDemo from "@/components/reference/TryDemo";

export const metadata: Metadata = { title: "M9R — Animated preview", description: "An illustrative animation of the M9R multiplayer-computer concept; not a live agent session." };

export default function TryPage() {
  return <TryDemo />;
}
