const TEST_FILE_NAME = /^[a-z0-9][a-z0-9._-]*\.test\.(?:ts|mjs|js)$/i;

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
