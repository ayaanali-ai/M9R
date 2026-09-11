export type DashboardMode = "day" | "night";

export const DASHBOARD_MODE_EVENT = "m9r:dashboard-mode-change";
export const DASHBOARD_MODE_STORAGE_KEY = "m9r_mode";

export function normalizeDashboardMode(value: unknown): DashboardMode {
  return value === "night" ? "night" : "day";
}

export function nextDashboardMode(mode: DashboardMode): DashboardMode {
  return mode === "day" ? "night" : "day";
}

export function readDashboardMode(): DashboardMode {
  if (typeof document === "undefined") return "day";
  return normalizeDashboardMode(document.querySelector(".wf-root")?.getAttribute("data-bs-mode"));
}

export function applyDashboardMode(mode: DashboardMode): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const root = document.querySelector<HTMLElement>(".wf-root");
  if (!root) return;
  root.setAttribute("data-mode-transitioning", "true");
  try {
    window.localStorage.setItem(DASHBOARD_MODE_STORAGE_KEY, mode);
  } catch {
    // The visual mode still changes when storage is unavailable.
  }
  window.requestAnimationFrame(() => {
    root.setAttribute("data-bs-mode", mode);
    window.dispatchEvent(new CustomEvent<DashboardMode>(DASHBOARD_MODE_EVENT, { detail: mode }));
    window.setTimeout(() => root.removeAttribute("data-mode-transitioning"), 220);
  });
}
