export default function DashboardLoading() {
  return (
    <div className="dashboard-loading" role="status" aria-label="Loading workspace">
      <div className="dashboard-loading-block h-2 w-28" style={{ borderRadius: "var(--ol-radius-sm)" }} />
      <div className="dashboard-loading-block mt-4 h-8 w-64" style={{ borderRadius: "var(--ol-radius-sm)" }} />
      <div className="dashboard-loading-block mt-2 h-4 w-96 max-w-full" style={{ borderRadius: "var(--ol-radius-sm)" }} />
      <div className="mt-8 grid gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((item) => (
          <div key={item} className="dashboard-loading-block h-16" style={{ borderRadius: "var(--ol-radius-md)" }} />
        ))}
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-[1.5fr_0.8fr]">
        <div className="dashboard-loading-block h-80" style={{ borderRadius: "var(--ol-radius-lg)" }} />
        <div className="space-y-4">
          <div className="dashboard-loading-block h-40" style={{ borderRadius: "var(--ol-radius-lg)" }} />
          <div className="dashboard-loading-block h-32" style={{ borderRadius: "var(--ol-radius-lg)" }} />
        </div>
      </div>
      <span className="sr-only">Loading workspace</span>
    </div>
  );
}
