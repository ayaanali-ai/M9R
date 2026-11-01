import type { BrowserTransport } from "./agent-chrome";

/** One broker-owned browser generation, started only on demand. Failed actions
 * are never replayed and a disconnected generation is never silently replaced. */
export function createBrowserDaemon(start: () => Promise<BrowserTransport>): BrowserTransport {
  let starting: Promise<BrowserTransport> | undefined;
  let live: BrowserTransport | undefined;
  let closed = false;
  const listeners = new Set<{ receive: (message: unknown) => void; disconnected: () => void }>();
  let unsubscribe: (() => void) | undefined;
  return {
    ready: () => !closed && !!live?.ready(),
    async ensureReady() {
      if (closed) return false;
      if (!starting) starting = start().then(async (transport) => {
        if (closed) { await transport.close(); return transport; }
        live = transport;
        unsubscribe = transport.subscribe((message) => { for (const listener of listeners) listener.receive(message); },
          () => { for (const listener of listeners) listener.disconnected(); });
        return transport;
      }).catch((error) => { starting = undefined; throw error; });
      try { await starting; return !closed && !!live?.ready(); } catch { return false; }
    },
    send: (message) => !closed && !!live?.ready() && live.send(message),
    subscribe(receive, disconnected) {
      const listener = { receive, disconnected };
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async close() {
      closed = true;
      unsubscribe?.();
      const transport = live ?? await starting?.catch(() => undefined);
      await transport?.close();
      listeners.clear();
    },
  };
}
