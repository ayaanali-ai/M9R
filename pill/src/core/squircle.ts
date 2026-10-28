// Superellipse geometry for the pill's convex-outward corners.
// The flared top ears are separate SVG siblings in island.ts; this helper owns the
// rounded lower edge without changing the existing DOM or interaction contract.

function superellipsePoint(r: number, n: number, theta: number): [number, number] {
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const x = r * Math.sign(cosT) * Math.pow(Math.abs(cosT), 2 / n);
  const y = r * Math.sign(sinT) * Math.pow(Math.abs(sinT), 2 / n);
  return [x, y];
}

const SAMPLES_PER_CORNER = 10;

function cornerPoints(
  center: [number, number],
  r: number,
  signX: 1 | -1,
  signY: 1 | -1,
  n: number,
  reverse: boolean,
): [number, number][] {
  if (r <= 0) return [];
  const points: [number, number][] = [];
  for (let i = 0; i <= SAMPLES_PER_CORNER; i += 1) {
    const theta = (i / SAMPLES_PER_CORNER) * (Math.PI / 2);
    const [sx, sy] = superellipsePoint(r, n, theta);
    points.push([center[0] + signX * sx, center[1] + signY * sy]);
  }
  return reverse ? points.reverse() : points;
}

/** Build an SVG path for a rectangle whose selected corners use a convex squircle curve. */
export function squirclePath(
  w: number,
  h: number,
  radii: { tl?: number; tr?: number; br?: number; bl?: number },
  n = 4.5,
): string {
  const tl = Math.max(0, Math.min(radii.tl ?? 0, w / 2, h / 2));
  const tr = Math.max(0, Math.min(radii.tr ?? 0, w / 2, h / 2));
  const br = Math.max(0, Math.min(radii.br ?? 0, w / 2, h / 2));
  const bl = Math.max(0, Math.min(radii.bl ?? 0, w / 2, h / 2));

  const trPts = cornerPoints([w - tr, tr], tr, 1, -1, n, true);
  const brPts = cornerPoints([w - br, h - br], br, 1, 1, n, false);
  const blPts = cornerPoints([bl, h - bl], bl, -1, 1, n, true);
  const tlPts = cornerPoints([tl, tl], tl, -1, -1, n, false);

  const start: [number, number] = tl > 0 ? tlPts[tlPts.length - 1]! : [0, 0];
  const d: string[] = [`M ${start[0]} ${start[1]}`];
  const line = (p: [number, number]) => d.push(`L ${p[0]} ${p[1]}`);
  const curve = (pts: [number, number][]) => { for (const p of pts) d.push(`L ${p[0]} ${p[1]}`); };

  if (tr > 0) curve(trPts); else line([w, 0]);
  if (br > 0) curve(brPts); else line([w, h]);
  if (bl > 0) curve(blPts); else line([0, h]);
  if (tl > 0) curve(tlPts);
  d.push("Z");
  return d.join(" ");
}
