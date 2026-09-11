import { notFound } from "next/navigation";
import DashboardPreview from "./preview";

/** Local visual bench only. Never exposes workspace data or bypasses dashboard auth. */
export default function DashboardDesignPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <DashboardPreview />;
}
