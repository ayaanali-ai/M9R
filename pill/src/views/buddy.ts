// M9R's own buddy character: a round, big-eyed creature tinted in each agent's colour. Home uses it the way
// HeyClicky uses its characters -- a face per agent in the sidebar, and a large one peeking over the input pill.
// Original artwork drawn here in SVG; no third-party character art.

const NS = "http://www.w3.org/2000/svg";

function node<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** `#rrggbb` mixed toward black (amount < 0) or white (amount > 0). */
function mix(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const target = amount < 0 ? 0 : 255;
  const t = Math.abs(amount);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * (1 - t) + target * t);
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

/**
 * The buddy's face. `hero` adds the two paws that rest on the input pill and leaves the bottom open,
 * so the character reads as peeking over it. The look varies a little by `seed` (hair tuft, eye glint).
 */
export function buddy(color: string, size: number, opts: { hero?: boolean; seed?: string } = {}): SVGSVGElement {
  const hero = !!opts.hero;
  const seed = [...(opts.seed ?? "")].reduce((a, c) => a + c.charCodeAt(0), 0);
  const line = "#15161a";
  const skin = "#f6e6d4";
  const hair = color;
  const hairDark = mix(color, -0.28);
  const hairLight = mix(color, 0.35);

  const el = node("svg", { viewBox: hero ? "0 0 120 100" : "0 0 100 100", width: size, height: hero ? Math.round(size * 100 / 120) : size, "aria-hidden": "true", class: "buddy" });
  const g = node("g", hero ? { transform: "translate(10 4)" } : {});
  el.append(g);

  // Round "bun" ears, behind the head.
  for (const cx of [20, 80]) {
    g.append(node("circle", { cx, cy: 26, r: 14, fill: hairDark, stroke: line, "stroke-width": 2.6 }));
    g.append(node("circle", { cx, cy: 26, r: 7, fill: hairLight, opacity: 0.55 }));
  }
  // Head (hair colour) and the face patch.
  g.append(node("ellipse", { cx: 50, cy: 54, rx: 40, ry: 37, fill: hair, stroke: line, "stroke-width": 2.6 }));
  g.append(node("path", { d: "M17 62 C 17 40, 32 34, 50 34 C 68 34, 83 40, 83 62 C 83 80, 68 90, 50 90 C 32 90, 17 80, 17 62 Z", fill: skin, stroke: line, "stroke-width": 2.2 }));
  // Fringe: three soft locks, the middle one varies.
  const mid = 50 + ((seed % 3) - 1) * 6;
  g.append(node("path", {
    d: `M18 56 C 22 36, 36 26, ${mid} 28 C ${mid - 2} 38, ${mid - 10} 44, 30 48 C 40 44, ${mid + 4} 40, ${mid + 6} 32 C 66 40, 76 46, 82 56 C 82 34, 70 18, 50 18 C 30 18, 18 34, 18 56 Z`,
    fill: hair, stroke: line, "stroke-width": 2.2, "stroke-linejoin": "round",
  }));
  g.append(node("path", { d: "M30 26 C 36 21, 44 20, 50 21", fill: "none", stroke: hairLight, "stroke-width": 3, "stroke-linecap": "round", opacity: 0.8 }));
  // Big eyes with glints.
  for (const cx of [37, 63]) {
    g.append(node("ellipse", { cx, cy: 63, rx: 10, ry: 12, fill: "#ffffff", stroke: line, "stroke-width": 2.2 }));
    g.append(node("ellipse", { cx: cx + 1, cy: 64, rx: 7.2, ry: 9, fill: line }));
    g.append(node("circle", { cx: cx + 3.4, cy: 59.5, r: 3, fill: "#ffffff" }));
    g.append(node("circle", { cx: cx - 1.8, cy: 68, r: 1.3, fill: "#ffffff", opacity: 0.85 }));
  }
  // Blush and a small mouth.
  for (const cx of [24, 76]) g.append(node("ellipse", { cx, cy: 76, rx: 5, ry: 2.6, fill: "#f08a8a", opacity: 0.5 }));
  g.append(node("path", { d: "M46 80 Q 50 83.5 54 80", fill: "none", stroke: line, "stroke-width": 2, "stroke-linecap": "round" }));

  if (hero) {
    // Paws resting on the pill below.
    for (const cx of [28, 72]) {
      g.append(node("ellipse", { cx, cy: 90, rx: 11, ry: 7.5, fill: skin, stroke: line, "stroke-width": 2.4 }));
      g.append(node("path", { d: `M${cx - 3} 85.5 v4 M${cx + 3} 85.5 v4`, stroke: line, "stroke-width": 1.6, "stroke-linecap": "round" }));
    }
  }
  return el;
}
