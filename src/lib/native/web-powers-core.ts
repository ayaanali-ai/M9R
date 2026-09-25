/**
 * The agent's extra browser powers beyond open/read/click/type: scroll, wait, history, tabs, keys, dropdowns, find,
 * hover, screenshot and table extraction. Pure logic shared by the broker core: validation (unknown or extra fields are
 * refused), risk (only actions that can commit something go through the same risky-click gate as m9r_web_click), claims
 * (reads never claim, keys into a field take that field like typing, navigation takes the tab) and the presence
 * summary. The page and tab work itself lives in extensions/browser/src/powers.js and page-powers.js.
 */
import { classifyWebActionRisk, type Risk } from "./risk-core";

export type WebPowerAction =
  | "scroll" | "wait" | "back" | "forward" | "tabs" | "switch" | "close"
  | "press" | "select" | "find" | "hover" | "screenshot" | "extract"
  | "snapshot" | "click_at" | "reload" | "double_click" | "right_click" | "drag" | "drop"
  | "check" | "uncheck" | "toggle" | "fill_form" | "select_text" | "copy" | "paste"
  | "upload" | "download" | "submit" | "buy" | "post" | "follow" | "like" | "dm" | "point" | "link";

export const POWER_ACTIONS: readonly WebPowerAction[] = [
  "scroll", "wait", "back", "forward", "tabs", "switch", "close", "press", "select", "find", "hover", "screenshot", "extract",
  "snapshot", "click_at", "reload", "double_click", "right_click", "drag", "drop", "check", "uncheck", "toggle", "fill_form",
  "select_text", "copy", "paste", "upload", "download", "submit", "buy", "post", "follow", "like", "dm", "point", "link",
];

export type PressKey = string;

/** Keys that only move the viewport or caret when no target is named; they never claim the tab. */
const VIEW_KEYS: ReadonlySet<string> = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"]);
const ACTIVATING_KEYS: ReadonlySet<string> = new Set(["Enter", "Return", "Space"]);

export const MAX_WAIT_MS = 15_000;
export const DEFAULT_WAIT_MS = 10_000;
export const MAX_FIND_QUERY = 200;
export const MAX_EXTRACT_ROWS = 500;
export const MAX_LABEL_LENGTH = 80;

export interface WebPowerArgs {
  to?: "top" | "bottom";
  by?: number;
  smooth?: boolean;
  text?: string;
  ms?: number;
  key?: PressKey;
  shift?: boolean;
  value?: string;
  option?: string;
  query?: string;
  scrollToFirst?: boolean;
  format?: "jpeg" | "png";
  maxRows?: number;
  limit?: number;
  x?: number;
  y?: number;
  button?: "left" | "right" | "middle";
  destination?: string;
  mime?: string;
  data?: string;
  valueText?: string;
  fields?: Array<{ selector: string; value: string }>;
}

/** The subset of WebRequest this module reads; kept structural so web-broker-core can import it without a cycle. */
export interface PowerRequestShape {
  action: string;
  tab?: string;
  selector?: string;
  targetLabel?: string;
  formSelector?: string;
  endSelector?: string;
  args?: WebPowerArgs;
}

export type PowerClaimScope =
  | { kind: "tab"; key: "*" }
  | { kind: "form"; key: string }
  | { kind: "field"; key: string; formKey?: string };

