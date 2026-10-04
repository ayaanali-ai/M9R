import { redirect } from "next/navigation";

// Retired screen: its job moved into the chat and Settings.
export default function Page() {
  redirect("/dashboard/settings#workspace");
}
