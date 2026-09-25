/**
 * Deterministic benchmark data for the "does coordination help" experiment (docs: M9R_DEMO_BUILD_PLAN_2026-09-23.md,
 * risk 3). Two small tasks with a known correct answer, so time and correctness can be scored without a judge:
 *  - "trip": a dependent chain. Policy -> cheapest approved flight -> cheapest hotel that is available on that flight's
 *    dates in an allowed zone -> cheapest car that serves that hotel's zone. Pages are sorted by price, so a solver that
 *    already knows the constraints can stop early; one that does not has to read everything.
 *  - "search": one product out of 24 has a certification code that exactly matches the spec, and near-miss decoys
 *    exist, so every candidate's detail page has to be read until the match is found.
 * The same seed always produces the same site and the same answer.
 */

export type TaskName = "trip" | "search";

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function int(r: () => number, lo: number, hi: number): number {
  return lo + Math.floor(r() * (hi - lo + 1));
}

function shuffle<T>(r: () => number, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(r, 0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function uniqueInts(r: () => number, count: number, lo: number, hi: number): number[] {
  return shuffle(r, Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)).slice(0, count);
}

const CARRIERS = ["Aster", "Brill", "Cobalt", "Delta9", "Ember"] as const;
const ZONES = ["Airport", "Harbor", "Old Town", "North End"] as const;
const CATEGORIES = ["economy", "compact", "suv", "luxury"] as const;
const ADJECTIVES = ["Grand", "Quiet", "Bright", "Harbor", "Maple", "Cedar", "Royal", "Copper", "Summit", "Willow"];
const NOUNS = ["Inn", "Suites", "Lodge", "House", "Court", "Plaza"];
const NIGHTS = 3;
const PAGE_SIZE = 10;

export interface Flight {
  id: string;
  carrier: string;
  day: number;
  price: number;
}
export interface Hotel {
  id: string;
  name: string;
  zone: string;
  from: number;
  to: number;
  price: number;
}
export interface Car {
  id: string;
  category: string;
  zones: string[];
  price: number;
}
export interface TripData {
  policy: { carriers: string[]; zones: string[]; forbiddenCategories: string[]; nights: number };
  flights: Flight[];
  hotels: Hotel[];
  cars: Car[];
  truth: { flight: string; hotel: string; car: string };
}

export function generateTrip(seed: number): TripData {
  for (let attempt = 0; attempt < 500; attempt++) {
    const r = rng(seed * 1000 + attempt);
    const carriers: string[] = shuffle(r, CARRIERS).slice(0, 3);
    const zones: string[] = shuffle(r, ZONES).slice(0, 2);
    const forbiddenCategories = ["luxury"];

    const flightIds = uniqueInts(r, 30, 10, 99);
    const flights = uniqueInts(r, 30, 180, 620)
      .sort((a, b) => a - b)
      .map((price, i): Flight => ({ id: `F-${flightIds[i]}`, carrier: CARRIERS[int(r, 0, CARRIERS.length - 1)], day: int(r, 6, 12), price }));

    const hotelIds = uniqueInts(r, 40, 10, 99);
    const hotels = uniqueInts(r, 40, 70, 260)
      .sort((a, b) => a - b)
      .map((price, i): Hotel => {
        const from = int(r, 5, 10);
        return {
          id: `H-${hotelIds[i]}`,
          name: `${ADJECTIVES[i % ADJECTIVES.length]} ${NOUNS[int(r, 0, NOUNS.length - 1)]}`,
          zone: ZONES[int(r, 0, ZONES.length - 1)],
          from,
          to: from + int(r, 3, 8),
          price,
        };
      });

    const carIds = uniqueInts(r, 30, 10, 99);
    const cars = uniqueInts(r, 30, 25, 110)
      .sort((a, b) => a - b)
      .map((price, i): Car => ({
        id: `C-${carIds[i]}`,
        category: CATEGORIES[int(r, 0, CATEGORIES.length - 1)],
        zones: shuffle(r, ZONES).slice(0, int(r, 1, 2)),
        price,
      }));

    const flightIndex = flights.findIndex((f) => carriers.includes(f.carrier));
    if (flightIndex < 0) continue;
    const flight = flights[flightIndex];
    const hotelIndex = hotels.findIndex((h) => zones.includes(h.zone) && h.from <= flight.day && h.to >= flight.day + NIGHTS);
    if (hotelIndex < 0) continue;
    const hotel = hotels[hotelIndex];
    const carIndex = cars.findIndex((c) => c.zones.includes(hotel.zone) && !forbiddenCategories.includes(c.category));
    if (carIndex < 0) continue;

    // Keep the task non-trivial: the right hotel and car must not sit at the top of their first pages.
    if (flightIndex < 1 || hotelIndex < 5 || carIndex < 3) continue;

    return {
      policy: { carriers, zones, forbiddenCategories, nights: NIGHTS },
      flights,
      hotels,
      cars,
      truth: { flight: flight.id, hotel: hotel.id, car: cars[carIndex].id },
    };
  }
  throw new Error("could not generate a solvable trip");
}

export interface SearchItem {
  id: string;
  name: string;
  code: string;
}
export interface SearchData {
  targetCode: string;
  items: SearchItem[];
  truth: { item: string };
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomCode(r: () => number): string {
  return Array.from({ length: 6 }, () => CODE_CHARS[int(r, 0, CODE_CHARS.length - 1)]).join("");
}

function nearMiss(r: () => number, code: string): string {
  const at = int(r, 0, code.length - 1);
  let replacement = code[at];
  while (replacement === code[at]) replacement = CODE_CHARS[int(r, 0, CODE_CHARS.length - 1)];
  return code.slice(0, at) + replacement + code.slice(at + 1);
}

export function generateSearch(seed: number): SearchData {
  const r = rng(seed * 7919 + 13);
  const targetCode = randomCode(r);
  const targetIndex = int(r, 14, 21);
  const ids = uniqueInts(r, 24, 10, 99);
  const decoyAt = new Set(shuffle(r, Array.from({ length: 24 }, (_, i) => i).filter((i) => i !== targetIndex)).slice(0, 6));
  const used = new Set<string>([targetCode]);
  const items = Array.from({ length: 24 }, (_, i): SearchItem => {
    let code = i === targetIndex ? targetCode : decoyAt.has(i) ? nearMiss(r, targetCode) : randomCode(r);
    while (i !== targetIndex && used.has(code)) code = decoyAt.has(i) ? nearMiss(r, targetCode) : randomCode(r);
    used.add(code);
    return { id: `P-${ids[i]}`, name: `${ADJECTIVES[i % ADJECTIVES.length]} ${["Lamp", "Kettle", "Pack", "Stove", "Radio", "Mat"][i % 6]} ${i + 1}`, code };
  });
  return { targetCode, items, truth: { item: items[targetIndex].id } };
}

export interface BenchData {
  seed: number;
  trip: TripData;
  search: SearchData;
}

export function generateBench(seed: number): BenchData {
  return { seed, trip: generateTrip(seed), search: generateSearch(seed) };
}

export type Answer = Record<string, string>;
export interface Score {
  correct: Record<string, boolean>;
  allCorrect: boolean;
}

const norm = (value: unknown) => String(value ?? "").trim().toUpperCase();

export function scoreAnswer(task: TaskName, data: BenchData, answer: Answer): Score {
  const truth: Record<string, string> = task === "trip" ? data.trip.truth : data.search.truth;
  const correct: Record<string, boolean> = {};
  for (const key of Object.keys(truth)) correct[key] = norm(answer[key]) === norm(truth[key]);
  return { correct, allCorrect: Object.values(correct).every(Boolean) };
}

const day = (n: number) => `Oct ${n}`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#1d1d1f}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #ddd}input{padding:6px 8px;margin:4px 0;width:240px}button{padding:6px 14px}</style></head><body><main id="content">${body}</main></body></html>`;
}

function paged(kind: string, label: string, header: string[], rows: string[][], pageNumber: number, pages: number): string {
  const start = (pageNumber - 1) * PAGE_SIZE;
  const slice = rows.slice(start, start + PAGE_SIZE);
  const table = `<table id="rows"><tr>${header.map((h) => `<th>${h}</th>`).join("")}</tr>${slice.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</table>`;
  const next = pageNumber < pages ? `<p><a id="next" href="/trip/${kind}-${pageNumber + 1}">Next page</a></p>` : "<p>End of list.</p>";
  return shell(`${label} page ${pageNumber}`, `<h1>${label}, page ${pageNumber} of ${pages}</h1><p>Sorted by price, lowest first.</p>${table}${next}`);
}

function answerPage(task: TaskName, fields: string[]): string {
  const inputs = fields.map((f) => `<label>${f} id <input id="${f}" type="text"></label><br>`).join("");
  const script = `document.getElementById("submit").addEventListener("click",function(){var a={};${fields.map((f) => `a.${f}=document.getElementById("${f}").value;`).join("")}fetch("/__answer?task=${task}",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(a)}).then(function(){document.getElementById("status").textContent="Answer received."});});`;
  return shell("Submit answer", `<h1>Submit your answer</h1>${inputs}<button id="submit" type="button">Submit</button><p id="status"></p><script>${script}</script>`);
}

export function renderPage(data: BenchData, path: string): string | null {
  const { trip, search } = data;
  if (path === "/" || path === "/index") {
    return shell("Benchmark index", `<h1>Benchmark site</h1><ul><li><a href="/trip/policy">Trip: start at the policy page</a></li><li><a href="/search/spec">Search: start at the spec page</a></li></ul>`);
  }

  if (path === "/trip/policy") {
    const p = trip.policy;
    return shell(
      "Travel policy",
      `<h1>Travel policy</h1><ul><li id="carriers">Approved carriers: ${p.carriers.join(", ")}.</li><li id="zones">Allowed hotel zones: ${p.zones.join(" or ")}.</li><li id="cars">Car categories not allowed: ${p.forbiddenCategories.join(", ")}.</li><li id="nights">Trip length: ${p.nights} nights, so checkout is ${p.nights} days after the flight date.</li></ul><p id="rule">Rule: book the cheapest approved flight. Then book the cheapest hotel in an allowed zone that is available for the whole stay. Then book the cheapest car that serves the hotel's zone and is in an allowed category. Submit the three ids at <a href="/trip/answer">the answer page</a>.</p><p>Listings: <a href="/trip/flights-1">flights</a>, <a href="/trip/hotels-1">hotels</a>, <a href="/trip/cars-1">cars</a>.</p>`,
    );
  }
  const list = /^\/trip\/(flights|hotels|cars)-(\d+)$/.exec(path);
  if (list) {
    const n = Number(list[2]);
    if (list[1] === "flights" && n >= 1 && n <= 3) {
      return paged("flights", "Flights", ["ID", "Carrier", "Departs", "Price"], trip.flights.map((f) => [f.id, f.carrier, day(f.day), `$${f.price}`]), n, 3);
    }
    if (list[1] === "hotels" && n >= 1 && n <= 4) {
      return paged("hotels", "Hotels", ["ID", "Name", "Zone", "Available", "Price per night"], trip.hotels.map((h) => [h.id, h.name, h.zone, `${day(h.from)} to ${day(h.to)}`, `$${h.price}`]), n, 4);
    }
    if (list[1] === "cars" && n >= 1 && n <= 3) {
      return paged("cars", "Cars", ["ID", "Category", "Serves zones", "Price per day"], trip.cars.map((c) => [c.id, c.category, c.zones.join(", "), `$${c.price}`]), n, 3);
    }
    return null;
  }
  if (path === "/trip/answer") return answerPage("trip", ["flight", "hotel", "car"]);

  if (path === "/search/spec") {
    return shell(
      "Search spec",
      `<h1>Find the certified product</h1><p id="spec">Find the product whose certification code is exactly <strong id="code">${search.targetCode}</strong>. Some products have codes that differ by a single character; those do not count. Each product's code is on its own detail page. Products are listed on <a href="/search/list-1">the product lists</a>. Submit the matching product id at <a href="/search/answer">the answer page</a>.</p>`,
    );
  }
  const searchList = /^\/search\/list-(\d+)$/.exec(path);
  if (searchList) {
    const n = Number(searchList[1]);
    if (n < 1 || n > 3) return null;
    const slice = search.items.slice((n - 1) * 8, n * 8);
    const table = `<table id="rows"><tr><th>ID</th><th>Name</th></tr>${slice.map((i) => `<tr><td><a href="/search/item-${i.id}">${i.id}</a></td><td>${i.name}</td></tr>`).join("")}</table>`;
    const next = n < 3 ? `<p><a id="next" href="/search/list-${n + 1}">Next page</a></p>` : "<p>End of list.</p>";
    return shell(`Products page ${n}`, `<h1>Products, page ${n} of 3</h1>${table}${next}`);
  }
  const item = /^\/search\/item-(P-\d+)$/.exec(path);
  if (item) {
    const found = search.items.find((i) => i.id === item[1]);
    if (!found) return null;
    return shell(found.name, `<h1>${found.name}</h1><p>Product id: <span id="pid">${found.id}</span></p><p>Field-tested outdoor equipment with a two year warranty.</p><p>Certification code: <span id="cert">${found.code}</span></p>`);
  }
  if (path === "/search/answer") return answerPage("search", ["item"]);
  return null;
}
