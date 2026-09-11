import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import sharp from "sharp";

const snapshotPath = resolve(
  process.argv[2] ?? "docs/research/proof-of-product/exports/snapshot-2026-07-29.json",
);
if (!existsSync(snapshotPath)) {
  throw new Error(`Snapshot not found: ${snapshotPath}`);
}

const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
const date = snapshot.generated_at.slice(0, 10);
const outputDir = resolve(dirname(snapshotPath), `graphs-${date}`);
mkdirSync(outputDir, { recursive: true });

const W = 1600;
const H = 900;
const C = {
  background: "#090A0C",
  panel: "#111318",
  panelSoft: "#171A20",
  text: "#F4F2ED",
  muted: "#9CA2AE",
  grid: "#292D35",
  red: "#A32935",
  redBright: "#D74B58",
  blue: "#4C89FF",
  green: "#42C98A",
  amber: "#E7A84A",
  white: "#FFFFFF",
};

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function svgFrame({ eyebrow, title, subtitle, content, source, limitation }) {
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="${C.background}"/>
    <rect x="42" y="42" width="1516" height="816" rx="28" fill="${C.panel}" stroke="${C.grid}" stroke-width="2"/>
    <text x="90" y="105" fill="${C.redBright}" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="700" letter-spacing="4">${esc(eyebrow.toUpperCase())}</text>
    <text x="90" y="177" fill="${C.text}" font-family="Arial, Helvetica, sans-serif" font-size="52" font-weight="800">${esc(title)}</text>
    <text x="90" y="224" fill="${C.muted}" font-family="Arial, Helvetica, sans-serif" font-size="25">${esc(subtitle)}</text>
    ${content}
    <line x1="90" y1="770" x2="1510" y2="770" stroke="${C.grid}" stroke-width="2"/>
    <text x="90" y="812" fill="${C.muted}" font-family="Arial, Helvetica, sans-serif" font-size="19">${esc(source)}</text>
    <text x="90" y="842" fill="${C.muted}" font-family="Arial, Helvetica, sans-serif" font-size="17">${esc(limitation)}</text>
    <text x="1450" y="825" text-anchor="end" fill="${C.text}" font-family="Arial, Helvetica, sans-serif" font-size="25" font-weight="800">OATHLOCK</text>
  </svg>`;
}

function horizontalBars(rows, { x = 340, y = 310, width = 1040, rowGap = 118, max }) {
  return rows
    .map((row, index) => {
      const yy = y + index * rowGap;
      const barWidth = Math.max(10, (row.value / max) * width);
      return `
        <text x="${x - 28}" y="${yy + 24}" text-anchor="end" fill="${C.text}" font-family="Arial, Helvetica, sans-serif" font-size="25" font-weight="700">${esc(row.label)}</text>
        <rect x="${x}" y="${yy}" width="${width}" height="34" rx="17" fill="${C.grid}"/>
        <rect x="${x}" y="${yy}" width="${barWidth}" height="34" rx="17" fill="${row.color}"/>
        <text x="${x + barWidth + 22}" y="${yy + 26}" fill="${C.text}" font-family="Arial, Helvetica, sans-serif" font-size="25" font-weight="800">${esc(row.value)}</text>`;
    })
    .join("");
}

const modeRows = [
  {
    label: "Solo",
    value: snapshot.token_efficiency_by_mode.solo.runCount,
    color: C.grid,
  },
  {
    label: "Coordinated",
    value: snapshot.token_efficiency_by_mode.coordinated.runCount,
    color: C.blue,
  },
  {
    label: "Collaborative",
    value: snapshot.token_efficiency_by_mode.collaborative.runCount,
    color: C.green,
  },
];
const teamRuns = modeRows[1].value + modeRows[2].value;
const totalRuns = snapshot.real_counts.agent_runs;
const teamShare = Math.round((teamRuns / totalRuns) * 100);

const modeSvg = svgFrame({
  eyebrow: "Live dogfood data",
  title: "Agents are not limited to isolated runs",
  subtitle: `${teamRuns} of ${totalRuns} recorded runs used a coordinated or collaborative mode.`,
  content: `
    ${horizontalBars(modeRows, { max: Math.max(...modeRows.map((row) => row.value)) })}
    <rect x="1040" y="610" width="390" height="102" rx="18" fill="${C.panelSoft}" stroke="${C.grid}"/>
    <text x="1070" y="651" fill="${C.muted}" font-family="Arial, Helvetica, sans-serif" font-size="20">TEAM-MODE SHARE</text>
    <text x="1070" y="695" fill="${C.white}" font-family="Arial, Helvetica, sans-serif" font-size="43" font-weight="800">${teamShare}%</text>
  `,
  source: `Source: ${basename(snapshotPath)} • generated ${snapshot.generated_at}`,
  limitation:
    "Mode counts prove recorded use of coordination; they do not prove a performance uplift versus matched solo tasks.",
});

const decisions = snapshot.result_adoption_outcomes;
const decisionRows = [
  { label: "Adopted", value: decisions.adopted, color: C.green },
  { label: "Rejected", value: decisions.rejected, color: C.redBright },
  { label: "Challenged", value: decisions.challenged, color: C.amber },
];
const decisionTotal = decisionRows.reduce((sum, row) => sum + row.value, 0);
const decisionsSvg = svgFrame({
  eyebrow: "Recorded result decisions",
  title: "OathLock records judgment—not automatic agreement",
  subtitle: "Supporting-agent output can be adopted, rejected, or challenged by the requesting agent.",
  content: `
    ${horizontalBars(decisionRows, { max: Math.max(1, ...decisionRows.map((row) => row.value)) })}
    <rect x="1040" y="610" width="390" height="102" rx="18" fill="${C.panelSoft}" stroke="${C.grid}"/>
    <text x="1070" y="651" fill="${C.muted}" font-family="Arial, Helvetica, sans-serif" font-size="20">RECORDED DECISIONS</text>
    <text x="1070" y="695" fill="${C.white}" font-family="Arial, Helvetica, sans-serif" font-size="43" font-weight="800">n = ${decisionTotal}</text>
  `,
  source: `Source: live result_adoptions aggregate • generated ${snapshot.generated_at}`,
  limitation:
    "Small dogfood sample (n=4). This proves the adopt/reject mechanism is used; it is not a statistical success rate.",
});

function metricPanel({ x, y, value, label, detail, color }) {
  return `
    <rect x="${x}" y="${y}" width="650" height="170" rx="24" fill="${C.panelSoft}" stroke="${C.grid}" stroke-width="2"/>
    <rect x="${x}" y="${y}" width="10" height="170" rx="5" fill="${color}"/>
    <text x="${x + 44}" y="${y + 78}" fill="${C.white}" font-family="Arial, Helvetica, sans-serif" font-size="58" font-weight="800">${esc(value)}</text>
    <text x="${x + 44}" y="${y + 118}" fill="${C.text}" font-family="Arial, Helvetica, sans-serif" font-size="25" font-weight="700">${esc(label)}</text>
    <text x="${x + 44}" y="${y + 148}" fill="${C.muted}" font-family="Arial, Helvetica, sans-serif" font-size="18">${esc(detail)}</text>
  `;
}

const proofSvg = svgFrame({
  eyebrow: "Execution evidence",
  title: "The coordination layer leaves a measurable record",
  subtitle: "Runs become events, bounded assignments, and explicit result decisions.",
  content: `
    ${metricPanel({
      x: 90,
      y: 285,
      value: snapshot.real_counts.agent_runs,
      label: "Recorded agent runs",
      detail: "Across all run modes",
      color: C.blue,
    })}
    ${metricPanel({
      x: 810,
      y: 285,
      value: snapshot.real_counts.agent_run_events.toLocaleString("en-US"),
      label: "Recorded run events",
      detail: `${(snapshot.real_counts.agent_run_events / snapshot.real_counts.agent_runs).toFixed(1)} events per run`,
      color: C.green,
    })}
    ${metricPanel({
      x: 90,
      y: 500,
      value: snapshot.real_counts.agent_assignments,
      label: "Bounded assignments",
      detail: "Delegated work recorded",
      color: C.amber,
    })}
    ${metricPanel({
      x: 810,
      y: 500,
      value: snapshot.real_counts.result_adoptions,
      label: "Explicit result decisions",
      detail: "Adopted, rejected, or challenged",
      color: C.redBright,
    })}
  `,
  source: `Source: live database count queries • generated ${snapshot.generated_at}`,
  limitation:
    "Counts establish operation and traceability. They do not independently establish quality improvement or causal impact.",
});

const outputs = [
  ["01-agent-run-modes", modeSvg],
  ["02-result-decisions", decisionsSvg],
  ["03-evidence-record", proofSvg],
];

for (const [name, svg] of outputs) {
  writeFileSync(resolve(outputDir, `${name}.svg`), svg);
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(resolve(outputDir, `${name}.png`));
}

const readme = `# OathLock proof graphs — ${date}

Generated from \`${basename(snapshotPath)}\`, which is sourced from the live
database and the same aggregate metric functions used by the dashboard.

## Assets

- \`01-agent-run-modes.png\` — recorded run modes; 59 of 211 were coordinated
  or collaborative.
- \`02-result-decisions.png\` — 3 adopted, 1 rejected, 0 challenged; explicitly
  labeled as a small dogfood sample (n=4).
- \`03-evidence-record.png\` — 211 runs, 1,066 events, 32 bounded assignments,
  and 4 explicit result decisions.

## Claim boundary

These charts prove that OathLock is recording real controlled runs, multi-agent
run modes, bounded assignments, and explicit result decisions. They do not
prove that OathLock improves quality, speed, or cost versus isolated agents.
That stronger claim requires a preregistered matched-task benchmark with solo
and coordinated arms.
`;
writeFileSync(resolve(outputDir, "README.md"), readme);

console.log(
  JSON.stringify({
    snapshot: snapshotPath,
    outputDir,
    assets: outputs.flatMap(([name]) => [`${name}.png`, `${name}.svg`]),
  }),
);
