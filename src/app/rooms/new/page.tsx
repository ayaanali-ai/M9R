"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { ensureGuestSession } from "@/lib/rooms/ensure-guest-session";

/**
 * Functional only, no design pass yet. No signup wall: creating a room mints the
 * same silent anonymous session a guest gets when opening a room link (matches the
 * product's zero-friction stance -- signup only becomes real once hosting moves to a
 * persistent/paid cloud room, a later step, not this one).
 */
export default function NewRoomPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      const supabase = createClient();
      if (!supabase) { setError("Supabase is not configured."); return; }
      const guest = await ensureGuestSession(supabase);
      if (!guest.ok) { setError(`Could not start a session: ${guest.error}`); return; }
      setReady(true);
    })();
  }, []);

  async function createRoom() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await response.json().catch(() => ({})) as { room?: { id: string }; error?: string };
      if (!response.ok || !data.room) { setError(data.error ?? "Could not create the room."); return; }
      router.push(`/rooms/${data.room.id}`);
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!ready && !error) return <p style={{ padding: 24 }}>Loading…</p>;

  return (
    <div style={{ maxWidth: 480, margin: "48px auto", padding: 24 }}>
      <h1>Create a room</h1>
      <p>Anyone with the link can ask to join with no account. You admit them.</p>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Room name"
        maxLength={80}
        disabled={busy || !ready}
        style={{ width: "100%", padding: 8, marginTop: 12 }}
        onKeyDown={(e) => { if (e.key === "Enter") void createRoom(); }}
      />
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      <button onClick={() => void createRoom()} disabled={busy || !ready || !name.trim()} style={{ marginTop: 12, padding: "8px 16px" }}>
        {busy ? "Creating…" : "Create a room"}
      </button>
    </div>
  );
}
