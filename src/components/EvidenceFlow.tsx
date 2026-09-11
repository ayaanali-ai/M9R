// Compact trace-to-policy flow visual. Pure presentation — no data fetching,
// no provider calls. Steps are passed in as [label, description] pairs.
export default function EvidenceFlow({
  steps,
}: {
  steps: Array<[string, string]>;
}) {
  return (
    <ol className="space-y-2">
      {steps.map(([label, desc], i) => (
        <li
          key={label}
          className="bg-[#111] border border-[#222] rounded-lg p-3 flex gap-3 items-start"
        >
          <span className="text-[11px] font-mono text-lime shrink-0 mt-0.5">
            {String(i + 1).padStart(2, "0")}
          </span>
          <div>
            <div className="text-sm font-medium flex items-center gap-2">
              {label}
              {i < steps.length - 1 && <span className="text-muted text-xs">→</span>}
            </div>
            <p className="text-xs text-muted leading-relaxed mt-0.5">{desc}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
