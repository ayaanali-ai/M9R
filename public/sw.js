const CACHE_NAME = "oathlock-offline-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.add(OFFLINE_URL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key.startsWith("oathlock-offline-") && key !== CACHE_NAME).map((key) => caches.delete(key)),
    )),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || event.request.mode !== "navigate") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL)));
});

// Notification action buttons (`actions`) are a progressive enhancement:
// Chrome/Edge/Firefox desktop + Android support them; Safari/iOS silently
// ignores `actions` and shows a plain notification, so those users still get
// the alert and open the app to decide -- nothing breaks, it just isn't
// one-tap there.
const VALID_DECIDE_ACTIONS = new Set(["approve", "reject"]);

function isSameOriginApiPath(value) {
  return typeof value === "string" && value.startsWith("/api/");
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }

  const title = typeof data.title === "string" && data.title.trim() ? data.title : "OathLock";
  const body = typeof data.body === "string" ? data.body : "A Watchfloor update is ready.";
  const url = typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/dashboard/agents";

  // `decide` carries the exact same POST each action button already makes
  // from the dashboard -- notificationclick below fires it directly, so
  // approving/rejecting from the notification never requires opening a tab.
  const decide = {};
  if (data.decide && typeof data.decide === "object") {
    for (const key of Object.keys(data.decide)) {
      if (!VALID_DECIDE_ACTIONS.has(key)) continue;
      const entry = data.decide[key];
      if (!entry || !isSameOriginApiPath(entry.url)) continue;
      decide[key] = {
        url: entry.url,
        method: typeof entry.method === "string" ? entry.method : "POST",
        body: entry.body && typeof entry.body === "object" ? entry.body : {},
      };
    }
  }
  const actions = Array.isArray(data.actions)
    ? data.actions
        .filter((a) => a && VALID_DECIDE_ACTIONS.has(a.action) && typeof a.title === "string" && decide[a.action])
        .slice(0, 2)
    : [];

  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: "/oathlock-logo-transparent.png",
    badge: "/oathlock-logo-transparent.png",
    tag: typeof data.tag === "string" ? data.tag : "oathlock-update",
    data: { url, decide },
    actions,
  }));
});

async function postDecision(entry) {
  const response = await fetch(entry.url, {
    method: entry.method,
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(entry.body),
  });
  if (!response.ok) throw new Error(`Decision request failed (${response.status})`);
}

async function focusOrOpen(target) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const existing = clients.find((client) => "focus" in client);
  if (existing) {
    if ("navigate" in existing && typeof existing.navigate === "function") await existing.navigate(new URL(target, self.location.origin).href);
    await existing.focus();
    return;
  }
  if (self.clients.openWindow) await self.clients.openWindow(new URL(target, self.location.origin).href);
}

self.addEventListener("notificationclick", (event) => {
  const { action } = event;
  const notificationData = event.notification?.data || {};
  const target = notificationData.url || "/dashboard/agents";
  event.notification.close();

  if (action && VALID_DECIDE_ACTIONS.has(action)) {
    const entry = notificationData.decide && notificationData.decide[action];
    if (entry) {
      event.waitUntil(
        postDecision(entry)
          .then(() => self.registration.showNotification("OathLock", {
            body: action === "approve" ? "Approved." : "Rejected.",
            icon: "/oathlock-logo-transparent.png",
            tag: "oathlock-decision-result",
          }))
          .catch(() => focusOrOpen(target)),
      );
      return;
    }
  }

  event.waitUntil(focusOrOpen(target));
});
