import Link from "next/link";
import type { Metadata } from "next";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import M9RMark from "@/components/M9RMark";

export const metadata: Metadata = {
  title: "Page not found — M9R",
  description: "This page isn't part of the workspace. Return to the homepage.",
};

export default function NotFound() {
  return (
    <div className="lp lp-page">
      <div className="lp-atmos" aria-hidden />
      <Nav />
      <main className="lp-404">
        <div className="lp-404-in">
          <M9RMark />
          <div className="lp-404-code">Error 404 · no record on file</div>
          <h1>This page isn&apos;t in the ledger.</h1>
          <p>
            The page you asked for doesn&apos;t exist, or it moved. Nothing was lost, so you can pick
            the trail back up below.
          </p>
          <div className="lp-404-row">
            <Link href="/" className="lp-btn lp-btn-primary">
              Back to homepage
            </Link>
            <Link href="/pricing" className="lp-btn lp-btn-ghost">
              See what M9R does
            </Link>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
