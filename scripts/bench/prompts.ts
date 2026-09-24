/**
 * Prompts for the real-agent runs (docs: M9R_DEMO_BUILD_PLAN_2026-09-23.md, risk 3). One prompt per (task, condition, role).
 * The three conditions differ only in how the work is split and what agents may say to each other:
 *  - solo: one agent does everything.
 *  - parallel: three agents split the work and say nothing until they report at the end.
 *  - coordinated: the same split, but agents share findings the moment they have them and use teammates' findings to stop early.
 * Prompts never contain the answer, and every agent gets the same tool guidance so the comparison is about coordination.
 */
import type { TaskName } from "./bench-data";
import type { Condition } from "./strategies";

export type Role = "a1" | "a2" | "a3";
export const ROLES: readonly Role[] = ["a1", "a2", "a3"];

export interface PromptInput {
  task: TaskName;
  condition: Condition;
  role: Role;
  token: string;
  baseUrl: string;
}

const MESSAGE_LIMIT = 1_500;

function preface(input: PromptInput): string {
  return [
    `You are agent ${input.role} in a small benchmark. You can act on the web only through the M9R browser tools: m9r_web_open, m9r_web_read, m9r_web_click and m9r_web_type.`,
    `Pass this session token as the token argument on EVERY M9R tool call: ${input.token}`,
    'Open a page with m9r_web_open, then read it with m9r_web_read. Listing pages are tables: read them with selector "#rows". Read a whole page with selector "#content". Pages are small and never change, so do not read a page twice. Your browser tab is your own.',
  ].join("\n");
}

const submitTrip = (base: string) =>
  `To submit: open ${base}/trip/answer, type the three ids into #flight, #hotel and #car with m9r_web_type, click #submit with m9r_web_click, then read #status and confirm it says "Answer received."`;

const submitSearch = (base: string) =>
  `To submit: open ${base}/search/answer, type the id into #item with m9r_web_type, click #submit with m9r_web_click, then read #status and confirm it says "Answer received."`;

const tripPages = (base: string) =>
  `The policy is at ${base}/trip/policy. Listings: ${base}/trip/flights-1 to flights-3, ${base}/trip/hotels-1 to hotels-4, ${base}/trip/cars-1 to cars-3. Every listing is sorted by price, cheapest first, and each page's URL ends in its page number.`;

const searchPages = (base: string) =>
  `The spec is at ${base}/search/spec and gives the exact certification code to find. Product lists: ${base}/search/list-1 to list-3, eight products each, ids in the first column. A product's code is in element #cert on its detail page ${base}/search/item-<ID> (for example ${base}/search/item-P-12). Some products have a code that differs from the target by one character; those do not count.`;

function tripSolo(input: PromptInput): string {
  const base = input.baseUrl;
  return [
    "Task: choose a flight, a hotel and a car by following the travel policy exactly.",
    tripPages(base),
    "Read only as many pages as you need: as soon as you have found the item the policy calls for in a listing, stop reading that listing.",
    submitTrip(base),
    "Your final reply: one line with the three ids.",
  ].join("\n");
}

function tripParallel(input: PromptInput): string {
  const base = input.baseUrl;
  const shared = [
    "Task: a team of three agents (a1, a2, a3) must choose a flight, a hotel and a car by following the travel policy exactly. Each agent covers one listing. You are a1 (flights), a2 (hotels) or a3 (cars) as stated below.",
    tripPages(base),
    "Rule of this run: do not message anyone until you have read every page of your listing.",
  ];
  if (input.role === "a1") {
    return [
      ...shared,
      "You are a1: the FLIGHT listing, and you submit the final answer. Read the policy, then read all three flight pages and keep every flight whose carrier is approved (id, departure date, price).",
      "Then wait for one report each from a2 (hotels) and a3 (cars): call m9r_inbox with waitSeconds 25, repeating until both have arrived. Using only those reports and your flight list, apply the policy rule and submit the three ids.",
      submitTrip(base),
      "Your final reply: one line with the three ids.",
    ].join("\n");
  }
  const listing = input.role === "a2" ? "HOTEL" : "CAR";
  const pages = input.role === "a2" ? "all four hotel pages" : "all three car pages";
  const keep =
    input.role === "a2"
      ? "every hotel whose zone the policy allows, giving id, zone, available window and price per night"
      : "every car whose category the policy allows, giving id, category, zones served and price per day";
  return [
    ...shared,
    `You are ${input.role}: the ${listing} listing. You do not know which flight will be chosen, so cover every possibility. Read the policy and ${pages}. Keep ${keep}, cheapest first, one per line.`,
    `When you have read every page, send ONE message to a1 with m9r_send (to "a1") that lists them all. Keep it compact and under ${MESSAGE_LIMIT} characters; if it cannot fit, send two messages. Then finish. Do not submit anything yourself.`,
  ].join("\n");
}

