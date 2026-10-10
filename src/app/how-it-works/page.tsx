import type { Metadata } from "next";
import ReferenceGuide from "@/components/reference/ReferenceGuide";
import ReferencePage from "@/components/reference/ReferencePage";
export const metadata: Metadata = { title: "How M9R works", description: "Actual commands, manual steps, and native preview boundaries." };
export default function HowItWorks() {
  return <ReferencePage title={<>Stay where<br />you work.</>} intro="M9R connects agents without becoming their new runtime. Here is what to install, what to approve, and what still needs you."><ReferenceGuide /></ReferencePage>;
}
