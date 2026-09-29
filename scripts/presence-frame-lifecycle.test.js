const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const test = require('node:test');

const source = readFileSync(join(__dirname, '../extensions/browser/src/presence-overlay.js'), 'utf8');

function element(tag) {
  const listeners = new Map();
  return {
    tagName: tag,
    dataset: {},
    style: {},
    isConnected: true,
    classList: { add() {}, toggle() {} },
    setAttribute() {},
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
    fire(type) { listeners.get(type)?.(); },
    appendChild(child) { this.child = child; return child; },
    append(...children) { this.children = children; },
    attachShadow() { return element('shadow'); },
    remove() { this.isConnected = false; },
  };
}

test('frame messaging waits for the extension origin instead of targeting the page-origin initial window', () => {
  const badTargetPosts = [];
  const frames = [];
  const sent = [];
  const handlers = new Map();
  let hostHellos = 0;
  class FakePort {
    postMessage(data) { if (this.closed) throw new Error('port is closed'); this.peer.onmessage?.({ data }); }
    close() { this.closed = true; if (this.peer) this.peer.closed = true; }
    start() {}
  }
  class FakeMessageChannel {
    constructor() {
      this.port1 = new FakePort();
      this.port2 = new FakePort();
      this.port1.peer = this.port2;
      this.port2.peer = this.port1;
    }
  }
  const win = {
    innerWidth: 1000,
    innerHeight: 800,
    addEventListener(type, fn) { handlers.set(type, fn); },
    removeEventListener(type) { handlers.delete(type); },
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout() { return 1; },
    requestAnimationFrame() { return 1; },
    cancelAnimationFrame() {},
    clearTimeout() {},
  };
  const doc = {
    defaultView: win,
    documentElement: element('html'),
    createElement(tag) {
      const node = element(tag);
      if (tag === 'iframe') {
        let recipientOrigin = 'https://example.test';
        node.contentWindow = {
          postMessage(payload, origin, ports) {
            if (origin !== recipientOrigin) {
              if (payload.m9r !== 'host-hello') badTargetPosts.push({ origin, recipientOrigin });
              return;
            }
            if (payload.m9r === 'host-port' && Array.isArray(ports)) {
              node.framePort = ports[0];
              node.framePort.onmessage = (event) => sent.push(event.data);
            } else if (payload.m9r === 'host-hello') {
              hostHellos++;
              handlers.get('message')({ origin: recipientOrigin, source: node.contentWindow, data: { m9r: 'frame', nonce: payload.nonce, kind: 'ready' } });
            }
          },
        };
        node.setRecipientOrigin = (origin) => { recipientOrigin = origin; };
        frames.push(node);
      }
      return node;
    },
  };
  win.MessageChannel = FakeMessageChannel;
  const context = { window: win, URL, Date, Map, Set, Math, performance, console };
  win.chrome = { runtime: { getURL: (path) => `chrome-extension://test-id/${path}` } };
  runInNewContext(source, context);
  const overlay = win.M9RPresence.createPresenceOverlay(doc, {});
  overlay.mountFrame('composer', 'chrome-extension://test-id/composer.html?n=fixture-nonce', { w: 448, h: 72, bottom: 6 });
  assert.equal(frames.length, 1);
  assert.equal(doc.documentElement.child.dataset.m9rComposerFrame, 'mounted');
  assert.equal(doc.documentElement.child.dataset.m9rFrameHandshake, 'awaiting');
  frames[0].fire('load');
  assert.equal(doc.documentElement.child.dataset.m9rComposerFrame, 'authenticating');
  overlay.showComposer(true);
  assert.deepEqual(badTargetPosts, [], 'no message should be sent while the iframe still has its page-origin initial window');
  assert.equal(sent.length, 0);
  const frame = frames[0];
  const extensionOrigin = 'chrome-extension://test-id';
  handlers.get('message')({ origin: 'https://example.test', source: frame.contentWindow, data: { m9r: 'frame', nonce: 'fixture-nonce', kind: 'size', w: 448, h: 72 } });
  assert.equal(sent.length, 0, 'page-origin messages cannot make the frame ready');
  assert.equal(doc.documentElement.child.dataset.m9rFrameHandshake, 'origin-mismatch');
  frame.setRecipientOrigin(extensionOrigin);
  handlers.get('message')({ origin: extensionOrigin, source: frame.contentWindow, data: { m9r: 'frame', nonce: 'fixture-nonce', kind: 'size', w: 448, h: 72 } });
  assert.equal(doc.documentElement.child.dataset.m9rComposerFrame, 'ready');
  assert.equal(doc.documentElement.child.dataset.m9rFrameHandshake, 'ready');
  assert.ok(sent.some((payload) => payload.kind === 'focus'), 'queued focus reaches the confirmed extension frame');
  frame.fire('load');
  assert.equal(hostHellos, 1, 'a late iframe load asks the extension page to prove itself again');
  assert.equal(doc.documentElement.child.dataset.m9rComposerFrame, 'ready', 'the late load must not strand the frame in authentication');
  assert.deepEqual(badTargetPosts, []);
  overlay.destroy();
});