const BASE_FIELDS = new Set(["agent", "provider", "sessionId", "owner", "action", "tab"]);
const TOP_FIELDS: Record<WebPowerAction, readonly string[]> = {
  scroll: ["selector", "args"],
  wait: ["selector", "args"],
  back: ["targetLabel"],
  forward: ["targetLabel"],
  tabs: [],
  switch: [],
  close: ["targetLabel"],
  press: ["selector", "targetLabel", "formSelector", "shareWith", "args"],
  select: ["selector", "targetLabel", "formSelector", "shareWith", "args"],
  find: ["selector", "args"],
  hover: ["selector"],
  screenshot: ["args"],
  extract: ["selector", "args"],
  snapshot: ["args"],
  click_at: ["args"],
  reload: [],
  double_click: ["selector", "targetLabel", "shareWith"],
  right_click: ["selector", "targetLabel", "shareWith"],
  drag: ["selector", "endSelector", "targetLabel", "shareWith", "args"],
  drop: ["selector", "targetLabel", "shareWith", "args"],
  check: ["selector", "targetLabel", "formSelector", "shareWith"],
  uncheck: ["selector", "targetLabel", "formSelector", "shareWith"],
  toggle: ["selector", "targetLabel", "formSelector", "shareWith"],
  fill_form: ["formSelector", "shareWith", "args"],
  select_text: ["selector", "targetLabel", "args"],
  copy: ["selector", "targetLabel"],
  paste: ["selector", "targetLabel", "formSelector", "shareWith", "args"],
  upload: ["selector", "targetLabel", "formSelector", "shareWith"],
  download: ["selector", "targetLabel", "shareWith"],
  submit: ["selector", "targetLabel", "shareWith"],
  buy: ["selector", "targetLabel", "shareWith"],
  post: ["selector", "targetLabel", "shareWith"],
  follow: ["selector", "targetLabel", "shareWith"],
  like: ["selector", "targetLabel", "shareWith"],
  dm: ["selector", "targetLabel", "shareWith"],
  point: ["selector", "targetLabel"],
  link: ["selector"],
};
const ARG_FIELDS: Record<WebPowerAction, readonly (keyof WebPowerArgs)[]> = {
  scroll: ["to", "by", "smooth"],
  wait: ["text", "ms"],
  back: [],
  forward: [],
  tabs: [],
  switch: [],
  close: [],
  press: ["key", "shift"],
  select: ["value", "option"],
  find: ["query", "scrollToFirst"],
  hover: [],
  screenshot: ["format"],
  extract: ["maxRows"],
  snapshot: ["query", "limit"],
  click_at: ["x", "y", "button"],
  reload: [],
  double_click: [],
  right_click: [],
  drag: ["destination"],
  drop: ["mime", "data"],
  check: [],
  uncheck: [],
  toggle: [],
  fill_form: ["fields"],
  select_text: ["text"],
  copy: [],
  paste: ["valueText"],
  upload: [],
  download: [],
  submit: [],
  buy: [],
  post: [],
  follow: [],
  like: [],
  dm: [],
  point: [],
  link: [],
};

