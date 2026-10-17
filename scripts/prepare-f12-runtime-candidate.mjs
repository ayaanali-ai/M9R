import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { verifyRuntimeBuildManifest, writeRuntimeBuildManifest } from "./engine-build-transaction.mjs";

const [sourceArg, installedArg, outputArg, sourceCommit] = process.argv.slice(2);
if (!sourceArg || !installedArg || !outputArg || !/^[a-f0-9]{40,64}$/i.test(sourceCommit ?? "")) {
  throw new Error("Usage: prepare-f12-runtime-candidate <clean-build> <installed-bin> <new-directory> <source-commit>");
}
const source = resolve(sourceArg), installed = resolve(installedArg), output = resolve(outputArg);
if (existsSync(output)) throw new Error("Candidate directory must be new.");
const clean = verifyRuntimeBuildManifest(source, { exact: true });
const installedManifest = JSON.parse(readFileSync(join(installed, "m9r-build-info.json"), "utf8"));
const overlay = join(installed, "m9r-overlay.exe");
const overlayHash = createHash("sha256").update(readFileSync(overlay)).digest("hex");
if (overlayHash !== installedManifest.artifacts?.["m9r-overlay.exe"]) throw new Error("Installed pill does not match its recorded artifact; refusing to retain an unidentified pill.");
mkdirSync(output);
const candidate = join(output, "runtime");
cpSync(source, candidate, { recursive: true });
// Keep the owner's current pill and Claude's independent dictation work intact.
// Only the engine, broker and native helper change for F12 acceptance.
copyFileSync(overlay, join(candidate, "m9r-overlay.exe"));
const manifest = writeRuntimeBuildManifest(candidate, undefined, { sourceCommit, sourceDirty: false });
verifyRuntimeBuildManifest(candidate, { exact: true });
const snapshotReportCandidates = [
  join(source, "source-snapshot-report.json"),
  resolve(source, "..", "source-snapshot-report.json"),
  resolve(source, "..", "..", "source-snapshot-report.json"),
];
const snapshotReportPath = snapshotReportCandidates.find(existsSync);
const snapshotReport = snapshotReportPath ? JSON.parse(readFileSync(snapshotReportPath, "utf8")) : null;
if (snapshotReport && snapshotReport.sourceCommit !== sourceCommit) {
  throw new Error(`Snapshot source commit ${snapshotReport.sourceCommit} does not match requested provenance ${sourceCommit}.`);
}
const provenance = {
  sourceCommit,
  sourceSnapshot: snapshotReport ? {
    sourceBranch: snapshotReport.sourceBranch,
    trackedFileCount: snapshotReport.trackedFileCount,
    dirtyTrackedPaths: snapshotReport.dirtyTrackedPaths,
    untrackedIncludedPaths: snapshotReport.untrackedIncludedPaths,
    untrackedExcludedCount: snapshotReport.untrackedExcludedCount ?? snapshotReport.untrackedExcludedPaths?.length ?? 0,
    postSnapshotChangesNotIncluded: snapshotReport.postSnapshotChangesNotIncluded ?? [],
    exclusions: snapshotReport.exclusions,
  } : null,
  cleanBuildId: clean.buildId,
  candidateBuildId: manifest.buildId,
  retainedPill: {
    installedBuildId: installedManifest.buildId,
    sha256: overlayHash,
    sourceProvenance: "existing installed artifact; source not independently established",
    sourceBoundary: "overlay source changes are preserved in the snapshot but are not rebuilt or accepted in this runtime candidate",
  },
  reason: "Package the verified source snapshot while retaining the hash-verified installed overlay binary; overlay source changes remain unaccepted.",
};
writeFileSync(join(output, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(JSON.stringify(provenance));