test('an iframe navigation cannot send host messages to the new page origin and gets a fresh channel after reload', () => {
  const badTargetPosts = [];
  const handlers = new Map();
  const sent = [];
  class FakePort {
    postMessage(data) { if (this.closed) throw new Error('port is closed'); this.peer.onmessage?.({ data }); }
    close() { this.closed = true; if (this.peer) this.peer.closed = true; }
    start() {}
  }
  class FakeMessageChannel {
    constructor() {
      this.port1 = new FakePort();
      this.port2 = new FakePort();
      this.port1.peer = this.port2;
      this.port2.peer = this.port1;
    }
  }
  const win = {
    innerWidth: 1000, innerHeight: 800,
    addEventListener(type, fn) { handlers.set(type, fn); },
    removeEventListener(type) { handlers.delete(type); },
    setInterval() { return 1; }, clearInterval() {},
    setTimeout() { return 1; },
    requestAnimationFrame() { return 1; }, cancelAnimationFrame() {}, clearTimeout() {},
  };
  const extensionOrigin = 'chrome-extension://test-id';
  const frames = [];
  const doc = {
    defaultView: win,
    documentElement: element('html'),
    createElement(tag) {
      const node = element(tag);
      if (tag === 'iframe') {
        let recipientOrigin = extensionOrigin;
        node.contentWindow = {
          postMessage(payload, origin, ports) {
            node.windowMessages = (node.windowMessages || []).concat([{ payload, origin, portCount: ports?.length || 0 }]);
            if (origin !== recipientOrigin) {
              if (payload.m9r !== 'host-hello') badTargetPosts.push({ target: origin, recipient: recipientOrigin });
              return;
            }
            if (payload.m9r === 'host-port' && Array.isArray(ports)) {
              node.framePort = ports[0];
              node.framePort.onmessage = (event) => sent.push(event.data);
            }
          },
        };
        node.setRecipientOrigin = (origin) => { recipientOrigin = origin; };
        frames.push(node);
      }
      return node;
    },
  };
  win.MessageChannel = FakeMessageChannel;
  win.chrome = { runtime: { getURL: (path) => `chrome-extension://test-id/${path}` } };
  runInNewContext(source, { window: win, URL, Date, Map, Set, Math, performance, console });
  const overlay = win.M9RPresence.createPresenceOverlay(doc, {});
  overlay.mountFrame('composer', 'chrome-extension://test-id/composer.html?n=fixture-nonce', { w: 448, h: 72, bottom: 6 });
  const frame = frames[0];

  frame.fire('load');
  handlers.get('message')({ origin: extensionOrigin, source: frame.contentWindow, data: { m9r: 'frame', nonce: 'fixture-nonce', kind: 'size', w: 448, h: 72 } });
  const firstPort = frame.framePort;
  assert.ok(firstPort, JSON.stringify({ src: frame.src, messages: frame.windowMessages, hasChannel: typeof win.MessageChannel }));

  // The page navigates its child iframe. A resize before the iframe's load handler must not target the page origin.
  frame.setRecipientOrigin('https://news.ycombinator.com');
  handlers.get('resize')();
  assert.deepEqual(badTargetPosts, []);
  frame.fire('load');
  assert.equal(firstPort.closed, true, 'the old extension document channel is disposed on navigation');

  frame.setRecipientOrigin(extensionOrigin);
  frame.fire('load');
  handlers.get('message')({ origin: extensionOrigin, source: frame.contentWindow, data: { m9r: 'frame', nonce: 'fixture-nonce', kind: 'size', w: 448, h: 72 } });
  handlers.get('resize')();
  assert.ok(sent.length >= 2, 'the reloaded extension frame receives host state over its fresh channel');
  assert.deepEqual(badTargetPosts, []);

  const beforeBfCache = frame.framePort;
  overlay.suspend();
  assert.equal(beforeBfCache.closed, true, 'pagehide releases the cached frame channel');
  overlay.resume();
  frame.fire('load');
  handlers.get('message')({ origin: extensionOrigin, source: frame.contentWindow, data: { m9r: 'frame', nonce: 'fixture-nonce', kind: 'size', w: 448, h: 72 } });
  assert.notEqual(frame.framePort, beforeBfCache, 'pageshow creates a fresh channel for the restored page');
  assert.ok(sent.length >= 3, 'restored frame receives host state after authenticating again');
  overlay.destroy();
});

