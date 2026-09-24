import assert from "node:assert/strict";
import test from "node:test";
import { startBenchSite } from "./bench/bench-site";

async function post(url: string, body: unknown): Promise<number> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return response.status;
}

test("the site serves its pages, logs each load with a timestamp, and returns 404 for anything else", async () => {
  const site = await startBenchSite({ seed: 2 });
  assert.equal((await fetch(site.url("/trip/policy"))).status, 200);
  assert.equal((await fetch(site.url("/trip/flights-1"))).status, 200);
  assert.equal((await fetch(site.url("/trip/flights-9"))).status, 404);
  assert.equal((await fetch(site.url("/__answer"))).status, 404, "GET on the answer endpoint is not a page");

  const loads = site.loads();
  assert.deepEqual(loads.map((l) => l.path), ["/trip/policy", "/trip/flights-1"]);
  assert.ok(loads[1].at >= loads[0].at);
  await site.close();
});

test("a submitted answer is recorded with its score, and reset clears the run", async () => {
  const site = await startBenchSite({ seed: 4 });
  const t = site.data.trip.truth;
  assert.equal(await post(site.url("/__answer?task=trip"), { flight: t.flight, hotel: t.hotel, car: "C-00" }), 200);
  assert.equal(await post(site.url("/__answer?task=search"), { item: site.data.search.truth.item }), 200);

  const [trip, search] = site.submissions();
  assert.equal(trip.task, "trip");
  assert.deepEqual(trip.score.correct, { flight: true, hotel: true, car: false });
  assert.equal(trip.score.allCorrect, false);
  assert.equal(search.score.allCorrect, true);

  site.reset();
  assert.deepEqual(site.submissions(), []);
  assert.deepEqual(site.loads(), []);
  await site.close();
});

test("an unknown task or unreadable body never crashes the site", async () => {
  const site = await startBenchSite({ seed: 1 });
  assert.equal(await post(site.url("/__answer?task=other"), {}), 400);
  const bad = await fetch(site.url("/__answer?task=search"), { method: "POST", body: "not json" });
  assert.equal(bad.status, 200);
  assert.equal(site.submissions()[0].score.allCorrect, false);
  assert.equal((await fetch(site.url("/search/spec"))).status, 200);
  await site.close();
});
