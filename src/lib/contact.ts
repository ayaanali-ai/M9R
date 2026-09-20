// Single source of truth for the public M9R contact address. Until M9R has its own domain this is the only mailbox that
// actually delivers; swap it here (one line) when the domain and routing exist.. Import this
// everywhere a public page shows or links the contact/security/privacy/legal
// email, instead of hardcoding the address in each file.
export const CONTACT_EMAIL = "runleak@proton.me";
export const CONTACT_MAILTO = `mailto:${CONTACT_EMAIL}`;
