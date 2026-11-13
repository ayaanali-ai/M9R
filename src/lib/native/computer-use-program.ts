import * as vm from "node:vm";

/**
 * Broker-owned program execution for computer-use plans.
 *
 * The program never receives a process, filesystem, network, or native handle.
 * It can only call the two capability-scoped functions supplied by the broker:
 * observe() and act(). Every call is therefore re-authorized by the normal M9R
 * identity, target, lease, and operation-receipt path.
 */
export interface ComputerUseProgramApi {
  observe(input: Record<string, unknown>): Promise<unknown>;
  act(input: Record<string, unknown>): Promise<unknown>;
  sleep(ms: number): Promise<void>;
}

export interface ComputerUseProgramInput {
  code: string;
  timeoutMs?: number;
  maxCalls?: number;
}

export interface ComputerUseProgramResult {
  value: unknown;
  calls: number;
  elapsedMs: number;
}

const MAX_PROGRAM_LENGTH = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CALLS = 128;
const MAX_MAX_CALLS = 512;

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`Program value must be an integer from 1 to ${max}.`);
  }
  return value;
}

function serializable(value: unknown): unknown {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || encoded.length > 2 * 1024 * 1024) throw new Error("Program result is not serializable or is too large.");
    return JSON.parse(encoded) as unknown;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Program result is not serializable.");
  }
}

export async function runComputerUseProgram(input: ComputerUseProgramInput, api: ComputerUseProgramApi): Promise<ComputerUseProgramResult> {
  if (typeof input.code !== "string" || input.code.trim().length === 0) throw new Error("Program code is required.");
  if (input.code.length > MAX_PROGRAM_LENGTH) throw new Error(`Program code exceeds the ${MAX_PROGRAM_LENGTH}-character limit.`);
  const timeoutMs = boundedInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxCalls = boundedInteger(input.maxCalls, DEFAULT_MAX_CALLS, MAX_MAX_CALLS);
  let calls = 0;
  let timedOut = false;
  const started = Date.now();
  const count = () => {
    // Once the host has given up waiting and returned a timeout to its
    // caller, the script's own async IIFE keeps running underneath (vm's
    // `timeout` option only bounds synchronous execution, not awaited work;
    // Promise.race below never cancels the losing promise). Refusing every
    // further capability call here is what actually stops it from sending
    // more desktop input or re-resolving stage revisions after its caller
    // has moved on to recovery.
    if (timedOut) throw new Error(`Program timed out after ${timeoutMs}ms; no further m9r calls are honored.`);
    calls += 1;
    if (calls > maxCalls) throw new Error(`Program call budget exceeded (${maxCalls}).`);
  };
  const exposed: ComputerUseProgramApi = Object.freeze({
    observe: async (value: Record<string, unknown>) => { count(); return api.observe(value); },
    act: async (value: Record<string, unknown>) => { count(); return api.act(value); },
    sleep: async (ms: number) => {
      count();
      if (!Number.isSafeInteger(ms) || ms < 0 || ms > 10_000) throw new Error("Program sleep must be an integer from 0 to 10000.");
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
    },
  });
  const sandbox: Record<string, unknown> = {
    m9r: exposed,
    // Explicitly shadow ambient Node globals. The capability object above is
    // the only supported way to touch the computer.
    process: undefined,
    require: undefined,
    module: undefined,
    exports: undefined,
    Buffer: undefined,
    fetch: undefined,
    WebAssembly: undefined,
    console: Object.freeze({ log() {}, warn() {}, error() {} }),
  };
  vm.createContext(sandbox, { name: "m9r-computer-program" });
  const script = new vm.Script(`(async () => {\n${input.code}\n})()`, { filename: "m9r-program" });
  const promise = script.runInContext(sandbox, { timeout: timeoutMs }) as Promise<unknown>;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`Program timed out after ${timeoutMs}ms.`)), timeoutMs);
  });
  // The script's own IIFE rejection is handled below (or, on a timeout,
  // never awaited at all) -- give it an immediate catch so an eventual
  // rejection from the still-running script never surfaces as an unhandled
  // promise rejection in this process.
  promise.catch(() => {});
  let value: unknown;
  try {
    value = await Promise.race([promise, timeoutPromise]);
  } catch (error) {
    if (error instanceof Error && error.message === `Program timed out after ${timeoutMs}ms.`) timedOut = true;
    // A rejection from the sandboxed script carries an Error constructed in
    // the vm context's own realm, so `error instanceof Error` is false for
    // it in this (host) realm -- duck-type the message instead of losing it
    // to a generic fallback.
    const message = error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : "The program threw a non-Error value.";
    throw new Error(message);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
  return { value: serializable(value), calls, elapsedMs: Math.max(0, Date.now() - started) };
}

export const COMPUTER_USE_PROGRAM_LIMITS = Object.freeze({
  maxProgramLength: MAX_PROGRAM_LENGTH,
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  maxTimeoutMs: MAX_TIMEOUT_MS,
  defaultMaxCalls: DEFAULT_MAX_CALLS,
  maxMaxCalls: MAX_MAX_CALLS,
});
