import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// Render is retired; the Relay is a Durable Object Worker. These pin the deployment facts that cost money or break
// clients if they drift.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the live Relay config is the Durable Object Worker under the original name, with the web app reached over a service binding", () => {
  const config = read("services/relay-do/wrangler.cutover.jsonc");
  assert.match(config, /"name": "m9r-relay"/, "the same Worker name keeps every client URL unchanged");
  assert.match(config, /"class_name": "WorkspaceHub"/);
  assert.match(config, /"new_sqlite_classes": \["WorkspaceHub"\]/);
  assert.match(config, /"binding": "WEB"/);
  assert.doesNotMatch(config, /containers|"image"/i, "no container is defined: containers are not covered by the startup credits");
});

test("the Relay config holds no committed secrets", () => {
  const config = read("services/relay-do/wrangler.cutover.jsonc");
  assert.doesNotMatch(config, /SECRET|SERVICE_ROLE|TOKEN\s*"\s*:/);
});

test("every retired container config is marked DO NOT DEPLOY, so a stray wrangler deploy cannot start billable containers", () => {
  for (const service of ["mission-relay", "mission-worker", "mission-bridge"]) {
    assert.match(read(`services/${service}/wrangler.jsonc`).split("\n")[0], /DO NOT DEPLOY/, service);
  }
});