test('creating a second overlay in one isolated world destroys the old singleton before mounting another', () => {
  const handlers = new Map();
  const root = element('html');
  const win = {
    innerWidth: 1000, innerHeight: 800,
    addEventListener(type, fn) { handlers.set(type, fn); },
    removeEventListener(type, fn) { if (handlers.get(type) === fn) handlers.delete(type); },
    setInterval() { return 1; }, clearInterval() {},
    requestAnimationFrame() { return 1; }, cancelAnimationFrame() {}, clearTimeout() {},
  };
  const doc = { defaultView: win, documentElement: root, createElement: (tag) => element(tag) };
  win.chrome = { runtime: { getURL: (path) => `chrome-extension://test-id/${path}` } };
  runInNewContext(source, { window: win, URL, Date, Map, Set, Math, performance, console });

  const first = win.M9RPresence.createPresenceOverlay(doc, {});
  const firstHost = root.child;
  const second = win.M9RPresence.createPresenceOverlay(doc, {});
  const secondHost = root.child;

  assert.notEqual(first, second);
  assert.equal(firstHost.isConnected, false);
  assert.equal(secondHost.isConnected, true);
  assert.equal(handlers.size, 2, 'only the live singleton owns window listeners');
  second.destroy();
  assert.equal(handlers.size, 0);
});

test('destroy releases overlay DOM and window listeners even when Chrome invalidates storage listener removal', () => {
  const handlers = new Map();
  const storageListeners = [];
  const clearedIntervals = [];
  const win = {
    innerWidth: 1000,
    innerHeight: 800,
    addEventListener(type, fn) { handlers.set(type, fn); },
    removeEventListener(type, fn) { if (handlers.get(type) === fn) handlers.delete(type); },
    setInterval() { return 17; },
    clearInterval(id) { clearedIntervals.push(id); },
    requestAnimationFrame() { return 21; },
    cancelAnimationFrame() {},
    clearTimeout() {},
  };
  const root = element('html');
  const doc = { defaultView: win, documentElement: root, createElement: (tag) => element(tag) };
  win.chrome = {
    runtime: { getURL: (path) => `chrome-extension://test-id/${path}` },
    storage: {
      local: { get: async () => ({}) },
      onChanged: {
        addListener(listener) { storageListeners.push(listener); },
        removeListener() { throw new Error('Extension context invalidated'); },
      },
    },
  };
  const context = { window: win, URL, Date, Map, Set, Math, performance, console };
  runInNewContext(source, context);
  const overlay = win.M9RPresence.createPresenceOverlay(doc, {});

  assert.equal(storageListeners.length, 1);
  assert.equal(handlers.size, 2);
  assert.doesNotThrow(() => overlay.destroy());
  assert.equal(root.child.isConnected, false, 'a failed extension API cleanup must not strand the visible overlay');
  assert.equal(handlers.size, 0, 'window message/resize handlers are removed independently');
  assert.deepEqual(clearedIntervals, [17]);
});

test('replacing overlays reuses one storage listener when Chrome refuses listener removal', () => {
  const handlers = new Map();
  const storageListeners = [];
  const win = {
    innerWidth: 1000, innerHeight: 800,
    addEventListener(type, fn) { handlers.set(type, fn); },
    removeEventListener(type, fn) { if (handlers.get(type) === fn) handlers.delete(type); },
    setInterval() { return 1; }, clearInterval() {},
    requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
    clearTimeout() {}, setTimeout() { return 1; },
  };
  const root = element('html');
  const doc = { defaultView: win, documentElement: root, createElement: (tag) => element(tag) };
  win.chrome = {
    runtime: { getURL: (path) => `chrome-extension://test-id/${path}` },
    storage: {
      local: { get: async () => ({}) },
      onChanged: {
        addListener(listener) { storageListeners.push(listener); },
        removeListener() { throw new Error('Extension context invalidated'); },
      },
    },
  };
  runInNewContext(source, { window: win, URL, Date, Map, Set, Math, performance, console });

  win.M9RPresence.createPresenceOverlay(doc, {});
  win.M9RPresence.createPresenceOverlay(doc, {});
  const latest = win.M9RPresence.createPresenceOverlay(doc, {});

  assert.equal(storageListeners.length, 1, 'a failed removal must not accumulate callbacks across overlay replacement');
  latest.destroy();
});

