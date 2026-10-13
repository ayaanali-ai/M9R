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
 * Real elements captured live from github.com/search/advanced -- deliberately harder than the
 * Wikipedia case. A label here is a separate element from the field it names (no array-adjacency
 * clue), and the language picker is a "combobox", a role the Wikipedia sample never exercised.
 */
export const GITHUB_ADVANCED_SEARCH_ELEMENTS: RawElement[] = [
  { ref: "ref_7", role: "textbox", name: "" },
  { ref: "ref_8", role: "button", name: "Search" },
  { ref: "ref_58", role: "label", name: "From these owners" },
  { ref: "ref_64", role: "label", name: "Written in this language" },
  { ref: "ref_65", role: "combobox", name: "Any language" },
];
