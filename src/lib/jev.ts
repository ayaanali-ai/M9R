/**
 * Jev (TypeSafe System One) access for server-side judgment calls.
 *
 * Jev returns typed probabilities, never text and never authority. Everything here
 * follows three rules from the master plan (A.10):
 *   1. It can only ever produce a probability/choice; deterministic code applies any threshold.
 *   2. It never throws into the caller. A slow, failing or unconfigured Jev is "no judgment".
 *   3. It is off unless explicitly enabled (M9R_JEV_MODE), and the API key stays server-side.
 */
import { TypeSafeClient, type EntryType, type Questions, type SystemOneResult } from "@typesafe-ai/sdk";

export type JevMode = "off" | "mock" | "shadow";

/** `shadow` needs a key; without one it degrades to `off` instead of failing requests. */
export function jevMode(env: Record<string, string | undefined> = process.env): JevMode {
  const raw = env.M9R_JEV_MODE?.trim().toLowerCase();
  if (raw === "mock") return "mock";
  if (raw === "shadow" && env.TYPESAFE_API_KEY?.trim()) return "shadow";
  return "off";
}

/** Requests are bounded hard: a judgment that arrives late is worth nothing on a live message path. */
export const JEV_TIMEOUT_MS = 2_500;

export interface JevJudgment<Q extends Questions> {
  answers: SystemOneResult<Q>["answers"];
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export type JevTransport = <const Q extends Questions>(request: { state: EntryType; questions: Q }, options: { timeout: number; signal?: AbortSignal }) => Promise<SystemOneResult<Q>>;

/**
 * Deterministic, network-free stand-in for local development and tests: noul answers 0.9 when the
 * state text reads like a request and 0.1 otherwise; choice answers its first option. It exists to
 * exercise the plumbing, not to approximate Jev's judgment.
 */
export const mockJevTransport: JevTransport = async (request) => {
  const text = JSON.stringify(request.state).toLowerCase();
  const looksLikeRequest = /\b(please|can you|could you|fix|add|write|implement|review|investigate|run|update|refactor|why)\b/.test(text);
  const answers: Record<string, unknown> = {};
  for (const [name, question] of Object.entries(request.questions)) {
    if (question.type === "noul") answers[name] = { type: "noul", noul: looksLikeRequest ? 0.9 : 0.1 };
    else if (question.type === "choice") {
      const labels = Object.keys(question.criteria ?? {});
      const chosen = labels[0] ?? "none";
      answers[name] = { type: "choice", choice: chosen, confidence: 1, probabilities: Object.fromEntries(labels.map((label) => [label, label === chosen ? 1 : 0])) };
    }
  }
  return { model: "jev-mock", answers, usage: { input_tokens: 0, output_tokens: 0 } } as never;
};

let sharedClient: TypeSafeClient | null = null;

function realTransport(): JevTransport {
  sharedClient ??= new TypeSafeClient({ retry: { maxRetries: 0 } });
  const client = sharedClient;
  return (request, options) => client.systemOne(request, { timeout: options.timeout, signal: options.signal });
}

/**
 * Ask Jev independent questions over one shared state (they run in parallel server-side).
 * Returns null on any failure, timeout or when disabled; callers must treat null as "unknown".
 * `transport` exists for tests; production uses the SDK client.
 */
export async function jevJudge<const Q extends Questions>(
  state: EntryType,
  questions: Q,
  options: { transport?: JevTransport; timeoutMs?: number; mode?: JevMode } = {},
): Promise<JevJudgment<Q> | null> {
  const mode = options.mode ?? jevMode();
  if (mode === "off") return null;
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? JEV_TIMEOUT_MS;
  try {
    const transport = options.transport ?? (mode === "mock" ? mockJevTransport : realTransport());
    const result = await transport({ state, questions }, { timeout: timeoutMs, signal: AbortSignal.timeout(timeoutMs + 500) });
    return {
      answers: result.answers,
      model: result.model,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
      latencyMs: Date.now() - started,
    };
  } catch {
    // Deliberately no error text: a failed request may echo state, and the state can contain message bodies.
    return null;
  }
}