test('an unauthenticated first frame load is retried at the trusted extension URL', () => {
  const handlers = new Map();
  const timers = new Map();
  const sent = [];
  let nextTimer = 0;
  class FakePort {
    postMessage(data) { if (this.closed) throw new Error('port is closed'); this.peer.onmessage?.({ data }); }
    close() { this.closed = true; if (this.peer) this.peer.closed = true; }
    start() {}
  }
  class FakeMessageChannel {
    constructor() {
      this.port1 = new FakePort();
      this.port2 = new FakePort();
      this.port1.peer = this.port2;
      this.port2.peer = this.port1;
    }
  }
  const win = {
    innerWidth: 1000, innerHeight: 800,
    addEventListener(type, fn) { handlers.set(type, fn); },
    removeEventListener(type, fn) { if (handlers.get(type) === fn) handlers.delete(type); },
    setInterval() { return 1; }, clearInterval() {},
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
  };
  let frame;
  let srcAssignments = 0;
  const doc = {
    defaultView: win,
    documentElement: element('html'),
    createElement(tag) {
      const node = element(tag);
      if (tag === 'iframe') {
        let recipientOrigin = 'https://redirected.example';
        Object.defineProperty(node, 'src', {
          get() { return this._src; },
          set(value) { this._src = value; srcAssignments += 1; },
        });
        node.contentWindow = {
          postMessage(payload, origin, ports) {
            if (origin !== recipientOrigin) return;
            if (payload.m9r === 'host-port' && Array.isArray(ports)) {
              node.framePort = ports[0];
              node.framePort.onmessage = (event) => sent.push(event.data);
            }
          },
        };
        node.setRecipientOrigin = (origin) => { recipientOrigin = origin; };
        frame = node;
      }
      return node;
    },
  };
  win.MessageChannel = FakeMessageChannel;
  win.chrome = { runtime: { getURL: (path) => `chrome-extension://test-id/${path}` } };
  runInNewContext(source, { window: win, URL, Date, Map, Set, Math, performance, console });
  const overlay = win.M9RPresence.createPresenceOverlay(doc, {});
  const src = 'chrome-extension://test-id/composer.html?n=fixture-nonce';
  overlay.mountFrame('composer', src, { w: 448, h: 72, bottom: 6 });
  assert.equal(doc.documentElement.child.dataset.m9rComposerFrame, 'mounted');
  frame.fire('load'); // A fast redirect wins before the extension page's initial load.
  assert.equal(doc.documentElement.child.dataset.m9rComposerFrame, 'authenticating');

  assert.equal(srcAssignments, 1, 'the initial frame URL is assigned once before recovery');
  const [retry] = timers.values();
  assert.equal(typeof retry, 'function', 'an untrusted load must have a bounded authentication retry');
  timers.clear();
  retry();

  assert.equal(doc.documentElement.child.dataset.m9rComposerFrame, 'retrying');
  assert.equal(srcAssignments, 2, 'the frame is reloaded to the trusted extension URL');
  assert.equal(frame.src, src);
  assert.deepEqual(sent, [], 'no host data is delivered before an authenticated extension message');
  overlay.destroy();
});

