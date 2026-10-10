export interface RuntimeBuildManifest {
  schemaVersion: 1;
  buildId: string;
  builtAt: string;
  artifacts: Record<string, string>;
}

export function writeRuntimeBuildManifest(root: string, builtAt?: string): RuntimeBuildManifest;
export function verifyRuntimeBuildManifest(root: string, options?: { exact?: boolean }): RuntimeBuildManifest;
export function publishRuntimeBuild(stagedRoot: string, outputRoot: string, managedPaths: string[]): RuntimeBuildManifest;
export function publishGeneratedDirectory(stagedRoot: string, outputRoot: string): void;
