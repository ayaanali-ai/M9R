import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalStore } from "@/lib/native/local-store";
import { createM9rMcpServer } from "@/lib/native/mcp-server";
import { createWebBrokerClient } from "@/lib/native/web-broker-client";
import { brokerKeyPath } from "@/lib/native/web-broker-paths";
import { loadOrCreateBrokerKey, startWebBroker } from "@/lib/native/web-broker-server";
import type { TaskName } from "./bench-data";
import { startBenchSite } from "./bench-site";
import { startCdpDriver } from "./cdp-driver";
import { CONDITIONS, createBoard, runStrategy, type Condition, type WebApi } from "./strategies";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type ToolServer = { _registeredTools: Record<string, { handler: (args: unknown) => Promise<ToolResult> }> };

export interface RunResult {
  task: TaskName;
  condition: Condition;
  seed: number;
  correct: boolean;
  wallMs: number | null;
  toolCalls: number;
  pageLoads: number;
  error?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Runs every task x condition with scripted agents through the real M9R browser tools and a real headless browser.
 * thinkMs is a fixed pause before each agent step, standing in for model latency. Nothing here calls a model.
 */
export async function runScripted(options: { seeds?: number[]; thinkMs?: number; tasks?: TaskName[] } = {}): Promise<RunResult[]> {
  const seeds = options.seeds ?? [1];
  const thinkMs = options.thinkMs ?? 150;
  const tasks = options.tasks ?? ["trip", "search"];

  const root = mkdtempSync(join(tmpdir(), "m9r-bench-run-"));
  const key = loadOrCreateBrokerKey(brokerKeyPath(root));
  const broker = await startWebBroker({ key, port: 0, timeoutMs: 30_000, allowAnyExtension: true });
  const store = createLocalStore(root);
  const server = createM9rMcpServer({ store, web: createWebBrokerClient({ keyPath: brokerKeyPath(root), port: broker.port }) });
  const call = (name: string, args: Record<string, unknown>) => (server as unknown as ToolServer)._registeredTools[name].handler(args);
  const driver = await startCdpDriver({ brokerPort: broker.port });
  const handles = [
    ["claude", "claude-code"],
    ["codex", "codex"],
    ["opencode", "opencode"],
  ] as const;
  const tokens = handles.map(([handle, provider], i) => store.issueIdentity(handle, provider, `bench-${i}`).token);
  const results: RunResult[] = [];

  try {
    for (const seed of seeds) {
      const site = await startBenchSite({ seed });
      try {
        for (const task of tasks) {
          for (const condition of CONDITIONS) {
            site.reset();
            let toolCalls = 0;
            const api = (token: string): WebApi => {
              const run = async (name: string, args: Record<string, unknown>) => {
                toolCalls++;
                await sleep(thinkMs);
                const result = await call(name, { token, ...args });
                if (result.isError) throw new Error(result.content[0].text);
                return result.content[0].text;
              };
              return {
                open: async (url) => void (await run("m9r_web_open", { url })),
                read: (selector) => run("m9r_web_read", { selector }),
                type: async (selector, text) => void (await run("m9r_web_type", { selector, text })),
                click: async (selector) => void (await run("m9r_web_click", { selector })),
              };
            };

            let error: string | undefined;
            try {
              await withTimeout(
                runStrategy(task, condition, { url: site.url, agents: [api(tokens[0]), api(tokens[1]), api(tokens[2])], board: createBoard() }),
                120_000,
                `${task}/${condition}`,
              );
              for (let i = 0; i < 100 && site.submissions().length === 0; i++) await sleep(50);
            } catch (caught) {
              error = caught instanceof Error ? caught.message : String(caught);
            }
            const submission = site.submissions().find((s) => s.task === task);
            results.push({
              task,
              condition,
              seed,
              correct: submission?.score.allCorrect ?? false,
              wallMs: submission?.at ?? null,
              toolCalls,
              pageLoads: site.loads().length,
              error,
            });
          }
        }
      } finally {
        await site.close();
      }
    }
  } finally {
    await driver.close();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
  return results;
}
