/**
 * Scripted stand-ins for the three conditions in the benchmark (docs: M9R_DEMO_BUILD_PLAN_2026-09-23.md, risk 3):
 *  - solo: one agent does everything in order.
 *  - parallel: three agents split the work and share nothing until they report at the end.
 *  - coordinated: the same three agents post findings to a shared board as they go, and use what teammates post to stop early.
 * These are NOT evidence about real agents. They exist so the harness can be shown to tell the conditions apart
 * (page loads, tool calls, wall time) before any paid run, and they call the real M9R tools against a real browser.
 */
import type { TaskName } from "./bench-data";

export interface WebApi {
  open(url: string): Promise<void>;
  read(selector: string): Promise<string>;
  type(selector: string, text: string): Promise<void>;
  click(selector: string): Promise<void>;
}

export interface Board {
  post(kind: string, value: unknown): void;
  peek<T>(kind: string): T | undefined;
  wait<T>(kind: string): Promise<T>;
}

export function createBoard(): Board {
  const posts = new Map<string, unknown>();
  const waiters = new Map<string, Array<(value: unknown) => void>>();
  return {
    post(kind, value) {
      if (posts.has(kind)) return;
      posts.set(kind, value);
      for (const resolve of waiters.get(kind) ?? []) resolve(value);
      waiters.delete(kind);
    },
    peek: <T>(kind: string) => posts.get(kind) as T | undefined,
    wait<T>(kind: string) {
      if (posts.has(kind)) return Promise.resolve(posts.get(kind) as T);
      return new Promise<T>((resolve) => waiters.set(kind, [...(waiters.get(kind) ?? []), resolve as (value: unknown) => void]));
    },
  };
}

export type Condition = "solo" | "parallel" | "coordinated";
export const CONDITIONS: readonly Condition[] = ["solo", "parallel", "coordinated"];

export interface RunContext {
  url: (path: string) => string;
  agents: [WebApi, WebApi, WebApi];
  board: Board;
}

type Row = string[];

const rowsFrom = (text: string): Row[] =>
  text
    .split("\n")
    .map((line) => line.split("\t").map((cell) => cell.trim()))
    .filter((cells) => /^[FHCP]-\d+$/.test(cells[0] ?? ""));

const dayOf = (text: string) => Number(/Oct (\d+)/.exec(text)?.[1]);

interface Policy {
  carriers: string[];
  zones: string[];
  forbidden: string[];
  nights: number;
}

async function readPolicy(web: WebApi, url: RunContext["url"]): Promise<Policy> {
  await web.open(url("/trip/policy"));
  const text = await web.read("#content");
  return {
    carriers: /Approved carriers: ([^.\n]+)\./.exec(text)?.[1].split(", ") ?? [],
    zones: /Allowed hotel zones: ([^.\n]+)\./.exec(text)?.[1].split(" or ") ?? [],
    forbidden: /Car categories not allowed: ([^.\n]+)\./.exec(text)?.[1].split(", ") ?? [],
    nights: Number(/Trip length: (\d+) nights/.exec(text)?.[1]),
  };
}

const flightOk = (p: Policy, row: Row) => p.carriers.includes(row[1]);
const hotelOk = (p: Policy, day: number, row: Row) => {
  const [from, to] = row[3].split(" to ").map(dayOf);
  return p.zones.includes(row[2]) && from <= day && to >= day + p.nights;
};
const carOk = (p: Policy, zone: string, row: Row) => row[2].split(", ").includes(zone) && !p.forbidden.includes(row[1]);

/** Reads a listing page by page, stopping as soon as `visit` returns true. Returns every row read. */
async function scan(web: WebApi, url: RunContext["url"], path: (page: number) => string, pages: number, visit: (all: Row[]) => boolean): Promise<Row[]> {
  const all: Row[] = [];
  for (let page = 1; page <= pages; page++) {
    await web.open(url(path(page)));
    all.push(...rowsFrom(await web.read("#rows")));
    if (visit(all)) break;
  }
  return all;
}

async function submit(web: WebApi, url: RunContext["url"], task: TaskName, fields: Record<string, string>): Promise<void> {
  await web.open(url(`/${task}/answer`));
  for (const [id, value] of Object.entries(fields)) await web.type(`#${id}`, value);
  await web.click("#submit");
}

const flightPath = (p: number) => `/trip/flights-${p}`;
const hotelPath = (p: number) => `/trip/hotels-${p}`;
const carPath = (p: number) => `/trip/cars-${p}`;

async function tripSolo(ctx: RunContext): Promise<void> {
  const [web] = ctx.agents;
  const p = await readPolicy(web, ctx.url);
  const flights = await scan(web, ctx.url, flightPath, 3, (all) => all.some((r) => flightOk(p, r)));
  const flight = flights.find((r) => flightOk(p, r))!;
  const hotels = await scan(web, ctx.url, hotelPath, 4, (all) => all.some((r) => hotelOk(p, dayOf(flight[2]), r)));
  const hotel = hotels.find((r) => hotelOk(p, dayOf(flight[2]), r))!;
  const cars = await scan(web, ctx.url, carPath, 3, (all) => all.some((r) => carOk(p, hotel[2], r)));
  const car = cars.find((r) => carOk(p, hotel[2], r))!;
  await submit(web, ctx.url, "trip", { flight: flight[0], hotel: hotel[0], car: car[0] });
}

