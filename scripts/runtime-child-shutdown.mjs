function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, timeoutMs, beforeWait) {
  if (hasExited(child)) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);

    child.once("exit", onExit);
    if (hasExited(child)) {
      finish(true);
      return;
    }

    beforeWait?.();
  });
}

/** Close an MCP child's input, wait for graceful exit, then terminate and verify it. */
export async function stopChildProcess(child, { gracePeriodMs = 2_000, killTimeoutMs = 2_000 } = {}) {
  if (!child || typeof child.once !== "function" || typeof child.kill !== "function") {
    throw new TypeError("Expected a child process");
  }

  if (hasExited(child)) return;

  const exitedGracefully = await waitForExit(child, gracePeriodMs, () => {
    try {
      child.stdin?.end();
    } catch {
      // Even an already-closed stdin must still get a bounded exit/kill attempt.
    }
  });
  if (exitedGracefully) return;

  if (hasExited(child)) return;
  child.kill();

  const exitedAfterTermination = await waitForExit(child, killTimeoutMs);
  if (!exitedAfterTermination) {
    throw new Error("MCP child process did not exit after termination");
  }
}
