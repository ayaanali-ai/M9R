type WebAction = "open" | "read" | "click" | "type";

export interface WebAuthorityCliRequest {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
  confirmation?: string;
}

export interface WebAuthorityCliDeps {
  port: number;
  key: string;
  fetch: typeof fetch;
  out(line: string): void;
  err(line: string): void;
  canApprove: boolean;
  confirm?(question: string): Promise<boolean>;
}

function durationMs(value: string): number | null {
  const match = /^(\d{1,4})(m|h|d)$/i.exec(value.trim());
  if (!match) return null;
  const multiplier = match[2].toLowerCase() === "m" ? 60_000 : match[2].toLowerCase() === "h" ? 3_600_000 : 86_400_000;
  const result = Number(match[1]) * multiplier;
  return Number.isSafeInteger(result) && result > 0 && result <= 8 * 60 * 60_000 ? result : null;
}

export function buildWebAuthorityCliRequest(args: string[]): { ok: true; request: WebAuthorityCliRequest } | { ok: false; error: string } {
  const [command, ...rest] = args;
  if (command === "pending" || command === "grants") {
    if (rest.length) return { ok: false, error: `Usage: m9r-cli web ${command}` };
    return { ok: true, request: { method: "GET", path: `/web/${command}` } };
  }
  if (command === "audit") {
    const verify = rest.length === 1 && rest[0] === "--verify";
    if (rest.length && !verify) return { ok: false, error: "Usage: m9r-cli web audit [--verify]" };
    return { ok: true, request: { method: "GET", path: `/web/audit${verify ? "?verify=1" : ""}` } };
  }
  if (command === "revoke-all") {
    if (rest.length) return { ok: false, error: "Usage: m9r-cli web revoke-all" };
    return { ok: true, request: { method: "POST", path: "/web/revoke-all", body: {} } };
  }
  if (command === "deny" || command === "revoke") {
    const [id, ...extra] = rest;
    if (!id || extra.length) return { ok: false, error: `Usage: m9r-cli web ${command} <id>` };
    return { ok: true, request: { method: "POST", path: `/web/${command}`, body: { id } } };
  }
  if (command === "approve") {
    const [id, ...flags] = rest;
    if (!id) return { ok: false, error: "Usage: m9r-cli web approve <id> [--actions read,click] [--ttl 30m] [--max-uses n]" };
    const body: Record<string, unknown> = { id };
    for (let i = 0; i < flags.length; i += 1) {
      const flag = flags[i];
      const value = flags[i + 1];
      if ((flag !== "--actions" && flag !== "--ttl" && flag !== "--max-uses") || !value) {
        return { ok: false, error: "Usage: m9r-cli web approve <id> [--actions read,click] [--ttl 30m] [--max-uses n]" };
      }
      i += 1;
      if (flag === "--actions") {
        const actions = value.split(",").map((action) => action.trim());
        if (!actions.length || actions.some((action) => !["open", "read", "click", "type"].includes(action))) {
          return { ok: false, error: "--actions must be a comma-separated list of open,read,click,type" };
        }
        body.actions = [...new Set(actions as WebAction[])];
      } else if (flag === "--ttl") {
        const ttlMs = durationMs(value);
        if (!ttlMs) return { ok: false, error: "--ttl must be between 1 minute and 8 hours (for example 30m or 2h)" };
        body.ttlMs = ttlMs;
      } else {
        const maxUses = Number(value);
        if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1_000_000) return { ok: false, error: "--max-uses must be a positive integer" };
        body.maxUses = maxUses;
      }
    }
    return { ok: true, request: { method: "POST", path: "/web/approve", body, confirmation: `Approve web access request ${id}?` } };
  }
  return { ok: false, error: "Usage: m9r-cli web <pending|approve|deny|grants|revoke|revoke-all|audit> ..." };
}

export async function runWebAuthorityCli(args: string[], deps: WebAuthorityCliDeps): Promise<number> {
  const built = buildWebAuthorityCliRequest(args);
  if (!built.ok) { deps.err(built.error); return 1; }
  if (built.request.confirmation) {
    if (!deps.canApprove) { deps.err("Approving web access requires an interactive human terminal with no agent markers."); return 1; }
    if (!deps.confirm || !(await deps.confirm(built.request.confirmation))) { deps.out("Nothing was changed."); return 1; }
  }

  try {
    const response = await deps.fetch(`http://127.0.0.1:${deps.port}${built.request.path}`, {
      method: built.request.method,
      headers: { "x-m9r-key": deps.key, ...(built.request.body ? { "content-type": "application/json" } : {}) },
      ...(built.request.body ? { body: JSON.stringify(built.request.body) } : {}),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
      deps.err(`M9R web authority request failed: ${message}`);
      return 1;
    }
    deps.out(JSON.stringify(body, null, 2));
    return 0;
  } catch {
    deps.err("M9R web broker is not reachable on the configured loopback port.");
    return 1;
  }
}
