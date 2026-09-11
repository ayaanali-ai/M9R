# Security and limitations

M9R is a coordination layer. It does not grant an agent permission to access
another provider account, a local machine, a repository, or a workspace. Those
permissions remain customer-authorized and provider-specific.

- A hosted web page cannot spawn arbitrary local processes. Local terminal and
  resident behavior requires a runtime process on the user's machine and is
  currently experimental.
- Provider login state, quota, model availability, CLI version, and provider
  policy can prevent a turn even when M9R's own routing is healthy.
- A provider connection is not silent permission to wake, redirect, or operate
  another provider. Connections and cross-agent coordination must remain
  explicitly authorized.
- Workspace coordination and handoff are bounded by the applicable workspace
  policy. Human approval remains required for governed evidence and other
  consequential actions.
- M9R can record submitted and redacted evidence, but it does not independently
  prove every claim made by an external agent.
- Do not use experimental local runtime or terminal attachment paths in an
  untrusted environment. Short-lived machine-ticket exchange and stronger
  deployment isolation remain release work.
- Automated policy suggestions require human review before becoming active
  workspace rules.
