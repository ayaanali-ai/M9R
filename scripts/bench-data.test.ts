import assert from "node:assert/strict";
import test from "node:test";
import { generateBench, generateSearch, generateTrip, renderPage, scoreAnswer, type BenchData } from "./bench/bench-data";

const SEEDS = Array.from({ length: 25 }, (_, i) => i + 1);

function rowsOf(html: string): string[][] {
  return [...html.matchAll(/<tr>(.*?)<\/tr>/g)]
    .map((m) => [...m[1].matchAll(/<td>(.*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, "")))
    .filter((cells) => cells.length > 0);
}

function page(data: BenchData, path: string): string {
  const html = renderPage(data, path);
  assert.ok(html, `expected ${path} to exist`);
  return html;
}

const dayOf = (text: string) => Number(/Oct (\d+)/.exec(text)?.[1]);

function solveTripFromPages(data: BenchData) {
  const policy = page(data, "/trip/policy");
  const carriers = /Approved carriers: ([^<.]+)\./.exec(policy)?.[1].split(", ") ?? [];
  const zones = /Allowed hotel zones: ([^<.]+)\./.exec(policy)?.[1].split(" or ") ?? [];
  const forbidden = /Car categories not allowed: ([^<.]+)\./.exec(policy)?.[1].split(", ") ?? [];
  const nights = Number(/Trip length: (\d+) nights/.exec(policy)?.[1]);

  const flights = [1, 2, 3].flatMap((n) => rowsOf(page(data, `/trip/flights-${n}`)));
  const flight = flights.find((f) => carriers.includes(f[1]))!;
  const checkin = dayOf(flight[2]);

  const hotels = [1, 2, 3, 4].flatMap((n) => rowsOf(page(data, `/trip/hotels-${n}`)));
  const hotel = hotels.find((h) => {
    const [from, to] = h[3].split(" to ").map(dayOf);
    return zones.includes(h[2]) && from <= checkin && to >= checkin + nights;
  })!;

  const cars = [1, 2, 3].flatMap((n) => rowsOf(page(data, `/trip/cars-${n}`)));
  const car = cars.find((c) => c[2].split(", ").includes(hotel[2]) && !forbidden.includes(c[1]))!;
  return { flight: flight[0], hotel: hotel[0], car: car[0] };
}

test("the same seed always produces the same site and answer, and different seeds differ", () => {
  assert.deepEqual(generateBench(7), generateBench(7));
  const truths = new Set(SEEDS.map((s) => JSON.stringify(generateBench(s).trip.truth)));
  assert.ok(truths.size > 15, "seeds should give varied answers");
});

test("every seed yields a solvable, non-trivial trip with unique ids and prices sorted ascending", () => {
  for (const seed of SEEDS) {
    const trip = generateTrip(seed);
    const ids = [...trip.flights, ...trip.hotels, ...trip.cars].map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length, `seed ${seed}: ids must be unique`);
    for (const list of [trip.flights, trip.hotels, trip.cars]) {
      const prices = list.map((x) => x.price);
      assert.deepEqual(prices, [...prices].sort((a, b) => a - b), `seed ${seed}: sorted by price`);
      assert.equal(new Set(prices).size, prices.length, `seed ${seed}: prices unique so "cheapest" is unambiguous`);
    }
    assert.ok(trip.hotels.findIndex((h) => h.id === trip.truth.hotel) >= 5, `seed ${seed}: hotel answer is not on top`);
    assert.ok(trip.cars.findIndex((c) => c.id === trip.truth.car) >= 3, `seed ${seed}: car answer is not on top`);
  }
});

test("solving the trip from the rendered pages alone reaches the stored answer", () => {
  for (const seed of SEEDS) {
    const data = generateBench(seed);
    assert.deepEqual(solveTripFromPages(data), data.trip.truth, `seed ${seed}`);
  }
});

test("solving the search from the rendered pages alone reaches the stored answer, and decoys differ by exactly one character", () => {
  for (const seed of SEEDS) {
    const data = generateBench(seed);
    const target = /id="code">([A-Z0-9]+)</.exec(page(data, "/search/spec"))?.[1];
    assert.equal(target, data.search.targetCode);

    const ids = [1, 2, 3].flatMap((n) => rowsOf(page(data, `/search/list-${n}`)).map((r) => r[0]));
    assert.equal(ids.length, 24);
    const matches = ids.filter((id) => new RegExp(`id="cert">${target}<`).test(page(data, `/search/item-${id}`)));
    assert.deepEqual(matches, [data.search.truth.item], `seed ${seed}: exactly one exact match`);

    const search = generateSearch(seed);
    const near = search.items.filter((i) => i.code !== target && [...i.code].filter((c, k) => c !== target![k]).length === 1);
    assert.ok(near.length >= 4, `seed ${seed}: there are near-miss decoys`);
  }
});

test("pages outside the site return nothing, and the answer pages have the fields the harness fills in", () => {
  const data = generateBench(3);
  for (const path of ["/trip/flights-4", "/trip/hotels-5", "/trip/cars-0", "/search/list-4", "/search/item-P-0", "/nope"]) {
    assert.equal(renderPage(data, path), null, path);
  }
  const tripAnswer = page(data, "/trip/answer");
  for (const id of ["flight", "hotel", "car", "submit"]) assert.ok(tripAnswer.includes(`id="${id}"`), id);
  const searchAnswer = page(data, "/search/answer");
  for (const id of ["item", "submit"]) assert.ok(searchAnswer.includes(`id="${id}"`), id);
});

test("scoring is per part, ignores case and spaces, and marks a wrong part wrong", () => {
  const data = generateBench(5);
  const t = data.trip.truth;
  assert.deepEqual(scoreAnswer("trip", data, { flight: ` ${t.flight.toLowerCase()} `, hotel: t.hotel, car: t.car }), {
    correct: { flight: true, hotel: true, car: true },
    allCorrect: true,
  });
  const partial = scoreAnswer("trip", data, { flight: t.flight, hotel: "H-00", car: t.car });
  assert.equal(partial.allCorrect, false);
  assert.deepEqual(partial.correct, { flight: true, hotel: false, car: true });
  assert.equal(scoreAnswer("trip", data, {}).allCorrect, false);
  assert.equal(scoreAnswer("search", data, { item: data.search.truth.item }).allCorrect, true);
  assert.equal(scoreAnswer("search", data, { item: "P-00" }).allCorrect, false);
});
