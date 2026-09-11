"use client";

import { useState } from "react";
import {
  calculateResourceLedger,
  DEPLOYMENT_LABELS,
  DEPLOYMENT_INTERPRETATION,
  REQUIRED_LEDGER_CAVEAT,
  type DeploymentMode,
} from "@/lib/resource-ledger";

type MassEnergyLedgerProps = {
  totalTokens: number;
  wastedTokens: number;
  totalCostUsd?: number;
  wastedCostUsd?: number;
  totalLatencyMs?: number;
  wastedLatencyMs?: number;
  defaultJoulesPer1kTokens?: number;
};

// Default joules-per-1k-tokens is a configurable modeling assumption, not a
// measured constant.
const DEFAULT_JOULES_PER_1K = 250;

const MODES: DeploymentMode[] = [
  "earth_datacenter",
  "edge_robotics",
  "orbital_compute",
  "mars_habitat",
];

export default function MassEnergyLedger({
  totalTokens,
  wastedTokens,
  totalCostUsd,
  wastedCostUsd,
  totalLatencyMs,
  wastedLatencyMs,
  defaultJoulesPer1kTokens = DEFAULT_JOULES_PER_1K,
}: MassEnergyLedgerProps) {
  const [joules, setJoules] = useState(defaultJoulesPer1kTokens);
  const [mode, setMode] = useState<DeploymentMode>("earth_datacenter");

  const ledger = calculateResourceLedger({
    totalTokens,
    wastedTokens,
    totalCostUsd,
    wastedCostUsd,
    totalLatencyMs,
    wastedLatencyMs,
    joulesPer1kTokens: joules,
    deploymentMode: mode,
  });

  const usefulPct = ledger.totalTokens > 0
    ? Math.max(0, 100 - ledger.wasteFraction * 100)
    : 100;
  const wastePct = 100 - usefulPct;

  return (
    <section className="bg-[#0d0d0d] border border-[#1a1a1a] rounded-xl p-6">
      <div className="flex items-center gap-2 text-sm font-semibold mb-1">
        <span className="w-2 h-2 rounded-full bg-lime" />
        Mass &amp; Energy Ledger
      </div>
      <p className="text-xs text-muted mb-5 leading-relaxed">
        Trace-derived waste, translated into estimated resource burden. Energy and
        heat are modeled from a configurable joules-per-1k-tokens assumption.
      </p>

      {/* Assumption controls */}
      <div className="bg-[#111] border border-[#222] rounded-lg p-4 mb-5 flex flex-col sm:flex-row sm:items-end gap-4">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted font-mono uppercase tracking-wider text-[11px]">
            Joules / 1,000 tokens (assumption)
          </span>
          <input
            type="number"
            min={0}
            value={joules}
            onChange={(e) => setJoules(Math.max(0, Number(e.target.value) || 0))}
            className="bg-black border border-[#2a2a2a] rounded px-3 py-2 text-sm font-mono w-40 focus:border-lime outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted font-mono uppercase tracking-wider text-[11px]">
            Deployment mode
          </span>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as DeploymentMode)}
            className="bg-black border border-[#2a2a2a] rounded px-3 py-2 text-sm w-56 focus:border-lime outline-none"
          >
            {MODES.map((m) => (
              <option key={m} value={m}>
                {DEPLOYMENT_LABELS[m]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            setJoules(defaultJoulesPer1kTokens);
            setMode("earth_datacenter");
          }}
          className="text-xs border border-[#2a2a2a] rounded px-3 py-2 text-muted hover:text-white hover:border-[#444] transition-colors"
        >
          Reset assumptions
        </button>
      </div>

      {/* Metric cards */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-5">
        <Metric
          label="Token Waste"
          value={`${ledger.wastedTokens.toLocaleString()} tok`}
          sub={`${(ledger.wasteFraction * 100).toFixed(1)}% of ${ledger.totalTokens.toLocaleString()}`}
          tone="red"
        />
        <Metric
          label="Dollar Waste"
          value={ledger.wastedCostUsd != null ? `$${ledger.wastedCostUsd.toFixed(2)}` : "—"}
          sub={ledger.totalCostUsd != null ? `of $${ledger.totalCostUsd.toFixed(2)} est.` : "estimate"}
          tone="red"
        />
        <Metric
          label="Latency Waste"
          value={ledger.wastedLatencyMs != null ? `${(ledger.wastedLatencyMs / 1000).toFixed(1)}s` : "—"}
          sub={ledger.totalLatencyMs != null ? `of ${(ledger.totalLatencyMs / 1000).toFixed(1)}s est.` : "estimate"}
        />
        <Metric
          label="Estimated Energy"
          value={`${ledger.totalEnergyWh.toFixed(2)} Wh`}
          sub={`${ledger.avoidableEnergyWh.toFixed(2)} Wh avoidable`}
        />
        <Metric
          label="Estimated Avoidable Heat"
          value={`${ledger.avoidableHeatWh.toFixed(2)} Wh`}
          sub="heat modeled 1:1 with energy"
          tone="red"
        />
        <Metric
          label="Modeled Infrastructure Burden Index"
          value={ledger.infrastructureBurdenIndex.toFixed(0)}
          sub="relative score 0–100, not physical mass"
        />
      </div>

      {/* Useful vs waste bar */}
      <div className="mb-5">
        <div className="flex items-center justify-between text-[11px] font-mono text-muted mb-1.5">
          <span>Useful compute {usefulPct.toFixed(0)}%</span>
          <span>Avoidable waste {wastePct.toFixed(0)}%</span>
        </div>
        <div className="flex h-3 rounded overflow-hidden border border-[#222]">
          <div className="bg-lime" style={{ width: `${usefulPct}%` }} />
          <div className="bg-red" style={{ width: `${wastePct}%` }} />
        </div>
      </div>

      {/* Deployment interpretation */}
      <div className="bg-[#111] border border-[#222] rounded-lg p-4 mb-3">
        <div className="text-[11px] font-mono text-muted uppercase tracking-wider mb-1">
          {DEPLOYMENT_LABELS[mode]} interpretation
        </div>
        <p className="text-sm text-muted leading-relaxed">
          {DEPLOYMENT_INTERPRETATION[mode]}
        </p>
      </div>

      {/* Required caveat */}
      <p className="text-xs text-muted leading-relaxed border-t border-[#1a1a1a] pt-3">
        {REQUIRED_LEDGER_CAVEAT}
      </p>
    </section>
  );
}

function Metric({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "red";
}) {
  return (
    <div className="bg-[#111] border border-[#222] rounded-lg p-4">
      <div className="text-[11px] text-muted mb-1 font-mono">{label}</div>
      <div className={`text-xl font-bold ${tone === "red" ? "text-red" : "text-white"}`}>
        {value}
      </div>
      {sub && <div className="text-[11px] text-muted mt-1 font-mono">{sub}</div>}
    </div>
  );
}
