#!/usr/bin/env node
/**
 * OathLock Gate 9 — reliability/load probe.
 * ----------------------------------------------------------------------------
 * A standalone script (no new dependencies) that fires concurrent, real
 * requests at a live OathLock endpoint and reports measured latency
 * percentiles and success/failure counts. It proves nothing by existing —
 * only by being run and read. This file makes NO network call on its own; it
 * requires an explicit --token and --base, and defaults to localhost so it
 * never accidentally targets production.
 *
 * Usage:
 *   node scripts/reliability-load-test.mjs \
 *     --base http://localhost:3000 \
 *     --token oak_xxx \
 *     --endpoint /api/agent/rules \
 *     --concurrency 10 \
 *     --requests 100
 *
 * This is a read against /api/agent/rules by default — safe to repeat, no
 * durable writes. Pass --endpoint /api/agent/signals --method POST --body '...'
 * to load-test a write path instead, but do that deliberately: it will create
 * real rows in whatever database --base points to.
 */

import { pathToFileURL } from "node:url";

export function parseArgs(argv) {
  const out = { base: "http://localhost:3000", endpoint: "/api/agent/rules", method: "GET", concurrency: 10, requests: 100, body: null, token: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") out.base = argv[++i];
    else if (a === "--endpoint") out.endpoint = argv[++i];
    else if (a === "--method") out.method = argv[++i];
    else if (a === "--concurrency") out.concurrency = Number(argv[++i]);
    else if (a === "--requests") out.requests = Number(argv[++i]);
    else if (a === "--body") out.body = argv[++i];
    else if (a === "--token") out.token = argv[++i];
  }
  return out;
}

export function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function fireOne(url, method, token, body) {
  const start = performance.now();
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ?? undefined,
    });
    const elapsed = performance.now() - start;
    return { ok: res.ok, status: res.status, elapsed };
  } catch (e) {
    return { ok: false, status: 0, elapsed: performance.now() - start, error: e instanceof Error ? e.message : String(e) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.token) {
    console.error("Refusing to run without --token — an authenticated probe against an unauthenticated endpoint proves nothing about the real system.");
    process.exitCode = 1;
    return;
  }

  const url = `${args.base.replace(/\/+$/, "")}${args.endpoint}`;
  console.log(`Firing ${args.requests} requests at ${args.method} ${url} with concurrency ${args.concurrency}...`);

  const results = [];
  let inFlight = 0;
  let issued = 0;

  await new Promise((resolve) => {
    function pump() {
      while (inFlight < args.concurrency && issued < args.requests) {
        issued += 1;
        inFlight += 1;
        fireOne(url, args.method, args.token, args.body).then((r) => {
          results.push(r);
          inFlight -= 1;
          if (results.length === args.requests) resolve();
          else pump();
        });
      }
    }
    pump();
  });

  const elapsed = results.map((r) => r.elapsed).sort((a, b) => a - b);
  const failures = results.filter((r) => !r.ok);
  const statusCounts = {};
  for (const r of results) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;

  console.log("");
  console.log(`Total: ${results.length}   Failures: ${failures.length} (${((failures.length / results.length) * 100).toFixed(1)}%)`);
  console.log(`Status codes: ${JSON.stringify(statusCounts)}`);
  console.log(`Latency (ms) — p50: ${percentile(elapsed, 50).toFixed(1)}  p95: ${percentile(elapsed, 95).toFixed(1)}  p99: ${percentile(elapsed, 99).toFixed(1)}  max: ${elapsed[elapsed.length - 1]?.toFixed(1) ?? 0}`);
  if (failures.length > 0) {
    console.log("");
    console.log("Sample failures:");
    for (const f of failures.slice(0, 5)) console.log(`  status=${f.status} elapsed=${f.elapsed.toFixed(1)}ms ${f.error ?? ""}`);
  }
}

// Only run when invoked directly (`node scripts/reliability-load-test.mjs ...`), never on import (e.g. from a test file).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
