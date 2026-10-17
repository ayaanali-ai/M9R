import { generateToolsFromPage } from "./generator";
import { WIKIPEDIA_MAIN_PAGE_ELEMENTS, GITHUB_ADVANCED_SEARCH_ELEMENTS } from "./sample";

console.log("=== Wikipedia main page (the easy case) ===");
console.log(JSON.stringify(generateToolsFromPage(WIKIPEDIA_MAIN_PAGE_ELEMENTS), null, 2));

console.log("\n=== GitHub advanced search (the hard case) ===");
console.log(JSON.stringify(generateToolsFromPage(GITHUB_ADVANCED_SEARCH_ELEMENTS), null, 2));
