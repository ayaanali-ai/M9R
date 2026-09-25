import { join } from "node:path";

export const DEFAULT_BROKER_PORT = 47821;

export function brokerKeyPath(root: string): string {
  return join(root, "web-broker.key");
}
