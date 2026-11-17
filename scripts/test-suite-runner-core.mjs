const TEST_FILE_NAME = /^[a-z0-9][a-z0-9._-]*\.test\.(?:ts|mjs|js)$/i;

/** Critical native workflow coverage: also required in the release manifest. */
export const NATIVE_TEST_FILES = Object.freeze([
  "owner-pipe.test.ts", "m9r-compatibility.test.ts", "managed-provider-adapters.test.ts",
  "managed-provider-supervisor.test.ts", "managed-provider-owner-queue.test.ts", "efficiency-metrics.test.ts",
  "test-suite-runner-core.test.mjs", "logical-task-context.test.ts", "native-front-door-core.test.ts",
  "task-desktop-stage.test.ts", "computer-execution-loop.test.ts", "computer-use-program.test.ts",
  "computer-use-recovery.test.ts", "multiplayer-task-context.test.ts", "multiplayer-a2a.test.ts",
  "native-hook-server.test.ts", "live-session-core.test.ts", "mcp-inbox.test.ts",
  "multiplayer-runtime.test.ts", "multiplayer-dispatch-fence.test.ts", "multiplayer-cursor-chatter.test.ts",
  "cua-stage-driver.test.ts", "windows-desktop-stage.test.ts", "task-stage-actions.test.ts",
]);

export function requireNativeReleaseCoverage(files) {
  const missing = NATIVE_TEST_FILES.filter(file => !files.includes(file));
  if (missing.length) throw new Error(`Critical native tests are missing from the release manifest: ${missing.join(", ")}`);
}

export function testSummary(output) {
  const read = label => Number(output.match(new RegExp(`(?:ℹ\\s*|#\\s*)?${label}\\s+(\\d+)`))?.[1] ?? 0);
  return { tests: read("tests"), pass: read("pass"), fail: read("fail"), skipped: read("skipped") };
}

export function testNodeArgs(files, concurrency = 8) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("Test concurrency must be between 1 and 16.");
  validateTestFileManifest(files, files);
  return ["--disable-warning=ExperimentalWarning", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    "--import", "./scripts/register-alias.mjs", "--test", `--test-concurrency=${concurrency}`, ...files.map(file => `./scripts/${file}`)];
}

/** Development feedback only. Candidate builds still run their own full gates. */
export function codeCheckPlan(profile) {
  if (profile !== "native" && profile !== "full") throw new Error("Choose native or full code checks.");
  return [
    { name: "typecheck", args: ["node_modules/typescript/bin/tsc", "--noEmit", "-p", profile === "native" ? "scripts/tsconfig.native-dev.json" : "."] },
    { name: "tests", args: ["scripts/run-test-suite.mjs", profile === "native" ? "native" : "all"] },
  ];
}

export function validateTestFileManifest(files, availableFiles) {
  if (!Array.isArray(files)) throw new Error("The full test manifest must be an array.");
  const available = new Set(availableFiles);
  const seen = new Set();

  for (const file of files) {
    if (typeof file !== "string" || !TEST_FILE_NAME.test(file)) throw new Error("Invalid test file name in the full test manifest.");
    if (seen.has(file)) throw new Error(`Duplicate test file in the full test manifest: ${file}`);
    if (!available.has(file)) throw new Error(`Full test manifest references a missing test file: ${file}`);
    seen.add(file);
  }

  if (seen.size === 0) throw new Error("The full test manifest is empty.");
  return [...seen];
}

/** Keep child Node command lines safely below the Windows CreateProcess limit. */
export function splitTestFilesIntoBatches(files, options = {}) {
  const maxArgumentChars = options.maxArgumentChars ?? 8000;
  if (!Number.isSafeInteger(maxArgumentChars) || maxArgumentChars < 1) throw new Error("The test runner argument budget must be a positive integer.");

  const validated = validateTestFileManifest(files, files);
  const batches = [];
  let batch = [];
  let batchChars = 0;

  for (const file of validated) {
    const argument = `./scripts/${file}`;
    if (argument.length > maxArgumentChars) throw new Error(`Test file argument exceeds the test runner argument budget: ${file}`);
    const nextChars = batchChars + argument.length + (batch.length === 0 ? 0 : 1);
    if (batch.length > 0 && nextChars > maxArgumentChars) {
      batches.push(batch);
      batch = [];
      batchChars = 0;
    }

    batchChars += argument.length + (batch.length === 0 ? 0 : 1);
    batch.push(file);
  }

  if (batch.length > 0) batches.push(batch);
  return batches;
}
