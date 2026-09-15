import UseM9RHome from "@/components/home/UseM9RHome";
import { getSupabasePublicConfig } from "@/lib/supabase/config";

export default function Home() {
  return <UseM9RHome configured={Boolean(getSupabasePublicConfig())} />;
}
