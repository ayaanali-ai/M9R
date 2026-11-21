import "./memory.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// Resolved via new URL(..., import.meta.url) rather than default imports: the
// repo-root tsconfig also checks this file under Next's image typings, where a
// .webp import is StaticImageData, not a URL string. Vite bundles both forms.
const windowIconUrl = new URL("./assets/m9r-site/window-icon.webp", import.meta.url).href;
const sizeGripUrl = new URL("./assets/m9r-site/size-grip.svg", import.meta.url).href;

/** Mirrors MemoryEntry in src/lib/native/memory-log.ts -- this window only ever
 * displays/deletes what that ledger already holds, it never writes notes itself. */
interface MemoryEntry {
  id: string;
  text: string;
  scope: "global" | string;
  createdAt: string;
}

type Tab = "all" | "global";

const root = document.getElementById("memory-root")!;
let entries: MemoryEntry[] = [];
let tab: Tab = "all";

function personaLabel(scope: string): string {
  return scope === "global" ? "global" : scope.replace(/^persona:/, "");
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

async function forget(id: string): Promise<void> {
  entries = entries.filter((e) => e.id !== id);
  render();
  try {
    await invoke("forget_memory", { id });
  } catch {
    // The window re-syncs from the next "memory-update" event or reopen either way.
  }
}

/** Small element helper. Text only ever goes in via textContent, never innerHTML,
 * so a memory note (or a persona name in its scope) can never be read as markup --
 * these notes can end up holding arbitrary user phrasing. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderEntry(entry: MemoryEntry): HTMLElement {
  const row = el("article", "memory-entry");
  row.dataset.id = entry.id;

  const body = el("div", "memory-entry-body");
  body.append(el("p", "memory-text", entry.text));

  const meta = el("div", "memory-meta");
  meta.append(el("span", "ds-scrap memory-scope", personaLabel(entry.scope)));
  const when = formatWhen(entry.createdAt);
  if (when) meta.append(el("span", "memory-date", when));
  body.append(meta);

  const forgetButton = el("button", "ds-icon-button memory-forget", "×");
  forgetButton.type = "button";
  forgetButton.title = "Forget this";
  forgetButton.setAttribute("aria-label", "Forget this note");
  forgetButton.addEventListener("click", () => void forget(entry.id));

  row.append(body, forgetButton);
  return row;
}

function renderEmpty(): HTMLElement {
  const empty = el("div", "memory-empty");
  empty.append(
    el("p", "memory-empty-line", tab === "global" && entries.length ? "No global notes yet." : "Nothing here yet."),
    el(
      "p",
      "memory-empty-note",
      "As M9R picks up on how you work, it’ll show up here — and you can always delete it.",
    ),
  );
  return empty;
}

function filterButton(value: Tab, label: string): HTMLButtonElement {
  const active = tab === value;
  const button = el("button", `ds-pill-button large${active ? "" : " neutral"}`, label);
  button.type = "button";
  button.setAttribute("role", "tab");
  button.setAttribute("aria-selected", String(active));
  button.addEventListener("click", () => {
    tab = value;
    render();
  });
  return button;
}

function render(): void {
  const visible = tab === "global" ? entries.filter((e) => e.scope === "global") : entries;

  // Nav bar -- the site's cream bar, "M9R" left, a "Prints · 0"-style count right.
  const nav = el("nav", "ds-nav memory-nav");
  const count = el("span", "memory-nav-count");
  count.append(el("span", "memory-nav-glyph", "▧"), document.createTextNode(` Notes · ${entries.length}`));
  nav.append(el("span", "memory-brand", "M9R"), count);

  // Hero -- eyebrow, one display headline, serif lede, the Try/Join pill pair as filters.
  const hero = el("header", "memory-hero");
  const filters = el("div", "memory-filters");
  filters.setAttribute("role", "tablist");
  filters.setAttribute("aria-label", "Filter notes");
  filters.append(filterButton("all", "All"), filterButton("global", "Global"));
  hero.append(
    el("small", "ds-eyebrow", "Memory log"),
    el("h1", "ds-headline memory-title", "What M9R remembers."),
    el("p", "memory-lede", "What it has picked up about how you work. Delete anything, any time."),
    filters,
  );

  // The retro window holding the list.
  const win = el("section", "ds-window memory-window");
  win.setAttribute("aria-label", "Memory notes");

  const title = el("div", "ds-window-title");
  const titleLabel = el("span");
  const icon = el("img");
  icon.src = windowIconUrl;
  icon.alt = "";
  titleLabel.append(icon, document.createTextNode("Memory"));
  title.append(titleLabel);

  const toolbar = el("div", "ds-window-toolbar");
  toolbar.append(el("span", "", tab === "global" ? "Global only" : "All notes"));

  const pane = el("div", "ds-window-pane memory-pane");
  if (visible.length) {
    const list = el("div", "memory-list");
    list.append(...visible.map(renderEntry));
    pane.append(list);
  } else {
    pane.append(renderEmpty());
  }

  const status = el("div", "ds-window-status");
  const grip = el("img");
  grip.src = sizeGripUrl;
  grip.alt = "";
  status.append(el("span", "", `${visible.length} note(s)`), grip);

  win.append(title, toolbar, pane, status);

  root.replaceChildren(nav, hero, win);
}

async function refresh(): Promise<void> {
  try {
    entries = await invoke<MemoryEntry[]>("list_memory");
  } catch {
    entries = [];
  }
  render();
}

async function start(): Promise<void> {
  render();
  await refresh();
  try {
    await listen("memory-update", () => void refresh());
  } catch {
    // No live backend yet -- the window still renders, just without push updates.
  }
}

void start();
