// The pinned upstream archive is checked as a complete set so unexpected
// additions/removals require review. Only runtime-consumed assets are copied
// into M9R's distributable runtime.
export const CUA_DRIVER_ARCHIVE_ASSETS = Object.freeze([
  "cua-driver.exe",
  "cua-cursor-theme.exe",
  "cua-driver-uia.exe",
  "cua_driver_sdk.dll",
  "cua_driver_node_runtime.node",
  "cua_driver_abi.h",
]);

// This generated C ABI header is consumed by native compilation, not by the
// already-built daemon or Node bindings. Keep checking it in the downloaded
// source archive, but do not ship it as a runtime file.
export const CUA_DRIVER_RUNTIME_ASSETS = Object.freeze(
  CUA_DRIVER_ARCHIVE_ASSETS.filter((asset) => asset !== "cua_driver_abi.h"),
);
