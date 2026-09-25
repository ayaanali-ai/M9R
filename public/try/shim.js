/* Lets the extension's real presence overlay load its provider marks outside the extension. */
window.chrome = window.chrome || {};
window.chrome.runtime = window.chrome.runtime || { getURL: function (p) { return "/try/" + String(p).replace(/^\//, ""); } };