function tripCoordinated(input: PromptInput): string {
  const base = input.baseUrl;
  const shared = [
    "Task: a team of three agents (a1, a2, a3) must choose a flight, a hotel and a car by following the travel policy exactly. Each agent covers one listing and shares what it finds the moment it has it, so nobody reads more than necessary.",
    tripPages(base),
  ];
  if (input.role === "a1") {
    return [
      ...shared,
      'You are a1: the FLIGHT listing, and you submit the final answer. Read the policy, then read flight pages in order until you find the flight the policy calls for. As soon as you have it, send a message to a2 and to a3 (two m9r_send calls) saying exactly: "FLIGHT <id> departs Oct <n>".',
      'Then wait for "HOTEL ..." from a2 and "CAR ..." from a3: call m9r_inbox with waitSeconds 25, repeating until you have both. Then submit the three ids.',
      submitTrip(base),
      "Your final reply: one line with the three ids.",
    ].join("\n");
  }
  if (input.role === "a2") {
    return [
      ...shared,
      "You are a2: the HOTEL listing. Read the policy and start reading hotel pages in order right away; do not wait for anyone.",
      'After every page you read, call m9r_inbox with waitSeconds 0. When a1\'s "FLIGHT ..." message arrives you know the departure date: apply the policy to every hotel row you have read so far and to each further row. The cheapest hotel that satisfies the policy for that date is your answer; stop reading as soon as you have it.',
      'Send a message to a1 and to a3 (two m9r_send calls) saying exactly: "HOTEL <id> in <zone>". If you reach the end of the listing before the flight message has arrived, call m9r_inbox with waitSeconds 25 until it does, then decide from the rows you already read. Then finish.',
    ].join("\n");
  }
  return [
    ...shared,
    "You are a3: the CAR listing. Read the policy and start reading car pages in order right away; do not wait for anyone.",
    'After every page you read, call m9r_inbox with waitSeconds 0. When a2\'s "HOTEL ... in <zone>" message arrives you know which zone the car must serve: apply the policy to every car row you have read so far and to each further row. The cheapest car that satisfies the policy for that zone is your answer; stop reading as soon as you have it.',
    'Send a message to a1 (one m9r_send call) saying exactly: "CAR <id>". If you reach the end of the listing before the hotel message has arrived, call m9r_inbox with waitSeconds 25 until it does, then decide from the rows you already read. Then finish.',
  ].join("\n");
}

function searchSolo(input: PromptInput): string {
  const base = input.baseUrl;
  return [
    "Task: find the one product whose certification code is exactly the code given on the spec page.",
    searchPages(base),
    "Check products one at a time and stop as soon as you find the exact match.",
    submitSearch(base),
    "Your final reply: the product id.",
  ].join("\n");
}

function searchTeam(input: PromptInput, coordinated: boolean): string {
  const base = input.baseUrl;
  const list = ROLES.indexOf(input.role) + 1;
  const shared = [
    "Task: a team of three agents (a1, a2, a3) must find the one product whose certification code is exactly the code given on the spec page.",
    searchPages(base),
    `You are ${input.role}: your share is product list ${list} (${base}/search/list-${list}). Read the spec page for the code, read your list page, then check each of its products' detail pages in order.`,
  ];
  const submit = input.role === "a1" ? [submitSearch(base), "Your final reply: the product id."] : [];
  if (!coordinated) {
    const finish =
      input.role === "a1"
        ? 'When you have checked all of your products, wait for a report from a2 and from a3: call m9r_inbox with waitSeconds 25, repeating until both have arrived. Each says "FOUND <id>" or "NONE". Submit the id that was found (yours or a teammate\'s).'
        : 'Do not message anyone until you have checked every product in your list. Then send ONE message to a1 with m9r_send (to "a1"): "FOUND <id>" if you found the exact match, otherwise "NONE". Then finish.';
    return [...shared, "Rule of this run: check every product in your list before you say anything to anyone (stop early only if you find the exact match).", finish, ...submit].join("\n");
  }
  const share =
    input.role === "a1"
      ? 'The moment you find the exact match, send "FOUND <id>" to a2 and to a3 (two m9r_send calls) and submit it yourself.'
      : 'The moment you find the exact match, send "FOUND <id>" to a1 and to the other teammate (two m9r_send calls), then finish.';
  const stop =
    input.role === "a1"
      ? 'Before opening each product detail page, call m9r_inbox with waitSeconds 0. If a teammate has reported "FOUND <id>", stop checking and submit that id. If you finish your list without a match, call m9r_inbox with waitSeconds 25 until you receive a "FOUND <id>" or both teammates have reported "NONE".'
      : 'Before opening each product detail page, call m9r_inbox with waitSeconds 0. If any teammate has reported "FOUND <id>", stop immediately and finish. If you finish your list without a match, send "NONE" to a1 and finish.';
  return [...shared, share, stop, ...submit].join("\n");
}

export function buildPrompt(input: PromptInput): string {
  const body =
    input.task === "trip"
      ? input.condition === "solo"
        ? tripSolo(input)
        : input.condition === "parallel"
          ? tripParallel(input)
          : tripCoordinated(input)
      : input.condition === "solo"
        ? searchSolo(input)
        : searchTeam(input, input.condition === "coordinated");
  return `${preface(input)}\n\n${body}`;
}

/** Which agents run for a condition: solo runs one, the team conditions run three. */
export function rolesFor(condition: Condition): readonly Role[] {
  return condition === "solo" ? ["a1"] : ROLES;
}
