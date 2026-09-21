import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig(({
  default: {
    override: {
      wrapper: "cloudflare-node",
      converter: "edge",
      incrementalCache: "dummy",
      tagCache: "dummy",
      queue: "dummy",
    },
  },
  middleware: {
    external: true,
    override: {
      wrapper: "cloudflare-node",
      converter: "edge",
    },
  },
  dangerous: {
    enableCacheInterception: false,
  },
}) as never);