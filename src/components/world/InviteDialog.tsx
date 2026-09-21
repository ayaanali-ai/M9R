"use client";
import M9RAuthTerminal from "@/components/product/M9RAuthTerminal";

export default function InviteDialog({ configured, next }: { configured: boolean; next: string }) {
  return <M9RAuthTerminal configured={configured} initialMode="signup" next={next} showTerminal={false} autoOpen />;
}
