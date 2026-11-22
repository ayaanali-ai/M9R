import ReferenceHome from "@/components/reference/ReferenceHome";
import { getSupabasePublicConfig } from "@/lib/supabase/config";

export default async function Home({ searchParams }: { searchParams: Promise<{ invite?: string | string[]; waitlist?: string | string[] }> }) {
  const params = await searchParams;
  const invite = Array.isArray(params.invite) ? params.invite[0] : params.invite;
  const token = invite?.trim() || null;
  const openWaitlist = (Array.isArray(params.waitlist) ? params.waitlist[0] : params.waitlist) !== undefined;
  return <ReferenceHome configured={Boolean(getSupabasePublicConfig())} authNext={token ? `/invite/${encodeURIComponent(token)}` : undefined} openWaitlist={openWaitlist} />;
}
