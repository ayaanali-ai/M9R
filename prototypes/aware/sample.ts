/**
 * Real accessibility-tree elements, captured live against en.wikipedia.org's main page
 * via the same read_page/find mechanism M9R's own computer-use layer already relies on.
 * Not synthesized -- this is what the real site returns, trimmed to what's relevant here.
 */
import type { RawElement } from "./generator";

export const WIKIPEDIA_MAIN_PAGE_ELEMENTS: RawElement[] = [
  { ref: "ref_1", role: "link", name: "", href: "/wiki/Main_Page" },
  { ref: "ref_2", role: "link", name: "Search Wikipedia [alt-f]", href: "/wiki/Special:Search" },
  { ref: "ref_66", role: "textbox", name: "Search Wikipedia", type: "search", placeholder: "Search Wikipedia" },
  { ref: "ref_68", role: "button", name: "Search" },
  { ref: "ref_5", role: "link", name: "Wikipedia", href: "https://en.wikipedia.org/wiki/Wikipedia" },
  { ref: "ref_6", role: "link", name: "Free content", href: "https://en.wikipedia.org/wiki/Free_content" },
  { ref: "ref_10", role: "link", name: "English language", href: "https://en.wikipedia.org/wiki/English_language" },
];

/**
 * Real elements captured live from github.com/search/advanced -- including, on a second pass, the
 * actual for/id links and the real <select> options a plain accessibility-tree read had missed the
 * first time. The label/combobox "hard case" turned out to be a capture gap, not a reasoning gap --
 * see generator.ts's label-resolution pass, verified against this exact data.
 */
export const GITHUB_ADVANCED_SEARCH_ELEMENTS: RawElement[] = [
  { ref: "ref_7", role: "textbox", name: "" },
  { ref: "ref_8", role: "button", name: "Search" },
  { ref: "ref_58", role: "label", name: "From these owners", labelFor: "search_from" },
  { ref: "ref_59", role: "textbox", name: "", id: "search_from" },
  { ref: "ref_64", role: "label", name: "Written in this language", labelFor: "search_language" },
  { ref: "ref_65", role: "select", name: "", id: "search_language", options: ["Any language", "C", "C#", "C++", "CoffeeScript", "CSS"] },
  // Deliberately still broken: a label whose "for" never resolves, proving the remaining gap is
  // reported honestly rather than silently dropped or force-matched to the wrong field.
  { ref: "ref_90", role: "label", name: "Some future field", labelFor: "search_nonexistent" },
];
