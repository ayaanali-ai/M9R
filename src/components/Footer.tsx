import Link from "next/link";
import M9RMark from "@/components/M9RMark";
import { CONTACT_MAILTO } from "@/lib/contact";

const sections = [
  {
    title: "Product",
    links: [
      { href: "/", label: "Overview" },
      { href: "/agents", label: "Connect your agent" },
      { href: "/roadmap", label: "Roadmap" },
      { href: "/auth", label: "Enter workspace" },
      { href: "/pricing", label: "Pricing" },
    ],
  },
  {
    title: "Legal",
    links: [
      { href: "/security", label: "Security" },
      { href: "/privacy", label: "Privacy" },
      { href: "/terms", label: "Terms" },
      { href: "/acceptable-use", label: "Acceptable Use" },
      { href: "/data-processing", label: "Data Processing" },
    ],
  },
  {
    title: "Company",
    links: [
      { href: CONTACT_MAILTO, label: "Security contact" },
    ],
  },
];

export default function Footer() {
  return (
    <footer className="lp-foot">
      <div className="lp-wrap">
        <div className="lp-foot-grid">
          {sections.map((section) => (
            <div key={section.title}>
              <h4 className="lp-foot-col-title">{section.title}</h4>
              <ul className="lp-links lp-foot-links">
                {section.links.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href}>{link.label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="lp-foot-in lp-foot-bottom">
          <div className="lp-foot-brandline">
            <M9RMark animated={false} className="lp-brand-mark" />
            <span className="lp-copy">
              © {new Date().getFullYear()} M9R · the shared workspace for AI coding agents
            </span>
          </div>
          <p className="lp-copy lp-foot-note">
            Provider marks identify compatible connections only. Providers execute in their own
            environments; M9R is independent and is not endorsed by Anthropic, OpenAI, or xAI.
          </p>
        </div>
      </div>
    </footer>
  );
}

