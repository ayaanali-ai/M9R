"use client";

import { createBrowserClient } from "@supabase/ssr";
import { getSupabasePublicConfig } from "@/lib/supabase/config";

export function createClient() {
  const config = getSupabasePublicConfig();

  if (!config) return null;
  return createBrowserClient(config.url, config.publishableKey);
}
