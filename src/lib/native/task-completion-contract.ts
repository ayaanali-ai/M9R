import { z } from "zod";

export const taskCompletionReportSchema = z.object({
  status: z.enum(["completed", "incomplete"]),
  remainingWork: z.array(z.string().trim().min(1).max(1_000)).max(32).default([]),
}).strict().refine((report) => report.status !== "completed" || report.remainingWork.length === 0,
  "Completed work cannot have remaining requirements.");
export type TaskCompletionReport = z.infer<typeof taskCompletionReportSchema>;

/** Older adapters report plain text. An explicit admission of unfinished work
 * must never become a completed task just because the provider turn ended. */
export function taskCompletionReport(summary: string, report?: TaskCompletionReport): TaskCompletionReport {
  const parsed = report ? taskCompletionReportSchema.parse(report) : undefined;
  if (parsed) return parsed;
  const incomplete = /\b(?:task (?:is |remains )?(?:incomplete|unfinished)|not (?:yet )?completed|could(?:n't| not) (?:finish|complete|verify|access)|(?:unable|not able) to (?:finish|complete|verify|access)|blocked (?:by|on|because)|still (?:need|needs|have) to)\b/i.test(summary)
    || /(?:^|\n)\s*remaining work:/i.test(summary);
  if (incomplete) return {
    status: "incomplete", remainingWork: [summary.slice(0, 1_000)],
  };
  return {
    status: "incomplete",
    remainingWork: ["No structured completion report was received. Verify the remaining requirements and report through m9r_result."],
  };
}