export function isPowerAction(action: unknown): action is WebPowerAction {
  return typeof action === "string" && (POWER_ACTIONS as readonly string[]).includes(action);
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Returns null when the request is well formed, otherwise the reason it is refused. */
export function validatePowerRequest(request: PowerRequestShape): string | null {
  const action = request.action as WebPowerAction;
  const allowedTop = new Set([...BASE_FIELDS, ...TOP_FIELDS[action]]);
  for (const [field, value] of Object.entries(request)) {
    if (value === undefined) continue;
    if (!allowedTop.has(field)) return `${action} does not take ${field}`;
  }
  if (request.args !== undefined && !isPlainObject(request.args)) return `${action} args must be an object`;
  const args = (request.args ?? {}) as Record<string, unknown>;
  for (const [field, value] of Object.entries(args)) {
    if (value === undefined) continue;
    if (!(ARG_FIELDS[action] as readonly string[]).includes(field)) return `${action} does not take ${field}`;
  }
  const selector = request.selector;
  if (selector !== undefined && (typeof selector !== "string" || !selector.trim())) return "selector must be a non-empty string";
  if (request.endSelector !== undefined && (typeof request.endSelector !== "string" || !request.endSelector.trim() || request.endSelector.length > 500)) return "endSelector must be a non-empty string up to 500 characters";
  if (request.formSelector !== undefined && (typeof request.formSelector !== "string" || !request.formSelector.trim() || request.formSelector.length > 500)) return "formSelector must be a non-empty string up to 500 characters";
  if (request.targetLabel !== undefined && (typeof request.targetLabel !== "string" || request.targetLabel.length > MAX_LABEL_LENGTH)) return `targetLabel must be at most ${MAX_LABEL_LENGTH} characters`;
  const bool = (name: keyof WebPowerArgs) => args[name] === undefined || typeof args[name] === "boolean";
  const shortText = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max;

  switch (action) {
    case "scroll": {
      const modes = [args.to !== undefined, args.by !== undefined, selector !== undefined].filter(Boolean).length;
      if (modes !== 1) return "scroll needs exactly one of to (top or bottom), by (pixels) or selector";
      if (args.to !== undefined && args.to !== "top" && args.to !== "bottom") return "scroll to must be top or bottom";
      if (args.by !== undefined && (typeof args.by !== "number" || !Number.isFinite(args.by) || Math.abs(args.by) > 100_000)) return "scroll by must be a number of pixels between -100000 and 100000";
      if (!bool("smooth")) return "smooth must be true or false";
      return null;
    }
    case "wait": {
      if (selector !== undefined && args.text !== undefined) return "wait takes a selector or text, not both";
      if (args.text !== undefined && !shortText(args.text, MAX_FIND_QUERY)) return `wait text must be 1-${MAX_FIND_QUERY} characters`;
      if (args.ms !== undefined && (!Number.isSafeInteger(args.ms) || (args.ms as number) < 0 || (args.ms as number) > MAX_WAIT_MS)) return `wait ms must be a whole number from 0 to ${MAX_WAIT_MS}`;
      if (selector === undefined && args.text === undefined && args.ms === undefined) return "wait needs a selector, text or ms";
      return null;
    }
    case "switch":
      return request.tab === undefined ? "switch needs the tab name to bring forward" : null;
    case "press": {
      if (typeof args.key !== "string" || !/^(?:(?:Control|Ctrl|Alt|Shift|Meta)\+){0,3}(?:[A-Za-z0-9]|Enter|Return|Tab|Escape|Space|Backspace|Delete|Arrow(?:Up|Down|Left|Right)|PageUp|PageDown|Home|End|F(?:[1-9]|1[0-2]))$/.test(args.key) || args.key.length > 48) return "press key must be one of the supported keys or shortcuts";
      if (!bool("shift")) return "shift must be true or false";
      return null;
    }
    case "select": {
      if (selector === undefined) return "select needs a selector";
      const given = [args.value !== undefined, args.option !== undefined].filter(Boolean).length;
      if (given !== 1) return "select needs exactly one of value or option (the visible label)";
      if (args.value !== undefined && (typeof args.value !== "string" || args.value.length > 500)) return "select value must be a string up to 500 characters";
      if (args.option !== undefined && !shortText(args.option, 500)) return "select option must be 1-500 characters";
      return null;
    }
    case "find": {
      if (!shortText(args.query, MAX_FIND_QUERY)) return `find query must be 1-${MAX_FIND_QUERY} characters`;
      if (!bool("scrollToFirst")) return "scrollToFirst must be true or false";
      return null;
    }
    case "hover":
      return selector === undefined ? "hover needs a selector" : null;
    case "screenshot":
      return args.format !== undefined && args.format !== "jpeg" && args.format !== "png" ? "screenshot format must be jpeg or png" : null;
    case "extract": {
      if (selector === undefined) return "extract needs a selector for the table or list";
      if (args.maxRows !== undefined && (!Number.isSafeInteger(args.maxRows) || (args.maxRows as number) < 1 || (args.maxRows as number) > MAX_EXTRACT_ROWS)) return `maxRows must be 1-${MAX_EXTRACT_ROWS}`;
      return null;
    }
    case "snapshot":
      if (args.query !== undefined && !shortText(args.query, MAX_FIND_QUERY)) return `snapshot query must be 1-${MAX_FIND_QUERY} characters`;
      if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > 150)) return "snapshot limit must be 1-150";
      return null;
    case "click_at":
      if (typeof args.x !== "number" || !Number.isFinite(args.x) || args.x < 0 || args.x > 32_768 || typeof args.y !== "number" || !Number.isFinite(args.y) || args.y < 0 || args.y > 32_768) return "click_at needs viewport x and y coordinates from 0 to 32768";
      if (args.button !== undefined && args.button !== "left" && args.button !== "right" && args.button !== "middle") return "click_at button must be left, right or middle";
      return null;
    case "reload":
      return null;
    case "double_click":
    case "right_click":
    case "check":
    case "uncheck":
    case "toggle":
    case "download":
    case "submit":
    case "buy":
    case "post":
    case "follow":
    case "like":
    case "dm":
    case "point":
    case "link":
      return selector === undefined ? `${action} needs a selector or ref` : null;
    case "drag":
      if (selector === undefined || request.endSelector === undefined) return "drag needs a source selector/ref and endSelector/ref";
      return null;
    case "drop":
      if (selector === undefined) return "drop needs a selector or ref";
      if (args.mime !== undefined && (typeof args.mime !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(args.mime) || args.mime.length > 100)) return "drop mime must be a valid MIME type";
      if (args.data !== undefined && (typeof args.data !== "string" || args.data.length > 5_000)) return "drop data must be at most 5000 characters";
      if ((args.mime === undefined) !== (args.data === undefined)) return "drop needs both mime and data";
      return null;
    case "fill_form": {
      if (request.formSelector === undefined) return "fill_form needs a formSelector so the whole form can be claimed";
      if (!Array.isArray(args.fields) || args.fields.length < 1 || args.fields.length > 30) return "fill_form fields must contain 1-30 selector/value pairs";
      for (const field of args.fields) {
        if (!isPlainObject(field) || typeof field.selector !== "string" || !field.selector.trim() || field.selector.length > 500 || typeof field.value !== "string" || field.value.length > 5_000) return "each fill_form field needs a selector and text value (max 5000 characters)";
      }
      return null;
    }
    case "select_text":
      if (selector === undefined || !shortText(args.text, 500)) return "select_text needs a selector/ref and 1-500 characters of text";
      return null;
    case "copy":
      return null;
    case "paste":
      if (selector === undefined || typeof args.valueText !== "string" || args.valueText.length > 5_000) return "paste needs a selector/ref and text up to 5000 characters";
      return null;
    case "upload":
      return selector === undefined ? "upload needs a file-input selector/ref" : null;
    default:
      return null;
  }
}

