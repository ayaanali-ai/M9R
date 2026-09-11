import { PageHeader } from "@/components/product/WorkspaceUI";
import SettingsView from "@/components/product/SettingsView";
import { createClient } from "@/lib/supabase/server";

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = supabase ? await supabase.auth.getUser() : { data: { user: null } };
  const { data: identity } = user && supabase
    ? await supabase.from("users").select("username").eq("id", user.id).maybeSingle()
    : { data: null };
  const username = (identity?.username as string | null) ??
    (user?.user_metadata?.username as string | undefined) ?? null;

  return (
    <>
      <PageHeader
        eyebrow="Registry"
        title="Settings"
        description="Account, billing, data, and preferences."
      />
      <div className="mt-7">
        <SettingsView email={user?.email ?? "—"} userId={user?.id ?? "—"} username={username} />
      </div>
    </>
  );
}
