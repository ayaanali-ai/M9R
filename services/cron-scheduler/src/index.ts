import type { ExportedHandler } from "@cloudflare/workers-types";

export interface Env {
  /** Public HTTPS origin of the deployed Next/OpenNext application. */
  TARGET_BASE_URL: string;
  /** Same value as the m9r-web CRON_SECRET Worker secret. */
  CRON_SECRET: string;
  /** Explicit emergency gate for pausing Cloudflare sweeps without changing triggers. */
  SCHEDULER_ENABLED?: string;
}

export const CRON_JOBS = {
  "0 3 * * *": { name: "work-signal-sweep", path: "/api/internal/work-signal-sweep" },
  "15 3 * * *": { name: "stale-run-sweep", path: "/api/internal/stale-run-sweep" },
  "30 3 * * *": { name: "workflow-scheduler", path: "/api/internal/workflow-scheduler" },
  "*/15 * * * *": { name: "idle-session-sweep", path: "/api/internal/idle-session-sweep" },
} as const;

export type CronExpression = keyof typeof CRON_JOBS;
export type CronJob = (typeof CRON_JOBS)[CronExpression];
export type SchedulerFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function targetOrigin(env: Env): string {
  const raw = env.TARGET_BASE_URL?.trim();
  if (!raw) throw new Error("TARGET_BASE_URL is required.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("TARGET_BASE_URL must be an absolute HTTPS URL.");
  }
  const localHttp = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  const productionHost = url.protocol === "https:" && (url.hostname === "m9r.dev" || url.hostname === "www.m9r.dev");
  if (!productionHost && !localHttp) throw new Error("TARGET_BASE_URL must be https://m9r.dev, https://www.m9r.dev, or a local HTTP test target.");
  return url.toString().replace(/\/$/, "");
}

function cronJob(cron: string): CronJob {
  const job = Object.prototype.hasOwnProperty.call(CRON_JOBS, cron)
    ? CRON_JOBS[cron as CronExpression]
    : undefined;
  if (!job) throw new Error(`No scheduler job is mapped for cron expression ${cron}.`);
  return job;
}

export function jobForCron(cron: string): CronJob {
  return cronJob(cron);
}

export function schedulerEnabled(env: Pick<Env, "SCHEDULER_ENABLED">): boolean {
  return env.SCHEDULER_ENABLED?.trim().toLowerCase() === "true";
}

export async function runCronJob(
  cron: string,
  env: Env,
  fetcher: SchedulerFetch = fetch,
): Promise<{ name: string; path: string; status: number }> {
  const job = cronJob(cron);
  const secret = env.CRON_SECRET?.trim();
  if (!secret) throw new Error("CRON_SECRET is required.");

  const response = await fetcher(`${targetOrigin(env)}${job.path}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${secret}`,
      "user-agent": "m9r-cron-scheduler/1",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`${job.name} returned HTTP ${response.status}.`);
  }
  return { name: job.name, path: job.path, status: response.status };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

const handler: ExportedHandler<Env> = {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "m9r-cron-scheduler" });
    }
    return json({ error: "Not found." }, 404);
  },

  async scheduled(controller, env): Promise<void> {
    const job = jobForCron(controller.cron);
    if (!schedulerEnabled(env)) {
      console.log(`[m9r-cron-scheduler] ${job.name} is disabled by SCHEDULER_ENABLED.`);
      return;
    }
    try {
      const result = await runCronJob(controller.cron, env);
      console.log(`[m9r-cron-scheduler] ${result.name} completed with HTTP ${result.status}.`);
    } catch (error) {
      console.error(`[m9r-cron-scheduler] ${job.name} failed.`, error instanceof Error ? error.message : "unknown error");
      throw error;
    }
  },
};

export default handler;
