/**
 * PixelOperator — original pixel-sprite operators for the Watchfloor ops floor.
 * ----------------------------------------------------------------------------
 * Deliberately ORIGINAL characters (Gate 4: "do not copy provider mascots").
 * Every agent kind shares one seated-operator body; identity comes from the
 * head silhouette, which echoes the agent's abstract glyph (✳ ◎ ▣ ✦) — ours,
 * not a provider's mark.
 *
 * Truth contract: the sprite's animation state is chosen by the CALLER from
 * real presence data. This module only draws; it never decides that an agent
 * is working. Working is the only animated state (2 frames) because it is the
 * only state backed by a fresh live-run observation; asleep gets a slow
 * drifting-z, waiting and offline are static.
 */

const W = 14;
const H = 11;

type Frame = string[];

/** Head silhouettes, 6 wide × 4 tall, inserted at col 1. Echoes each agent's glyph. */
const HEADS: Record<string, Frame> = {
  // ✳ star spikes
  "claude-code": [
    ".H..H.",
    "..HH..",
    ".HHHH.",
    "..HH..",
  ],
  // ◎ ring
  codex: [
    "......",
    ".HHHH.",
    ".H..H.",
    ".HHHH.",
  ],
  // ▣ block
  cursor: [
    "......",
    ".HHHH.",
    ".HHHH.",
    ".HHHH.",
  ],
  // ✦ diamond
  opencode: [
    "..HH..",
    ".HHHH.",
    ".HHHH.",
    "..HH..",
  ],
  other: [
    "......",
    "..HH..",
    ".HHHH.",
    "..HH..",
  ],
};

/** Seated body + console, rows 4–10. `A` is the arm, `S` live screen, `s` dim screen, `C` console. */
const BODY_WORK_A: Frame = [
  "..BBBB...SSS..",
  ".BBBBBA..SSS..",
  ".BBBB..A.CCC..",
  "..BB....CCC...",
  "..BB....CC....",
  ".BBBB...CC....",
  "..............",
];
const BODY_WORK_B: Frame = [
  "..BBBB...SSS..",
  ".BBBBB...SSS..",
  ".BBBB..AACCC..",
  "..BB....CCC...",
  "..BB....CC....",
  ".BBBB...CC....",
  "..............",
];
const BODY_WAIT: Frame = [
  "..BBBB.A.SSS..",
  ".BBBBB.A.SSS..",
  ".BBBB....CCC..",
  "..BB....CCC...",
  "..BB....CC....",
  ".BBBB...CC....",
  "..............",
];
/** Asleep: head sits one row lower (composed separately), dim screen, z-drift. */
const BODY_SLEEP: Frame = [
  "..BBBB...sss..",
  ".BBBBB...sss..",
  ".BBBB....CCC..",
  "..BB....CCC...",
  "..BB....CC....",
  ".BBBB...CC....",
  "..............",
];
/** Offline: an empty chair at a dark console. No operator — absence is the honest visual. */
const OFFLINE: Frame = [
  "..............",
  "..............",
  "..............",
  "..............",
  ".........sss..",
  ".........sss..",
  ".........CCC..",
  "........CCC...",
  "..CC....CC....",
  ".CCCC...CC....",
  "..............",
];

export type OperatorState = "working" | "waiting" | "asleep" | "offline";

function blank(): string[] {
  return Array.from({ length: H }, () => ".".repeat(W));
}

function stamp(rows: string[], art: Frame, atRow: number, atCol: number): string[] {
  const out = [...rows];
  art.forEach((line, r) => {
    const row = atRow + r;
    if (row < 0 || row >= H) return;
    const chars = out[row].split("");
    line.split("").forEach((ch, c) => {
      const col = atCol + c;
      if (ch !== "." && col >= 0 && col < W) chars[col] = ch;
    });
    out[row] = chars.join("");
  });
  return out;
}

function composeFrames(agentKey: string, state: OperatorState): Frame[] {
  const head = HEADS[agentKey] ?? HEADS.other;
  if (state === "offline") return [OFFLINE];
  if (state === "asleep") {
    // Head drops one row; the z pixels drift between frames.
    const base = stamp(stamp(blank(), head, 1, 1), BODY_SLEEP, 4, 0);
    const a = stamp(base, ["G"], 0, 10);
    const b = stamp(base, ["G"], 1, 11);
    return [a, b];
  }
  if (state === "waiting") {
    return [stamp(stamp(blank(), head, 0, 1), BODY_WAIT, 4, 0)];
  }
  return [
    stamp(stamp(blank(), head, 0, 1), BODY_WORK_A, 4, 0),
    stamp(stamp(blank(), head, 0, 1), BODY_WORK_B, 4, 0),
  ];
}

const PIXEL_CLASS: Record<string, string> = {
  H: "wo-px-head",
  B: "wo-px-body",
  A: "wo-px-body",
  C: "wo-px-chrome",
  S: "wo-px-screen",
  s: "wo-px-screen-dim",
  G: "wo-px-z",
};

function FrameArt({ frame }: { frame: Frame }) {
  return (
    <>
      {frame.flatMap((row, r) =>
        row.split("").map((ch, c) =>
          ch === "." ? null : (
            <rect key={`${r}-${c}`} className={PIXEL_CLASS[ch]} x={c} y={r} width={1.02} height={1.02} />
          ),
        ),
      )}
    </>
  );
}

export default function PixelOperator({
  agentKey,
  state,
  size = 70,
}: {
  agentKey: string;
  state: OperatorState;
  size?: number;
}) {
  const frames = composeFrames(agentKey, state);
  return (
    <svg
      className="wo-sprite"
      data-state={state}
      viewBox={`0 0 ${W} ${H}`}
      width={size}
      height={Math.round((size * H) / W)}
      shapeRendering="crispEdges"
      aria-hidden
    >
      {frames.length > 1 ? (
        <>
          <g className="wo-frame-a"><FrameArt frame={frames[0]} /></g>
          <g className="wo-frame-b"><FrameArt frame={frames[1]} /></g>
        </>
      ) : (
        <FrameArt frame={frames[0]} />
      )}
    </svg>
  );
}
