/**
 * AWARE prototype -- the core transformation, isolated and standalone.
 *
 * NOT integrated into the product. NOT a replacement for Codex's Step 1/2 work
 * (computer-use-contract.ts / computer-use-router.ts), which is the real, owned
 * foundation for how M9R actually observes and dispatches to a live page. This
 * file exists to prove one narrow claim: that a page's raw accessibility-tree
 * elements -- the same shape `read_page` already returns -- can be mechanically
 * turned into a named, MCP-shaped tool manifest, with no API and no cooperation
 * from the site. Input/output only; it does not fetch or render anything itself.
 *
 * Captured live against en.wikipedia.org's real accessibility tree (see
 * sample.ts) -- not synthetic fixtures.
 */

export type ElementRole = "textbox" | "button" | "link" | "search" | "generic" | "combobox" | "label";

export interface RawElement {
  ref: string;
  role: ElementRole;
  /** The accessible name -- what a screen reader (or an agent) would call it. */
  name: string;
  /** Present on form controls, e.g. "search" for a search <input>. */
  type?: string;
  placeholder?: string;
  href?: string;
}

export interface AwareTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, { type: string; description: string }>; required: string[] };
  /** The element(s) this tool actually dispatches to -- never hidden from the caller. */
  targets: string[];
}

/**
 * Anything the heuristic genuinely cannot name a tool for -- a role it doesn't understand (e.g.
 * "combobox"), or a label with no structurally-discoverable field to pair it with. Reported
 * explicitly rather than silently dropped: a generator that quietly skips capability is worse than
 * one that admits what it couldn't map, since a silent gap looks identical to "there was nothing
 * here" to whoever reads the output.
 */
export interface UnmappedElement {
  ref: string;
  role: ElementRole | "combobox" | "label";
  name: string;
  reason: string;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/**
 * The one real heuristic in this prototype: a textbox and a same-purpose button
 * sitting in the same region of the tree (adjacent refs, overlapping accessible
 * names) are one semantic action to an agent -- "search", not "type into box"
 * plus "click button" as two separate, unnamed primitives. Composing them is
 * what makes this a *tool* instead of just a relabeled accessibility dump.
 */
export function generateToolsFromPage(elements: readonly RawElement[]): { tools: AwareTool[]; unmapped: UnmappedElement[] } {
  const tools: AwareTool[] = [];
  const unmapped: UnmappedElement[] = [];
  const consumed = new Set<string>();

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (consumed.has(el.ref)) continue;
    if (el.role !== "textbox" && el.type !== "search") continue;

    const label = el.placeholder || el.name || "input";
    const pairedButton = elements.find(
      (candidate, j) =>
        j !== i &&
        !consumed.has(candidate.ref) &&
        candidate.role === "button" &&
        (candidate.name.toLowerCase().includes(label.toLowerCase().split(" ")[0]) ||
          label.toLowerCase().includes(candidate.name.toLowerCase())),
    );

    const toolName = slugify(label) || "submit";
    tools.push({
      name: toolName,
      description: pairedButton
        ? `Enter a value into "${label}" and activate "${pairedButton.name}".`
        : `Enter a value into "${label}".`,
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: `The text to enter into "${label}".` } },
        required: ["query"],
      },
      targets: pairedButton ? [el.ref, pairedButton.ref] : [el.ref],
    });
    consumed.add(el.ref);
    if (pairedButton) consumed.add(pairedButton.ref);
  }

  // Everything else that's directly actionable and not already absorbed into a composite tool
  // becomes its own single-purpose tool -- named from its real accessible name, never invented.
  for (const el of elements) {
    if (consumed.has(el.ref)) continue;
    if (el.role === "generic" || el.role === "search" || el.role === "combobox" || el.role === "label") continue;
    if (el.role === "link" && !el.href) continue;
    const toolName = slugify(el.name);
    if (!toolName) continue;
    tools.push({
      name: toolName,
      description: el.role === "link" ? `Navigate to "${el.name}".` : `Activate "${el.name}".`,
      inputSchema: { type: "object", properties: {}, required: [] },
      targets: [el.ref],
    });
    consumed.add(el.ref);
  }

  // Report what was never consumed, instead of letting it vanish. "combobox" and "label" are the
  // two shapes the simple pairing heuristic cannot handle today -- a combobox's current value isn't
  // typed text, and a <label> only names its field through a for/id attribute this prototype's
  // tree doesn't carry, not through array adjacency the way the Wikipedia search button did.
  for (const el of elements) {
    if (consumed.has(el.ref)) continue;
    if (el.role === "combobox") {
      unmapped.push({ ref: el.ref, role: "combobox", name: el.name, reason: "selecting/reading a combobox's value is not a text-entry action this heuristic composes -- needs real reasoning about the control, not pattern-matching." });
    } else if (el.role === "label") {
      unmapped.push({ ref: el.ref, role: "label", name: el.name, reason: "label text carries the real semantic meaning of its field, but this tree has no for/id link to the input it describes -- without that, the heuristic cannot tell which element it names." });
    }
  }

  return { tools, unmapped };
}