function activates(request: PowerRequestShape): boolean {
  return request.action === "press" && ACTIVATING_KEYS.has(String(request.args?.key));
}

/**
 * Reading, scrolling, waiting, finding, hovering, listing, switching and screenshots are safe. History moves, closing a
 * tab, Enter/Space on a target and choosing a dropdown option are judged by exactly the rules m9r_web_click uses, so a
 * submit-, pay-, send- or delete-like target is held for the owner.
 */
export function classifyPowerRisk(request: PowerRequestShape): Risk {
  switch (request.action) {
    // These are always put in the existing owner-approval queue, even if a caller gives them an innocent-looking label.
    case "click_at":
    case "drag":
    case "drop":
    case "upload":
    case "download":
    case "submit":
    case "buy":
    case "post":
    case "follow":
    case "like":
    case "dm":
      return { risky: true, category: request.action === "buy" ? "money" : request.action === "upload" ? "secrets" : "outside" };
    case "back":
    case "forward":
    case "reload":
    case "close":
    case "select":
    case "double_click":
    case "check":
    case "uncheck":
    case "toggle":
      return classifyWebActionRisk({ action: "click", selector: [request.selector, request.formSelector].filter(Boolean).join(" ") || request.action, targetLabel: request.targetLabel });
    case "right_click":
      return { risky: false };
    case "press":
      if (!activates(request)) return { risky: false };
      return classifyWebActionRisk({ action: "click", selector: [request.selector, request.formSelector].filter(Boolean).join(" "), targetLabel: request.targetLabel });
    default:
      return { risky: false };
  }
}

/** undefined means "not a power action"; null means the power never claims. */
export function powerScopeFor(request: PowerRequestShape): PowerClaimScope | null | undefined {
  if (!isPowerAction(request.action)) return undefined;
  switch (request.action) {
    case "back":
    case "forward":
    case "reload":
    case "close":
    case "click_at":
    case "drag":
    case "drop":
    case "upload":
    case "download":
    case "submit":
    case "buy":
    case "post":
    case "follow":
    case "like":
    case "dm":
      return { kind: "tab", key: "*" };
    case "select":
      return { kind: "field", key: request.selector!, ...(request.formSelector ? { formKey: request.formSelector } : {}) };
    case "press": {
      const key = String(request.args?.key);
      if (ACTIVATING_KEYS.has(key)) {
        const submitLike = /(?:submit|checkout|purchase|buy|pay|send|delete|remove|confirm|place[-_ ]?order)/i.test(`${request.selector ?? ""} ${request.targetLabel ?? ""}`);
        if (!submitLike && request.formSelector) return { kind: "form", key: request.formSelector };
        return { kind: "tab", key: "*" };
      }
      if (request.selector) return { kind: "field", key: request.selector, ...(request.formSelector ? { formKey: request.formSelector } : {}) };
      return VIEW_KEYS.has(key) ? null : { kind: "tab", key: "*" };
    }
    case "double_click":
    case "check":
    case "uncheck":
    case "toggle":
    case "paste":
      return request.selector ? { kind: "field", key: request.selector, ...(request.formSelector ? { formKey: request.formSelector } : {}) } : null;
    case "fill_form":
      return { kind: "form", key: request.formSelector! };
    default:
      return null;
  }
}

