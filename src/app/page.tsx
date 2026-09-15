import UseM9RHome from "@/components/home/UseM9RHome";
import { getSupabasePublicConfig } from "@/lib/supabase/config";

export default async function Home({ searchParams }: { searchParams: Promise<{ invite?: string | string[] }> }) {
  const params = await searchParams;
  const invite = Array.isArray(params.invite) ? params.invite[0] : params.invite;
  const token = invite?.trim() || null;
  return (
    <UseM9RHome
      configured={Boolean(getSupabasePublicConfig())}
      initialPanel={token ? "signup" : null}
      authNext={token ? `/invite/${encodeURIComponent(token)}` : undefined}
    />
  );
}
