/** OpenCode occasionally exits a resumed JSON run without emitting its final text; recover only a completed reply to the latest user message. */
export async function recoverOpenCodeAnswer(url: string, password: string, sessionId: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  if (!/^ses[_-][A-Za-z0-9_-]{1,100}$/.test(sessionId)) return null;
  try {
    const response = await fetcher(`${url}/session/${encodeURIComponent(sessionId)}/message?limit=10`, {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return null;
    const data = await response.json() as unknown;
    if (!Array.isArray(data)) return null;

    let latestUserIndex = -1;
    for (let i = 0; i < data.length; i += 1) {
      const message = data[i] as { info?: { role?: unknown } } | null;
      if (message?.info?.role === "user") latestUserIndex = i;
    }
    if (latestUserIndex < 0) return null;

    for (let i = data.length - 1; i > latestUserIndex; i -= 1) {
      const message = data[i] as { info?: { role?: unknown; time?: { completed?: unknown }; error?: unknown }; parts?: unknown } | null;
      if (message?.info?.role !== "assistant") continue;
      // A message without `time.completed` is still streaming. Returning its current text can make an intermediate
      // status look like the final answer; looking before the latest user message can instead return stale prior-turn text.
      if (!Number.isFinite(message.info.time?.completed) || message.info.error != null || !Array.isArray(message.parts)) return null;
      const text = message.parts.filter((part: unknown): part is { type: "text"; text: string } =>
        !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
        .map((part) => part.text).join("\n").trim();
      return text ? text.slice(0, 12_000) : null;
    }
  } catch { /* backend died or returned a malformed response */ }
  return null;
}
