import { createServer } from "node:http";
import { generateBench, renderPage, scoreAnswer, type Answer, type BenchData, type Score, type TaskName } from "./bench-data";

export interface PageLoad {
  at: number;
  path: string;
}

export interface Submission {
  at: number;
  task: TaskName;
  answer: Answer;
  score: Score;
}

/** Serves the benchmark pages on loopback, counts page loads, and records the submitted answer with its score. */
export async function startBenchSite(options: { seed?: number; port?: number } = {}) {
  const seed = options.seed ?? 1;
  const data: BenchData = generateBench(seed);
  let startedAt = Date.now();
  let loads: PageLoad[] = [];
  let submissions: Submission[] = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "POST" && url.pathname === "/__answer") {
      const task = url.searchParams.get("task");
      if (task !== "trip" && task !== "search") {
        res.writeHead(400).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        let answer: Answer = {};
        try {
          answer = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Answer;
        } catch {
          // an unreadable answer is recorded as empty and scores as wrong
        }
        submissions.push({ at: Date.now() - startedAt, task, answer, score: scoreAnswer(task, data, answer) });
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      });
      return;
    }

    const html = req.method === "GET" ? renderPage(data, url.pathname) : null;
    if (html === null) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    loads.push({ at: Date.now() - startedAt, path: url.pathname });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (options.port ?? 0);

  return {
    port,
    seed,
    data,
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    loads: () => [...loads],
    submissions: () => [...submissions],
    reset() {
      startedAt = Date.now();
      loads = [];
      submissions = [];
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
