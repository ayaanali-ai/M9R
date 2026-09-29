(function initializeM9RNewTab(global) {
  "use strict";

  const FALLBACK_MESSAGE = "Search unavailable. Use the address bar.";
  const PROVIDER_URLS = Object.freeze({
    google: "https://www.google.com/search?q=",
    duckduckgo: "https://duckduckgo.com/?q=",
    bing: "https://www.bing.com/search?q=",
  });
  const PROVIDERS = new Set([...Object.keys(PROVIDER_URLS), "browser"]);
  const STORAGE_KEY = "m9rSearchProvider";

  function showFallback(input, status) {
    status.textContent = FALLBACK_MESSAGE;
    status.hidden = false;
    input.focus();
  }

  function init(document, searchApi, storage, location) {
    const form = document.querySelector("#search-form");
    const input = document.querySelector("#search-input");
    const status = document.querySelector("#search-status");
    const provider = document.querySelector("#search-provider");

    if (!form || !input || !status || !provider) return;

    let changedByOwner = false;
    try {
      storage?.get(STORAGE_KEY).then((saved) => {
        if (!changedByOwner && PROVIDERS.has(saved?.[STORAGE_KEY])) {
          provider.value = saved[STORAGE_KEY];
        }
      }).catch(() => {});
    } catch {}

    provider.addEventListener("change", () => {
      changedByOwner = true;
      if (!PROVIDERS.has(provider.value)) provider.value = "browser";
      try { storage?.set({ [STORAGE_KEY]: provider.value })?.catch(() => {}); } catch {}
    });

    input.addEventListener("input", () => {
      status.textContent = "";
      status.hidden = true;
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = input.value.trim();

      if (!text) {
        input.focus();
        return;
      }

      status.textContent = "";
      status.hidden = true;

      try {
        const choice = PROVIDERS.has(provider.value) ? provider.value : "browser";
        if (choice === "browser") {
          if (!searchApi || typeof searchApi.query !== "function") {
            showFallback(input, status);
            return;
          }
          await searchApi.query({ text });
        } else {
          location.assign(`${PROVIDER_URLS[choice]}${encodeURIComponent(text)}`);
        }
      } catch {
        showFallback(input, status);
      }
    });
  }

  if (typeof global.document !== "undefined") {
    init(global.document, global.chrome?.search, global.chrome?.storage?.local, global.location);
  }
})(globalThis);
