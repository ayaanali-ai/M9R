import { redirect } from "next/navigation";

// /leaks was the entry point for the earlier trace-analyzer product. That
// product no longer exists as a standalone surface -- M9R is the
// Watchfloor/evidence-and-rules product now -- and there's no direct
// successor page to send old links to, so this sends them to the real
// homepage instead of the previous target ("/detectors", a route that was
// never built, so this redirect 404'd for every visitor who followed it).
export default function LegacyLeaksRedirect() {
  redirect("/");
}
