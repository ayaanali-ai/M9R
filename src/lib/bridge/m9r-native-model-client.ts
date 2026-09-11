/**
 * Item #32, phase 1 (extended): the minimal real proof that M9R's own
 * harness can talk directly to a model provider through the AI SDK, using a
 * workspace's own stored credential -- no OpenRouter, no Vercel AI Gateway,
 * nothing in the request path but M9R's own code and the provider's real
 * API. Provider resolution is catalog-driven (see
 * m9r-native-agent-loop.ts's `resolveModelForTurn` -- one real
 * implementation, not a second copy); this file is a thin, tool-free entry
 * point for a single completion.
 */
import { streamText } from "ai";
import { resolveModelForTurn } from "@/lib/bridge/m9r-native-agent-loop";

export interface M9rNativeStreamResult {
  textStream: AsyncIterable<string>;
}

/**
 * Streams a single real completion using this workspace's own stored key
 * for whichever provider the real catalog says serves this model. Throws a
 * clear, specific error if no credential is stored -- never silently falls
 * back to any shared/M9R-held key, since that would silently spend against
 * the wrong account.
 */
export async function streamNativeCompletion(input: {
  workspaceId: string;
  model: string;
  system?: string;
  prompt: string;
}): Promise<M9rNativeStreamResult> {
  const languageModel = await resolveModelForTurn(input.workspaceId, input.model);
  const result = streamText({
    model: languageModel,
    ...(input.system ? { system: input.system } : {}),
    prompt: input.prompt,
  });
  return { textStream: result.textStream };
}
