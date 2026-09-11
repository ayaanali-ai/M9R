// Recorder Lite — a small, pure builder for constructing a valid
// runleak.recorded.v0 RecordedCodingSession from EXPLICITLY provided metadata.
//
// STRICT RULES: This helper records only what the caller supplies. It does not
// call any model/provider, does not intercept real calls, does not infer missing
// usage, does not estimate cost from tokens, and never estimates energy or heat.
// The only derivation allowed is totalTokens = inputTokens + outputTokens when
// BOTH are explicitly provided. See docs/claims.md.

import type {
  RecordedCodingSession,
  RecordedModelCall,
  RecordedToolCall,
} from "@/lib/trace-recorder-schema";
import { RECORDED_SCHEMA_VERSION } from "@/lib/trace-recorder-schema";

export class RecordedSessionBuilder {
  private session: RecordedCodingSession;

  constructor(input: {
    runName: string;
    objective: string;
    source?: RecordedCodingSession["source"];
    startedAt?: string;
  }) {
    if (!input.runName || !input.runName.trim()) {
      throw new Error("createRecordedSession: runName is required.");
    }
    if (typeof input.objective !== "string") {
      throw new Error("createRecordedSession: objective must be a string.");
    }
    this.session = {
      schemaVersion: RECORDED_SCHEMA_VERSION,
      runName: input.runName.trim(),
      objective: input.objective,
      source: input.source ?? "manual",
      startedAt: input.startedAt,
      filesChanged: [],
      commandsRun: [],
      modelCalls: [],
      toolCalls: [],
      knownErrors: [],
      notes: [],
    };
  }

  addModelCall(call: RecordedModelCall): this {
    if (!call.id || !call.id.trim()) {
      throw new Error("addModelCall: id is required.");
    }
    // Derive totalTokens ONLY when both input and output are explicit numbers.
    let totalTokens = call.totalTokens ?? null;
    if (
      totalTokens == null &&
      typeof call.inputTokens === "number" &&
      typeof call.outputTokens === "number"
    ) {
      totalTokens = call.inputTokens + call.outputTokens;
    }
    this.session.modelCalls.push({ ...call, totalTokens });
    return this;
  }

  addToolCall(call: RecordedToolCall): this {
    if (!call.id || !call.id.trim()) {
      throw new Error("addToolCall: id is required.");
    }
    if (!call.toolName || !call.toolName.trim()) {
      throw new Error("addToolCall: toolName is required.");
    }
    this.session.toolCalls.push({ ...call });
    return this;
  }

  addFileChanged(path: string): this {
    if (path && path.trim()) this.session.filesChanged.push(path.trim());
    return this;
  }

  addCommandRun(command: string): this {
    if (command && command.trim()) this.session.commandsRun.push(command.trim());
    return this;
  }

  addKnownError(error: string): this {
    if (error && error.trim()) this.session.knownErrors.push(error.trim());
    return this;
  }

  addNote(note: string): this {
    if (note && note.trim()) this.session.notes.push(note.trim());
    return this;
  }

  setBuildResult(result: "pass" | "fail" | "unknown"): this {
    this.session.buildResult = result;
    return this;
  }

  setLintResult(result: "pass" | "fail" | "unknown"): this {
    this.session.lintResult = result;
    return this;
  }

  finish(opts?: { endedAt?: string }): RecordedCodingSession {
    if (opts?.endedAt) this.session.endedAt = opts.endedAt;
    // Return a defensive copy so the builder can't be mutated after finishing.
    return {
      ...this.session,
      filesChanged: [...this.session.filesChanged],
      commandsRun: [...this.session.commandsRun],
      modelCalls: this.session.modelCalls.map((c) => ({ ...c })),
      toolCalls: this.session.toolCalls.map((c) => ({ ...c })),
      knownErrors: [...this.session.knownErrors],
      notes: [...this.session.notes],
    };
  }
}

export function createRecordedSession(input: {
  runName: string;
  objective: string;
  source?: RecordedCodingSession["source"];
  startedAt?: string;
}): RecordedSessionBuilder {
  return new RecordedSessionBuilder(input);
}
