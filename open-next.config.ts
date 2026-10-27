import { defineCloudflareConfig } from "@opennextjs/cloudflare";

const cloudflareConfig = defineCloudflareConfig(({
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

// Keep disposable OpenNext output out of the repository root. A prior
// generated .open-next tree acquired an ACL that the low-integrity build
// worker could not remove, which made an otherwise healthy source build
// fail before Cloudflare compilation began.
export default {
  ...cloudflareConfig,
  buildOutputPath: ".workcache/cloudflare-output",
};
