import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import {
  acquireTerminalRuntimeOwner,
  inspectTerminalRuntimeOwner,
  requestTerminalRuntimeRestart,
  verifyTerminalRuntimeOwner,
  type RuntimeOwnerDescriptor,
} from "@/lib/native/terminal-runtime-owner";

async function freePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  const servers: ReturnType<typeof createServer>[] = [];
  for (let index = 0; index < count; index += 1) {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    ports.push(address.port);
    servers.push(server);
  }
  await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  return ports;
}

function closeServer(server: ReturnType<typeof createServer>): void {
  try {
    server.close();
    (server as ReturnType<typeof createServer> & { closeAllConnections?: () => void }).closeAllConnections?.();
  } catch { /* already closed */ }
}

test("one OS user shares a single runtime lease across workspaces", async () => {
  const ports = await freePorts(4);
  const userHome = "C:\\Users\\m9r-owner-lease-test";
  let leases: Array<Extract<Awaited<ReturnType<typeof acquireTerminalRuntimeOwner>>, { status: "acquired" }>> = [];
  try {
    const settled = await Promise.allSettled([
      acquireTerminalRuntimeOwner({ userHome, ports }),
      // This second caller stands for a different checkout. Repository path
      // intentionally is not part of the ownership API or identity.
      acquireTerminalRuntimeOwner({ userHome, ports }),
    ]);
    const results: Array<Awaited<ReturnType<typeof acquireTerminalRuntimeOwner>>> = [];
    const failures: unknown[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled") results.push(result.value);
      else failures.push(result.reason);
    }
    leases = results.filter((result): result is Extract<typeof result, { status: "acquired" }> => result.status === "acquired");
    if (failures.length > 0) throw failures[0];
    assert.deepEqual(results.map((result) => result.status).sort(), ["acquired", "already-running"]);
    assert.equal(leases.length, 1);
    const observed = await inspectTerminalRuntimeOwner({ userHome, ports });
    assert.equal(observed?.pid, process.pid);
    assert.equal(observed?.port, leases[0]?.owner.port);
  } finally {
    await Promise.all(leases.map((lease) => lease.owner.release()));
  }
  assert.equal(await inspectTerminalRuntimeOwner({ userHome, ports }), null);
});

test("different OS users can own separate runtimes", async () => {
  const ports = await freePorts(3);
  const first = await acquireTerminalRuntimeOwner({ userHome: "C:\\Users\\m9r-owner-a", ports });
  assert.equal(first.status, "acquired");
  if (first.status !== "acquired") return;
  let second: Awaited<ReturnType<typeof acquireTerminalRuntimeOwner>> | null = null;
  try {
    second = await acquireTerminalRuntimeOwner({ userHome: "C:\\Users\\m9r-owner-b", ports });
    assert.equal(second.status, "acquired");
    if (second.status === "acquired") assert.notEqual(second.owner.rootId, first.owner.rootId);
  } finally {
    if (second?.status === "acquired") await second.owner.release();
    await first.owner.release();
  }
});

test("runtime restart is authenticated and invokes the owner callback once", async () => {
  const ports = await freePorts(2);
  let restartCount = 0;
  const lease = await acquireTerminalRuntimeOwner({
    userHome: "C:\\Users\\m9r-owner-restart",
    ports,
    onRestartRequest: () => { restartCount += 1; },
  });
  assert.equal(lease.status, "acquired");
  if (lease.status !== "acquired") return;

  const descriptor: RuntimeOwnerDescriptor = {
    rootId: lease.owner.rootId,
    pid: process.pid,
    startedAtMs: lease.owner.startedAtMs,
    port: lease.owner.port,
    protocolVersion: 1,
  };
  try {
    assert.equal(await verifyTerminalRuntimeOwner(descriptor, "wrong-token"), false);
    assert.equal(await verifyTerminalRuntimeOwner(descriptor, lease.owner.token), true);
    assert.equal(await requestTerminalRuntimeRestart(descriptor, "wrong-token"), false);
    assert.equal(restartCount, 0);
    assert.equal(await requestTerminalRuntimeRestart(descriptor, lease.owner.token), true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(restartCount, 1);
  } finally {
    await lease.owner.release();
  }
});

test("an occupied but unverifiable owner port fails closed instead of selecting another lease", async () => {
  const ports = await freePorts(2);
  const silent = createServer();
  await new Promise<void>((resolve, reject) => {
    silent.once("error", reject);
    silent.listen(ports[0], "127.0.0.1", resolve);
  });
  try {
    await assert.rejects(
      acquireTerminalRuntimeOwner({ userHome: "C:\\Users\\m9r-owner-unverifiable", ports }),
      /occupied but could not verify its owner/,
    );
  } finally {
    closeServer(silent);
  }
});

test("unknown or foreign listeners are never treated as an M9R runtime owner", async () => {
  const ports = await freePorts(1);
  const unrelated = createServer((socket) => socket.end("not-m9r\n"));
  await new Promise<void>((resolve, reject) => {
    unrelated.once("error", reject);
    unrelated.listen(ports[0], "127.0.0.1", resolve);
  });
  try {
    assert.equal(await inspectTerminalRuntimeOwner({ userHome: "C:\\Users\\m9r-owner-foreign", ports }), null);
  } finally {
    closeServer(unrelated);
  }
});
