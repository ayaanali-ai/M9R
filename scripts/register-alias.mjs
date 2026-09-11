// Bootstrap loaded via `node --import` so the resolve hook is active before the
// CLI's module graph loads. No new dependencies; pure Node loader registration.
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./ts-alias-loader.mjs", pathToFileURL("./scripts/").href);
