import { createProductionMissionRelayOptions } from "../../../src/lib/mission/mission-relay-production";
import { createMissionRelayServer } from "./server";
import { readMissionRelayConfig } from "./config";

const config = readMissionRelayConfig();
const { server, webSocketServer } = createMissionRelayServer({
  port: config.port,
  host: config.host,
  // Item #21 Phase 6: the same signing secret already provisioned to both
  // this process and the Next.js app authenticates /internal/* too --
  // deliberately not a second secret, since both sides already have this
  // one and it never crosses a third boundary.
  internalSecret: config.tokenSecret,
  ...createProductionMissionRelayOptions({ tokenSecret: config.tokenSecret }),
});

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  webSocketServer.close(() => server.close(() => process.exit(0)));
};

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
server.on("listening", () => console.log(`Mission Relay listening on ${config.host}:${config.port}`));
