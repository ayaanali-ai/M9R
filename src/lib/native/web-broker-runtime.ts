import { dirname, join } from "node:path";

export interface StandaloneWebBrokerRuntime {
  executable: string;
  args: string[];
}

/** Resolve the self-contained broker shipped beside the standalone engine. */
export function standaloneWebBrokerRuntime(input: {
  engineExecutable: string;
  home: string;
  projectRoot: string;
  port: number;
  exists: (path: string) => boolean;
}): StandaloneWebBrokerRuntime {
  const executable = join(dirname(input.engineExecutable), "m9r-web-broker.exe");
  if (!input.exists(executable)) {
    throw new Error(`The standalone M9R Web broker is missing beside the engine at ${executable}; rebuild and install the complete Windows package before enabling Web.`);
  }
  return {
    executable,
    args: ["--home", input.home, "--port", String(input.port), "--project-root", input.projectRoot],
  };
}