/** Cross-owner grants still name the four base actions; each power needs the base action it is closest to. */
export function grantActionFor(action: string, request?: PowerRequestShape): "open" | "read" | "click" | "type" {
  switch (action) {
    case "back":
    case "forward":
    case "reload":
    case "close":
      return "open";
    case "select":
    case "double_click":
    case "right_click":
    case "check":
    case "uncheck":
    case "toggle":
    case "click_at":
    case "drag":
    case "drop":
    case "upload":
    case "download":
    case "submit":
    case "buy":
    case "post":
    case "follow":
    case "like":
    case "dm":
      return "click";
    case "snapshot":
    case "find":
    case "screenshot":
    case "extract":
    case "copy":
    case "link":
    case "tabs":
      return "read";
    case "paste":
    case "fill_form":
    case "select_text":
      return "type";
    case "press":
      return request && activates(request) ? "click" : "type";
    case "open":
    case "click":
    case "type":
      return action;
    default:
      return "read";
  }
}

/** Presence text for the overlay, derived from the command itself; never includes page values or typed text. */
export function describePower(request: PowerRequestShape): string {
  const target = request.selector ?? "";
  const args = request.args ?? {};
  switch (request.action as WebPowerAction) {
    case "scroll":
      return args.to ? `scrolling to the ${args.to}` : target ? `scrolling to ${target}` : `scrolling ${Number(args.by) >= 0 ? "down" : "up"}`;
    case "wait":
      return target ? `waiting for ${target}` : args.text ? "waiting for text to appear" : "waiting";
    case "back":
      return "going back";
    case "forward":
      return "going forward";
    case "tabs":
      return "listing its tabs";
    case "switch":
      return `switching to tab ${request.tab}`;
    case "close":
      return "closing a tab";
    case "press":
      return target ? `pressing ${args.key} in ${target}` : `pressing ${args.key}`;
    case "select":
      return `choosing an option in ${target}`;
    case "find":
      return "finding text on the page";
    case "hover":
      return `hovering ${target}`;
    case "screenshot":
      return "taking a screenshot";
    case "extract":
      return `reading the table ${target}`;
    case "snapshot":
      return "checking the page for interactive elements";
    case "click_at":
      return "clicking a point on the page";
    case "reload":
      return "reloading the page";
    case "double_click":
      return `double-clicking ${target}`;
    case "right_click":
      return `opening the context menu on ${target}`;
    case "drag":
      return `dragging ${target}`;
    case "drop":
      return `dropping data on ${target}`;
    case "check":
      return `checking ${target}`;
    case "uncheck":
      return `unchecking ${target}`;
    case "toggle":
      return `toggling ${target}`;
    case "fill_form":
      return "filling the form";
    case "select_text":
      return `selecting text in ${target}`;
    case "copy":
      return target ? `reading text from ${target}` : "copying the current page selection";
    case "paste":
      return `pasting text into ${target}`;
    case "upload":
      return `opening the file picker for ${target}`;
    case "download":
      return `downloading from ${target}`;
    case "submit":
      return `submitting ${target}`;
    case "buy":
      return `buying via ${target}`;
    case "post":
      return `posting via ${target}`;
    case "follow":
      return `following via ${target}`;
    case "like":
      return `liking via ${target}`;
    case "dm":
      return `sending a direct message via ${target}`;
    case "point":
      return `pointing at ${request.targetLabel || target || "this one"}`;
    case "link":
      return `getting the link from ${target}`;
    default:
      return String(request.action);
  }
}

/** Extra time the broker waits for the browser beyond its base timeout. */
export function extraTimeoutFor(request: PowerRequestShape): number {
  if (request.action === "wait") return Math.min(MAX_WAIT_MS, Number(request.args?.ms ?? DEFAULT_WAIT_MS)) + 2_000;
  if (request.action === "back" || request.action === "forward") return 12_000;
  if (request.action === "screenshot" || request.action === "select" || request.action === "snapshot" || request.action === "fill_form") return 5_000;
  return 0;
}

export function sanitizeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean ? Array.from(clean).slice(0, MAX_LABEL_LENGTH).join("") : undefined;
}
