import { choice } from "@typesafe-ai/sdk";
import { jevJudge, type JevMode, type JevTransport } from "@/lib/jev";

export interface JevControlCandidate { ref: string; role: string; name: string; position: number }
export interface JevControlSpikeResult {
  status: "measured" | "unavailable";
  selectedRef: string | null;
  expectedRef: string;
  correct: boolean | null;
  latencyMs: number | null;
  model: string | null;
}

/** Measurement-only Jev spike. It does not dispatch browser actions or influence stable-ref resolution. */
export async function measureJevControlSelection(input: {
  pageText: string;
  controls: JevControlCandidate[];
  expectedRef: string;
  mode?: JevMode;
  transport?: JevTransport;
  timeoutMs?: number;
}): Promise<JevControlSpikeResult> {
  const labels = input.controls.slice(0, 150).map((control) => control.ref);
  const criteria: Record<string, string> = Object.fromEntries(input.controls.slice(0, 150).map((control) => [control.ref, `${control.role} named ${control.name} at visible position ${control.position}.`]).concat([["none", "No listed control matches the requested target."]]))
  const controls = input.controls.slice(0, 150).map((control) => ({
    ref: control.ref,
    role: control.role,
    name: control.name,
    position: control.position,
  }));
  const judgment = await jevJudge(
    { page_text: input.pageText.slice(0, 4_000), controls },
    { target: choice("Which listed control matches the task target? Choose by role, accessible name, and visible position.", criteria) },
    { mode: input.mode ?? "off", transport: input.transport, timeoutMs: input.timeoutMs ?? 200 },
  );
  if (!judgment) return { status: "unavailable", selectedRef: null, expectedRef: input.expectedRef, correct: null, latencyMs: null, model: null };
  const selected = typeof judgment.answers.target.choice === "string" && labels.includes(judgment.answers.target.choice) ? judgment.answers.target.choice : null;
  return { status: "measured", selectedRef: selected, expectedRef: input.expectedRef, correct: selected === input.expectedRef, latencyMs: judgment.latencyMs, model: judgment.model };
}
