# Third-party notices

M9R's Windows desktop-stage runtime bundles the following Cua Driver components. These notices cover only the Driver/runtime packages and do not include Cua Spaces, Keyvault, Volume, `cua-som`, OmniParser, or other AGPL/source-available components.

| Component | Version | License | Source |
| --- | --- | --- | --- |
| `@trycua/cua-driver` | 0.33.4 | MIT | <https://github.com/trycua/cua> |
| `@trycua/cua-driver-win32-x64-msvc` | 0.33.4 | MIT AND MPL-2.0 | <https://github.com/trycua/cua> |
| Cua Driver Windows standalone host, UI helper, and cursor-theme helper | 0.33.4 | MIT | <https://github.com/trycua/cua> |
| `@ubjs/core` | 0.31.0-3 | MPL-2.0 | <https://github.com/jhugman/uniffi-bindgen-react-native/tree/v0.31.0-3> |
| `@ubjs/node` | 0.31.0-3 | MPL-2.0 | <https://github.com/jhugman/uniffi-bindgen-react-native/tree/v0.31.0-3> |
| `@ubjs/node-win32-x64-msvc` | 0.31.0-3 | MPL-2.0 | <https://github.com/jhugman/uniffi-bindgen-react-native/tree/v0.31.0-3> |

The Cua Driver source, SDK, and standalone Windows host are MIT-licensed. The Windows native runtime package also contains the UniFFI N-API compatibility runtime; its package notice identifies the corresponding pinned source and MPL-2.0 terms. Full license texts are included in `licenses/MIT-Cua.txt` and `licenses/MPL-2.0.txt`. The package's upstream `node-runtime-NOTICE.md` is preserved alongside the staged native runtime.

## Scope of the integration

M9R uses the Driver SDK to capture an explicitly registered local window and move the Driver's agent cursor within that window. The cursor is the Driver's agent/ghost cursor primitive; it is not OS pointer input. Frames and room keys stay local unless a separate, explicit room-sharing flow is used. This integration does not grant a room participant computer access.
