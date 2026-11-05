# Retired browser-extension setup

M9R no longer installs or uses the browser extension for computer control.
Browser and app work use the native desktop runtime, so do not follow old
Developer Mode, Load unpacked, Native Messaging, or extension-refresh steps.

## Current setup

Connect the agent CLIs already installed on this machine and verify the result:

```powershell
npx m9r-cli connect
npx m9r-cli doctor
```

On Windows, broker login startup is optional. To register it later without
installing provider hooks or an extension, run:

```powershell
npx m9r-cli web setup --broker-only
```

## Remove a legacy extension-based setup

The uninstall command uses the saved M9R ownership manifest. It removes an
extension file only while its contents still match the recorded M9R hash, and
preserves files that were changed after installation. It likewise checks
recorded ownership before removing provider configuration, Native Messaging
registrations, or the broker login task.

Preview the removal first, then apply it when the displayed plan is correct:

```powershell
npx m9r-cli web uninstall --dry-run
npx m9r-cli web uninstall
```

If the ownership manifest is missing or invalid, M9R will not guess which
files or registrations belong to it. Inspect and remove those remnants
manually; do not load the old extension again.