async function tripParallel(ctx: RunContext): Promise<void> {
  const [a0, a1, a2] = ctx.agents;
  const { url, board } = ctx;
  const worker = async (web: WebApi, kind: string, path: (p: number) => string, pages: number) => {
    await readPolicy(web, url);
    board.post(kind, await scan(web, url, path, pages, () => false));
  };
  const flightsTask = (async () => {
    const p = await readPolicy(a0, url);
    const flights = await scan(a0, url, flightPath, 3, () => false);
    const [hotels, cars] = await Promise.all([board.wait<Row[]>("hotels"), board.wait<Row[]>("cars")]);
    const flight = flights.find((r) => flightOk(p, r))!;
    const hotel = hotels.find((r) => hotelOk(p, dayOf(flight[2]), r))!;
    const car = cars.find((r) => carOk(p, hotel[2], r))!;
    await submit(a0, url, "trip", { flight: flight[0], hotel: hotel[0], car: car[0] });
  })();
  await Promise.all([flightsTask, worker(a1, "hotels", hotelPath, 4), worker(a2, "cars", carPath, 3)]);
}

async function tripCoordinated(ctx: RunContext): Promise<void> {
  const [a0, a1, a2] = ctx.agents;
  const { url, board } = ctx;

  const flights = (async () => {
    const p = await readPolicy(a0, url);
    const rows = await scan(a0, url, flightPath, 3, (all) => all.some((r) => flightOk(p, r)));
    const flight = rows.find((r) => flightOk(p, r))!;
    board.post("flight", { id: flight[0], day: dayOf(flight[2]) });
    const [hotel, car] = await Promise.all([board.wait<{ id: string }>("hotel"), board.wait<{ id: string }>("car")]);
    await submit(a0, url, "trip", { flight: flight[0], hotel: hotel.id, car: car.id });
  })();

  const hotels = (async () => {
    const p = await readPolicy(a1, url);
    const find = (all: Row[]) => {
      const flight = board.peek<{ day: number }>("flight");
      const hit = flight ? all.find((r) => hotelOk(p, flight.day, r)) : undefined;
      if (hit) board.post("hotel", { id: hit[0], zone: hit[2] });
      return Boolean(hit);
    };
    const all = await scan(a1, url, hotelPath, 4, find);
    if (!board.peek("hotel")) {
      const flight = await board.wait<{ day: number }>("flight");
      const hit = all.find((r) => hotelOk(p, flight.day, r))!;
      board.post("hotel", { id: hit[0], zone: hit[2] });
    }
  })();

  const cars = (async () => {
    const p = await readPolicy(a2, url);
    const find = (all: Row[]) => {
      const hotel = board.peek<{ zone: string }>("hotel");
      const hit = hotel ? all.find((r) => carOk(p, hotel.zone, r)) : undefined;
      if (hit) board.post("car", { id: hit[0] });
      return Boolean(hit);
    };
    const all = await scan(a2, url, carPath, 3, find);
    if (!board.peek("car")) {
      const hotel = await board.wait<{ zone: string }>("hotel");
      const hit = all.find((r) => carOk(p, hotel.zone, r))!;
      board.post("car", { id: hit[0] });
    }
  })();

  await Promise.all([flights, hotels, cars]);
}

const codeFrom = (text: string) => text.trim();
const listPath = (p: number) => `/search/list-${p}`;

async function readTarget(web: WebApi, url: RunContext["url"]): Promise<string> {
  await web.open(url("/search/spec"));
  return codeFrom(await web.read("#code"));
}

async function searchSolo(ctx: RunContext): Promise<void> {
  const [web] = ctx.agents;
  const target = await readTarget(web, ctx.url);
  for (let page = 1; page <= 3; page++) {
    await web.open(ctx.url(listPath(page)));
    for (const [id] of rowsFrom(await web.read("#rows"))) {
      await web.open(ctx.url(`/search/item-${id}`));
      if (codeFrom(await web.read("#cert")) === target) return submit(web, ctx.url, "search", { item: id });
    }
  }
}

async function searchTeam(ctx: RunContext, coordinated: boolean): Promise<void> {
  const { url, board } = ctx;
  const work = ctx.agents.map(async (web, index) => {
    const target = await readTarget(web, url);
    await web.open(url(listPath(index + 1)));
    let match: string | null = null;
    for (const [id] of rowsFrom(await web.read("#rows"))) {
      if (coordinated && board.peek("found")) break;
      await web.open(url(`/search/item-${id}`));
      if (codeFrom(await web.read("#cert")) === target) {
        match = id;
        if (coordinated) board.post("found", id);
        break;
      }
    }
    board.post(`done${index}`, match);
  });

  const coordinator = (async () => {
    const found = coordinated
      ? await Promise.race([board.wait<string>("found"), Promise.all([board.wait("done0"), board.wait("done1"), board.wait("done2")]).then(() => undefined)])
      : undefined;
    const results = found ?? (await Promise.all([board.wait<string | null>("done0"), board.wait<string | null>("done1"), board.wait<string | null>("done2")])).find(Boolean);
    await work[0]; // agent 0 shares its tab between scanning and submitting, so let its own scan finish first
    await submit(ctx.agents[0], url, "search", { item: String(results) });
  })();

  await Promise.all([...work, coordinator]);
}

export async function runStrategy(task: TaskName, condition: Condition, ctx: RunContext): Promise<void> {
  if (task === "trip") {
    if (condition === "solo") return tripSolo(ctx);
    if (condition === "parallel") return tripParallel(ctx);
    return tripCoordinated(ctx);
  }
  if (condition === "solo") return searchSolo(ctx);
  return searchTeam(ctx, condition === "coordinated");
}
