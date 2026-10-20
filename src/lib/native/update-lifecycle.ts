import { evaluateUpdate, verifyUpdateManifest, type EngineUpdateManifest } from "./engine-update-core";
import { createInitialUpdateState, reduceUpdateState, type UpdateState } from "./update-lifecycle-core";

export interface UpdateSource {
  manifestUrl: string;
  signatureUrl: string;
  /** Public verification key only; never place a signing key in the client. */
  publicKeyPem: string;
}

export interface PersistedUpdateConfig {
  schemaVersion: 1;
  currentVersion: string;
  source: UpdateSource;
}

export interface UpdateFetchResponse {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export type UpdateFetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<UpdateFetchResponse>;

export interface CheckEngineUpdateOptions {
  currentVersion: string;
  source: UpdateSource;
  fetcher?: UpdateFetcher;
  nowMs?: number;
}

export interface CheckEngineUpdateResult {
  state: UpdateState;
  manifest?: EngineUpdateManifest;
}

function assertHttpsUrl(value: string, name: string): void {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${name} is not a valid URL`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) throw new Error(`${name} must be an HTTPS URL without credentials or fragments`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseUpdateConfig(value: unknown): PersistedUpdateConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("update config must be an object");
  const data = value as Record<string, unknown>;
  const source = data.source;
  if (data.schemaVersion !== 1 || typeof data.currentVersion !== "string" || !source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("update config schema is invalid");
  }
  const parsedSource = source as Record<string, unknown>;
  if (typeof parsedSource.manifestUrl !== "string" || typeof parsedSource.signatureUrl !== "string" || typeof parsedSource.publicKeyPem !== "string") {
    throw new Error("update source configuration is incomplete");
  }
  return {
    schemaVersion: 1,
    currentVersion: data.currentVersion,
    source: {
      manifestUrl: parsedSource.manifestUrl,
      signatureUrl: parsedSource.signatureUrl,
      publicKeyPem: parsedSource.publicKeyPem,
    },
  };
}

/**
 * Fetch and authenticate the release metadata. This is intentionally check-only:
 * the future updater owns download/apply/rollback, while the pill can consume
 * this same honest state contract without ever treating a network response as
 * an installed runtime.
 */
export async function checkEngineUpdate(options: CheckEngineUpdateOptions): Promise<CheckEngineUpdateResult> {
  const at = options.nowMs ?? Date.now();
  let state = createInitialUpdateState(options.currentVersion);
  state = reduceUpdateState(state, { type: "check_started", at });
  try {
    assertHttpsUrl(options.source.manifestUrl, "manifest URL");
    assertHttpsUrl(options.source.signatureUrl, "signature URL");
    if (!options.source.publicKeyPem.trim()) throw new Error("update public key is missing");
    const fetcher = options.fetcher ?? (globalThis.fetch as unknown as UpdateFetcher);
    const manifestResponse = await fetcher(options.source.manifestUrl, { signal: AbortSignal.timeout(10_000) });
    if (!manifestResponse.ok) throw new Error(`manifest request failed (${manifestResponse.status})`);
    const raw = Buffer.from(await manifestResponse.arrayBuffer());
    const signatureResponse = await fetcher(options.source.signatureUrl, { signal: AbortSignal.timeout(10_000) });
    if (!signatureResponse.ok) throw new Error(`signature request failed (${signatureResponse.status})`);
    const signature = (await signatureResponse.text()).trim();
    const verified = verifyUpdateManifest(raw, signature, options.source.publicKeyPem);
    if (!verified.ok) throw new Error(`manifest verification failed: ${verified.error}`);
    const decision = evaluateUpdate(options.currentVersion, verified.manifest);
    state = decision.kind === "available"
      ? reduceUpdateState(state, { type: "update_available", at, version: decision.availableVersion })
      : reduceUpdateState(state, { type: "up_to_date", at });
    return { state, manifest: verified.manifest };
  } catch (error) {
    return { state: reduceUpdateState(state, { type: "check_failed", at, error: errorText(error) }) };
  }
}
