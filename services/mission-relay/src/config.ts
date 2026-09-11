export interface MissionRelayRuntimeConfig {
  host: string;
  port: number;
  publicUrl: string | null;
  tokenSecret: string;
}

const MIN_SECRET_LENGTH = 32;

export function readMissionRelayConfig(env: Readonly<Record<string, string | undefined>> = process.env): MissionRelayRuntimeConfig {
  const tokenSecret = env.MISSION_RELAY_TOKEN_SECRET?.trim() ?? "";
  if (tokenSecret.length < MIN_SECRET_LENGTH) throw new Error("Mission Relay token secret must be at least 32 characters.");
  if (!env.NEXT_PUBLIC_SUPABASE_URL?.trim()) throw new Error("Mission Relay Supabase URL is missing.");
  if (!env.SUPABASE_SERVICE_ROLE_KEY?.trim()) throw new Error("Mission Relay Supabase service role key is missing.");
  const port = Number(env.MISSION_RELAY_PORT ?? env.PORT ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Mission Relay port is invalid.");
  const host = env.MISSION_RELAY_HOST?.trim() || "0.0.0.0";
  const publicUrl = env.MISSION_RELAY_PUBLIC_URL?.trim() || null;
  return { host, port, publicUrl, tokenSecret };
}
