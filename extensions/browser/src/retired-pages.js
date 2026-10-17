// Cleanup for pages that belonged to removed M9R extension surfaces.
//
// A packaged file this extension used to ship (a dev page, an old dock UI, a
// retired new-tab override -- whatever it was) can still be sitting open in a
// tab that survived a browser restart or session restore, long after that
// file stopped shipping in a later build. Rather than hand-enumerate every
// historical filename that has ever been retired (a list that only grows and
// is never complete), check generically: any tab pointing at this exact
// extension's own packaged URL whose file genuinely is not in the current
// build gets sent back to a normal new tab. An ordinary site, another
// extension's page, or one of this extension's real, currently-shipping
// pages is never touched.
//
// Kept as a tiny dependency-free module so the repair is testable without a
// browser and cannot accidentally broaden into general tab management.
globalThis.M9RRetiredPages = (() => {
  const existsCache = new Map();

  function ownExtensionPath(url, extensionId) {
    if (typeof url !== "string" || typeof extensionId !== "string" || extensionId.length === 0) return null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "chrome-extension:" || parsed.host !== extensionId) return null;
      return parsed.pathname;
    } catch {
      return null;
    }
  }

  async function packagedFileExists(fetchImpl, extensionUrl, path) {
    if (existsCache.has(path)) return existsCache.get(path);
    let exists = true;
    try {
      const response = await fetchImpl(extensionUrl(path));
      exists = Boolean(response && response.ok);
    } catch {
      exists = false;
    }
    existsCache.set(path, exists);
    return exists;
  }

  async function repair(chromeApi, fetchImpl = globalThis.fetch) {
    const extensionId = chromeApi?.runtime?.id;
    if (typeof extensionId !== "string" || extensionId.length === 0 || typeof fetchImpl !== "function") return 0;
    const extensionUrl = (path) => chromeApi.runtime.getURL(path);
    const tabs = await chromeApi.tabs.query({});
    const candidates = tabs.filter((tab) => Number.isSafeInteger(tab?.id) && ownExtensionPath(tab.url, extensionId) !== null);
    let repaired = 0;
    for (const tab of candidates) {
      const path = ownExtensionPath(tab.url, extensionId);
      if (await packagedFileExists(fetchImpl, extensionUrl, path)) continue;
      await chromeApi.tabs.update(tab.id, { url: "chrome://newtab/" });
      repaired += 1;
    }
    return repaired;
  }

  function isRetiredUrl(url, extensionId) {
    // Retained for the one case that matters without an async check: a tab
    // actively being created or navigated right now. The full async repair()
    // pass (on startup/install, and periodically) is what catches any other
    // now-missing packaged path generically.
    const path = ownExtensionPath(url, extensionId);
    return path === "/newtab.html";
  }

  return { isRetiredUrl, repair, ownExtensionPath };
})();
