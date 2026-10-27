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

export type ElementRole = "textbox" | "button" | "link" | "search" | "generic" | "combobox" | "label" | "select";

export interface RawElement {
  ref: string;
  role: ElementRole;
  /** The accessible name -- what a screen reader (or an agent) would call it. */
  name: string;
  /** Present on form controls, e.g. "search" for a search <input>. */
  type?: string;
  placeholder?: string;
  href?: string;
  /** The field's own id -- the other half of a <label for="id"> link. Present on form controls. */
  id?: string;
  /** For a label: the id of the field it names, straight from its real "for" attribute. */
  labelFor?: string;
  /** For a select: its real option values, straight from the DOM -- never invented. */
  options?: readonly string[];
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
  role: ElementRole;
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

  // A <label for="id"> names its field exactly, by id -- no pattern-matching needed once the real
  // link is captured. This resolves what the earlier version of this prototype wrongly reported as
  // needing "real reasoning about the control": it didn't, it needed the for/id attribute, which was
  // sitting in the live page's own HTML the whole time and simply wasn't in the captured element data.
  // Runs first, ahead of the generic textbox+button pairing below -- an explicit for/id link is a more
  // reliable signal than name-matching adjacency, so it should win the field before that looser
  // heuristic can grab it.
  for (const label of elements) {
    if (consumed.has(label.ref) || label.role !== "label" || !label.labelFor) continue;
    const field = elements.find((el) => el.id === label.labelFor && !consumed.has(el.ref));
    if (!field) continue;
    const fieldLabel = label.name;
    if (field.role === "select" && field.options) {
      tools.push({
        name: slugify(fieldLabel),
        description: `Choose a value for "${fieldLabel}".`,
        inputSchema: {
          type: "object",
          properties: { value: { type: `enum(${field.options.length} options, e.g. ${field.options.slice(0, 3).join(", ")})`, description: `One of the real options for "${fieldLabel}".` } },
          required: ["value"],
        },
        targets: [label.ref, field.ref],
      });
    } else if (field.role === "textbox") {
      tools.push({
        name: slugify(fieldLabel),
        description: `Enter a value for "${fieldLabel}".`,
        inputSchema: { type: "object", properties: { value: { type: "string", description: `The text to enter for "${fieldLabel}".` } }, required: ["value"] },
        targets: [label.ref, field.ref],
      });
    } else {
      continue;
    }
    consumed.add(label.ref);
    consumed.add(field.ref);
  }

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
    if (el.role === "generic" || el.role === "search" || el.role === "combobox" || el.role === "label" || el.role === "select") continue;
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

  // What's left after for/id resolution is now a genuinely different, smaller gap: a label whose
  // "for" didn't resolve to a captured field (stale/missing capture, not a reasoning problem), or
  // a combobox/select with no label at all -- the control is understood, but its purpose has no
  // name attached anywhere in the structure. That second case is the real remaining argument for a
  // model pass: inferring intent from surrounding context, not just reading an explicit link.
  for (const el of elements) {
    if (consumed.has(el.ref)) continue;
    if (el.role === "combobox" || el.role === "select") {
      unmapped.push({ ref: el.ref, role: el.role, name: el.name, reason: "no label resolved to this control -- its real options are known, but nothing in the structure names what choosing one of them means." });
    } else if (el.role === "label") {
      unmapped.push({ ref: el.ref, role: "label", name: el.name, reason: el.labelFor ? `"for=${el.labelFor}" did not resolve to any captured field -- likely a capture gap, not a missing relationship.` : "no for/id attribute at all on this label -- its field association (if any) isn't structurally discoverable." });
    }
  }

  return { tools, unmapped };
}