test('messages from a detached orphan frame are ignored even while its WindowProxy still matches', () => {
  const handlers = new Map();
  let hotkeys = 0;
  class FakePort {
    postMessage(data) { if (this.closed) throw new Error('port is closed'); this.peer.onmessage?.({ data }); }
    close() { this.closed = true; if (this.peer) this.peer.closed = true; }
    start() {}
  }
  class FakeMessageChannel {
    constructor() {
      this.port1 = new FakePort();
      this.port2 = new FakePort();
      this.port1.peer = this.port2;
      this.port2.peer = this.port1;
    }
  }
  const win = {
    innerWidth: 1000, innerHeight: 800,
    addEventListener(type, fn) { handlers.set(type, fn); },
    removeEventListener(type, fn) { if (handlers.get(type) === fn) handlers.delete(type); },
    setInterval() { return 1; }, clearInterval() {},
    setTimeout() { return 1; }, clearTimeout() {},
    requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
  };
  const extensionOrigin = 'chrome-extension://test-id';
  const frames = [];
  const doc = {
    defaultView: win,
    documentElement: element('html'),
    createElement(tag) {
      const node = element(tag);
      if (tag === 'iframe') {
        node.contentWindow = { postMessage(_payload, _origin, ports) {
          if (Array.isArray(ports)) node.framePort = ports[0];
        } };
        frames.push(node);
      }
      return node;
    },
  };
  win.MessageChannel = FakeMessageChannel;
  win.chrome = { runtime: { getURL: (path) => `chrome-extension://test-id/${path}` } };
  runInNewContext(source, { window: win, URL, Date, Map, Set, Math, performance, console });
  const overlay = win.M9RPresence.createPresenceOverlay(doc, { onHotkey: () => { hotkeys += 1; } });
  overlay.mountFrame('composer', 'chrome-extension://test-id/composer.html?n=fixture-nonce', { w: 448, h: 72, bottom: 6 });
  const frame = frames[0];
  frame.fire('load');
  handlers.get('message')({ origin: extensionOrigin, source: frame.contentWindow, data: { m9r: 'frame', nonce: 'fixture-nonce', kind: 'size', w: 448, h: 72 } });
  assert.ok(frame.framePort);

  // Removing the host leaves the closed shadow tree and WindowProxy reachable from stale references.
  doc.documentElement.child.remove();
  handlers.get('message')({ origin: extensionOrigin, source: frame.contentWindow, data: { m9r: 'frame', nonce: 'fixture-nonce', kind: 'hotkey', key: 'm', down: true } });

  assert.equal(hotkeys, 0, 'a detached overlay frame cannot continue dispatching events');
  overlay.destroy();
});

test('a completed agent keeps the Done label when its cursor parks after becoming idle', () => {
  let now = 1_000;
  let nextFrameId = 0;
  const frames = new Map();
  const classListFor = () => {
    const names = new Set();
    return {
      add(name) { names.add(name); },
      remove(name) { names.delete(name); },
      toggle(name, force) {
        const enabled = force === undefined ? !names.has(name) : !!force;
        if (enabled) names.add(name);
        else names.delete(name);
        return enabled;
      },
      [Symbol.iterator]() { return names[Symbol.iterator](); },
    };
  };
  const makeNode = (tag) => {
    const node = {
      tagName: tag,
      style: { setProperty() {} },
      classList: classListFor(),
      isConnected: true,
      children: [],
      setAttribute() {},
      addEventListener() {},
      removeEventListener() {},
      appendChild(child) { this.children.push(child); return child; },
      append(...children) { this.children.push(...children); },
      attachShadow() { return makeNode('shadow'); },
      remove() { this.isConnected = false; },
    };
    Object.defineProperty(node, 'innerHTML', {
      set(value) {
        if (String(value).includes('<svg')) node.firstChild = makeNode('svg');
      },
    });
    return node;
  };
  const win = {
    innerWidth: 1000,
    innerHeight: 800,
    document: { hidden: false },
    addEventListener() {},
    removeEventListener() {},
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    requestAnimationFrame(callback) {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  class FakeDate extends Date {
    static now() { return now; }
  }
  const doc = {
    defaultView: win,
    documentElement: makeNode('html'),
    createElement: makeNode,
  };
  win.chrome = { runtime: { getURL: (path) => `chrome-extension://test-id/${path}` } };
  runInNewContext(source, {
    window: win,
    URL,
    Date: FakeDate,
    Map,
    Set,
    Math,
    performance: { now: () => now },
    console,
  });

  const overlay = win.M9RPresence.createPresenceOverlay(doc, {});
  overlay.update({ agent: 'codex', provider: 'codex-cli', phase: 'start', action: 'reading', step: 'Reading the page' });
  overlay.update({ agent: 'codex', provider: 'codex-cli', phase: 'done', action: 'reading', step: 'Done' });

  // The cursor's existing glide completes on this frame; the same frame also transitions it to its parked idle position.
  now += 3_300;
  const [frameId, tick] = frames.entries().next().value;
  frames.delete(frameId);
  tick(now);

  assert.equal(overlay.snapshot()[0].label, 'Done', 'parking the cursor must not erase task completion');
  overlay.destroy();
});
