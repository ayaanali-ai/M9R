export interface ResidentServicePlan {
  version: "oathlock.resident-service.v1";
  profile: string;
  workingDirectory: string;
  command: string[];
  restart: { policy: "on-failure"; minimumDelaySeconds: number };
  health: { heartbeatIntervalSeconds: number; staleAfterSeconds: number };
}

export function buildResidentServicePlan(input: { profile: unknown; workingDirectory: unknown; configFile: unknown; pollMs: unknown }): ResidentServicePlan {
  if (typeof input.profile !== "string" || !/^[a-zA-Z0-9._:-]{1,100}$/.test(input.profile)) throw new Error("Resident profile name is invalid.");
  if (typeof input.workingDirectory !== "string" || !input.workingDirectory) throw new Error("Resident working directory is invalid.");
  if (typeof input.configFile !== "string" || !input.configFile) throw new Error("Resident config path is invalid.");
  const pollMs = typeof input.pollMs === "number" && Number.isSafeInteger(input.pollMs) ? input.pollMs : null;
  if (pollMs === null || pollMs < 5_000 || pollMs > 60_000) throw new Error("Resident poll interval is invalid.");
  return {
    version: "oathlock.resident-service.v1",
    profile: input.profile,
    workingDirectory: input.workingDirectory,
    command: ["oathlock", "resident", "run", "--profile", input.profile, "--config", input.configFile, "--poll-ms", String(pollMs)],
    restart: { policy: "on-failure", minimumDelaySeconds: 5 },
    health: { heartbeatIntervalSeconds: Math.ceil(pollMs / 1000), staleAfterSeconds: 90 },
  };
}
