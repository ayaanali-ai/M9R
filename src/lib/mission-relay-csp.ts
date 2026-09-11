const RELAY_PROTOCOLS = new Map([
  ["ws:", "ws:"],
  ["wss:", "wss:"],
  ["http:", "ws:"],
  ["https:", "wss:"],
]);

/**
 * Convert the configured Relay URL into a CSP-safe WebSocket origin.
 *
 * CSP must receive an origin, not a path or arbitrary environment text. HTTP
 * URLs are accepted as a convenience for Render configuration and upgraded to
 * their secure WebSocket equivalent.
 */
export function missionRelayConnectSource(rawUrl: string | null | undefined): string | null {
  const raw = rawUrl?.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    const protocol = RELAY_PROTOCOLS.get(url.protocol);
    if (
      !protocol ||
      !url.hostname ||
      url.username ||
      url.password ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.search ||
      url.hash
    ) {
      return null;
    }

    return `${protocol}//${url.host}`;
  } catch {
    return null;
  }
}
