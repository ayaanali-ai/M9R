import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { redactSession } from "@/lib/session-redaction";
import { humanizeEnumLabel } from "@/lib/format-enum-label";

import { AGENT_KIND_SLUG_PATTERN } from "@/lib/agent-join";
import { providerLabel } from "@/lib/provider-adapter-config";

export type ResidentActivityProvider = string;
export type ResidentActivityKind = "started" | "output" | "completed" | "failed" | "cancelled";

export interface ResidentActivityEvent {
  protocolVersion: "oathlock.resident-activity.v1";
  grantId: string;
  provider: ResidentActivityProvider;
  kind: ResidentActivityKind;
  occurredAt: string;
  sequence: number;
  stream?: "stdout" | "stderr" | "system";
  data?: string;
  status?: string;
}

const MAX_EVENT_DATA_BYTES = 64 * 1024;

export function residentActivityJournalPath(repositoryRoot: string): string {
  return join(resolve(repositoryRoot), ".oathlock", "runtime", "resident-activity.jsonl");
}

function boundedText(value: string, maxBytes = MAX_EVENT_DATA_BYTES): string {
  const redacted = redactSession(value).redactedText.replace(/\u0000/g, "");
  const bytes = Buffer.from(redacted, "utf8");
  return bytes.length <= maxBytes ? redacted : bytes.subarray(bytes.length - maxBytes).toString("utf8");
}

function normalizeEvent(event: ResidentActivityEvent): ResidentActivityEvent {
  if (!/^[a-zA-Z0-9._:-]{8,100}$/.test(event.grantId)) throw new Error("Resident activity grant id is invalid.");
  if (!AGENT_KIND_SLUG_PATTERN.test(event.provider)) throw new Error("Resident activity provider is invalid.");
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new Error("Resident activity sequence is invalid.");
  if (!Number.isFinite(Date.parse(event.occurredAt))) throw new Error("Resident activity timestamp is invalid.");
  return {
    protocolVersion: "oathlock.resident-activity.v1",
    grantId: event.grantId,
    provider: event.provider,
    kind: event.kind,
    occurredAt: event.occurredAt,
    sequence: event.sequence,
    ...(event.stream ? { stream: event.stream } : {}),
    ...(event.data ? { data: boundedText(event.data) } : {}),
    ...(event.status ? { status: boundedText(event.status, 200) } : {}),
  };
}

export function parseResidentActivityLine(line: string): ResidentActivityEvent | null {
  try {
    const parsed = JSON.parse(line) as ResidentActivityEvent;
    if (parsed.protocolVersion !== "oathlock.resident-activity.v1") return null;
    return normalizeEvent(parsed);
  } catch {
    return null;
  }
}

/**
 * Convert provider stream-json into content-free local activity. Raw provider
 * chunks can contain source, prompts, or credentials split across chunk
 * boundaries, so the durable journal records lifecycle/tool categories only.
 */
export function summarizeResidentProviderLine(provider: ResidentActivityProvider, stream: "stdout" | "stderr", line: string): string | null {
  const normalized = line.trim();
  if (!normalized) return null;
  if (stream === "stderr") return `Provider diagnostic: ${boundedText(normalized, 500)}\r\n`;
  try {
    const event = JSON.parse(normalized) as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "activity";
    const item = event.item && typeof event.item === "object" && !Array.isArray(event.item)
      ? event.item as Record<string, unknown>
      : null;
    const itemType = typeof item?.type === "string" ? humanizeEnumLabel(item.type) : null;
  const label = providerLabel(provider);
    if (type === "result" || type === "turn.completed") return `${label} returned a structured result.\r\n`;
    if (type === "item.started" || type === "item.completed") {
      return `${label} ${itemType ?? "tool activity"} ${type.endsWith("started") ? "started" : "completed"}.\r\n`;
    }
    if (type === "assistant") return `${label} produced an assistant update.\r\n`;
    if (type === "system") return `${label} session initialized.\r\n`;
    return `${label} · ${humanizeEnumLabel(type)}\r\n`;
  } catch {
    return null;
  }
}

export function createResidentActivityWriter(repositoryRoot: string): {
  publish(event: ResidentActivityEvent): void;
  flush(): Promise<void>;
} {
  const path = residentActivityJournalPath(repositoryRoot);
  let pending = Promise.resolve();

  const publish = (event: ResidentActivityEvent) => {
    const line = `${JSON.stringify(normalizeEvent(event))}\n`;
    pending = pending.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, line, "utf8");
    });
  };

  return { publish, flush: () => pending };
}
