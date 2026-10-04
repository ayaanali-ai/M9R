const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const test = require('node:test');

const source = readFileSync(join(__dirname, '../extensions/browser/src/presence-overlay.js'), 'utf8');

function createHarness() {
  let now = 1_000;
  let nextFrameId = 0;
  const frames = new Map();
  const targets = new Map();
  const windowListeners = new Map();

  function makeNode(tagName) {
    const classes = new Set();
    const node = {
      tagName: String(tagName).toUpperCase(),
      children: [],
      style: {
        setProperty(name, value) { this[name] = String(value); },
        getPropertyValue(name) { return this[name] || ''; },
      },
      classList: {
        add(...names) { names.forEach((name) => classes.add(name)); },
        remove(...names) { names.forEach((name) => classes.delete(name)); },
        contains(name) { return classes.has(name); },
        toggle(name, force) {
          const enabled = force === undefined ? !classes.has(name) : !!force;
          if (enabled) classes.add(name);
          else classes.delete(name);
          return enabled;
        },
      },
      isConnected: true,
      textContent: '',
      setAttribute() {},
      addEventListener() {},
      removeEventListener() {},
      appendChild(child) { this.children.push(child); return child; },
      append(...children) { this.children.push(...children); },
      attachShadow() { this.shadowRoot = makeNode('shadow'); return this.shadowRoot; },
      remove() { this.isConnected = false; },
      getBoundingClientRect() { return this.rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
      closest(selector) { return selector.includes('button') && this.tagName === 'BUTTON' ? this : null; },
    };
    Object.defineProperty(node, 'className', {
      get() { return [...classes].join(' '); },
      set(value) { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach((name) => classes.add(name)); },
    });
    Object.defineProperty(node, 'innerHTML', {
      set(value) { if (String(value).includes('<svg')) this.firstChild = makeNode('svg'); },
    });
    return node;
  }

  const button = makeNode('button');
  button.rect = { left: 120, top: 80, right: 220, bottom: 120, width: 100, height: 40 };
  targets.set('#save', button);

  const win = {
    innerWidth: 1_000,
    innerHeight: 800,
    document: { hidden: false },
    matchMedia() { return { matches: false }; },
    addEventListener(type, callback, options) {
      const listeners = windowListeners.get(type) || [];
      listeners.push({ callback, options });
      windowListeners.set(type, listeners);
    },
    removeEventListener(type, callback) {
      windowListeners.set(type, (windowListeners.get(type) || []).filter((entry) => entry.callback !== callback));
    },
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    requestAnimationFrame(callback) { const id = ++nextFrameId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  const doc = {
    defaultView: win,
    documentElement: makeNode('html'),
    createElement: makeNode,
    querySelector(selector) { return targets.get(selector) || null; },
    elementFromPoint(x, y) {
      const rect = button.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom ? button : null;
    },
  };
  win.chrome = { runtime: { getURL: (path) => `chrome-extension://test-id/${path}` } };
  const providerColors = { codex: '#0f9d7a', opencode: '#6a5acd' };
  win.M9RPresenceLogic = {
    formatPresenceMessage: () => null,
    providerPresentation(provider) {
      const label = provider === 'opencode' ? 'OpenCode' : 'Codex';
      return { label, glyph: label[0], color: providerColors[provider], asset: null };
    },
  };
  runInNewContext(source, {
    window: win,
    URL,
    Date: class extends Date { static now() { return now; } },
    Map,
    Set,
    Math,
    performance: { now: () => now },
    console,
  });
  const overlay = win.M9RPresence.createPresenceOverlay(doc, {});

  function flushFrame() {
    const entry = frames.entries().next().value;
    assert.ok(entry, 'expected an animation frame to be scheduled');
    frames.delete(entry[0]);
    entry[1](now);
  }

  function findByClass(root, className) {
    if (root.classList?.contains(className)) return root;
    for (const child of root.children || []) {
      const found = findByClass(child, className);
      if (found) return found;
    }
    return null;
  }

  return {
    button,
    doc,
    flushFrame,
    findByClass,
    hasPendingFrame() { return frames.size > 0; },
    dispatchWindowEvent(type) { for (const entry of windowListeners.get(type) || []) entry.callback(); },
    get now() { return now; },
    set now(value) { now = value; },
    overlay,
  };
}

test('same-pixel native targets get separately visible, agent-colored and named highlights without cursor offsets', () => {
  const h = createHarness();
  h.overlay.update({ agent: 'codex-alpha', provider: 'codex', phase: 'start', action: 'clicking Save', target: { point: { x: 160, y: 100 } } });
  h.overlay.update({ agent: 'opencode-beta', provider: 'opencode', phase: 'start', action: 'clicking Save', target: { point: { x: 160, y: 100 } } });

  h.now = 3_000;
  h.flushFrame();

  const host = h.doc.documentElement.children[0];
  const layer = host.shadowRoot.children[1];
  const focusBoxes = layer.children.filter((node) => node.classList.contains('focus'));
  const cursors = layer.children.filter((node) => node.classList.contains('agent'));
  assert.equal(focusBoxes.length, 2);
  assert.equal(focusBoxes.every((node) => node.classList.contains('on')), true);
  assert.deepEqual(focusBoxes.map((node) => node.children[0].textContent), ['codex-alpha · Codex', 'opencode-beta · OpenCode']);
  assert.deepEqual(focusBoxes.map((node) => node.style.getPropertyValue('--c')), ['#0f9d7a', '#6a5acd']);
  assert.notEqual(focusBoxes[0].style.transform, focusBoxes[1].style.transform, 'concentric target outlines remain distinguishable');
  assert.deepEqual(cursors.map((node) => node.style.transform), ['translate3d(160px, 100px, 0)', 'translate3d(160px, 100px, 0)']);

  h.overlay.destroy();
  assert.equal(h.hasPendingFrame(), false, 'destroy cancels the active overlay frame without rescheduling during roster cleanup');
});

test('native-pointer events for different targets keep each agent at its own page coordinate', async () => {
  const h = createHarness();
  h.overlay.update({ agent: 'codex-alpha', provider: 'codex', phase: 'start', action: 'clicking Save' });
  h.overlay.update({ agent: 'opencode-beta', provider: 'opencode', phase: 'start', action: 'clicking Continue' });
  const codexPainted = h.overlay.nativePointer('codex-alpha', 160, 100, true);
  const opencodePainted = h.overlay.nativePointer('opencode-beta', 640, 360, true);

  h.now = 3_000;
  for (let frame = 0; frame < 8; frame += 1) h.flushFrame();
  assert.deepEqual(await Promise.all([codexPainted, opencodePainted]), [true, true]);

  const layer = h.doc.documentElement.children[0].shadowRoot.children[1];
  const cursors = layer.children.filter((node) => node.classList.contains('agent'));
  assert.deepEqual(cursors.map((node) => node.style.transform), [
    'translate3d(160px, 100px, 0)',
    'translate3d(640px, 360px, 0)',
  ], 'each active native-pointer update follows its own viewport target instead of a shared/stale point');

  h.overlay.destroy();
  assert.equal(h.hasPendingFrame(), false);
});

test('native trusted-pointer updates hit-test and label the active page element', async () => {
  const h = createHarness();
  h.overlay.update({ agent: 'codex-worker', provider: 'codex', phase: 'start', action: 'clicking Save' });
  const painted = h.overlay.nativePointer('codex-worker', 160, 100, true);
  h.flushFrame();
  h.flushFrame();
  h.flushFrame();
  h.flushFrame();
  assert.equal(await painted, true, 'native-pointer acknowledges after the cursor/target frame has rendered');

  const layer = h.doc.documentElement.children[0].shadowRoot.children[1];
  const focus = layer.children.find((node) => node.classList.contains('focus'));
  assert.equal(focus.classList.contains('on'), true);
  assert.equal(focus.children[0].textContent, 'codex-worker · Codex');
  assert.equal(focus.style.transform, 'translate3d(116px, 76px, 0)');

  h.overlay.destroy();
  assert.equal(h.hasPendingFrame(), false);
});

test('selector target highlights follow page layout changes and disappear after the action settles', () => {
  const h = createHarness();
  h.overlay.update({ agent: 'codex', provider: 'codex', phase: 'start', action: 'clicking Save', target: { selector: '#save' } });
  h.flushFrame();

  const layer = h.doc.documentElement.children[0].shadowRoot.children[1];
  const focus = layer.children.find((node) => node.classList.contains('focus'));
  assert.equal(focus.classList.contains('on'), true);
  assert.equal(focus.style.transform, 'translate3d(116px, 76px, 0)');

  h.button.rect = { left: 300, top: 180, right: 420, bottom: 230, width: 120, height: 50 };
  h.flushFrame();
  assert.equal(focus.style.transform, 'translate3d(296px, 176px, 0)');

  h.now += 3_300;
  h.overlay.update({ agent: 'codex', provider: 'codex', phase: 'done', action: 'clicking Save', target: { selector: '#save' } });
  h.flushFrame();
  assert.equal(focus.classList.contains('on'), true, 'the target gets a brief completion fade');
  h.now += 501;
  h.flushFrame();
  assert.equal(focus.classList.contains('on'), false);

  h.overlay.destroy();
});

test('a settled shared target refreshes on page scroll without a permanent animation loop', () => {
  const h = createHarness();
  h.overlay.update({ agent: 'codex', provider: 'codex', phase: 'start', action: 'clicking Save', target: { selector: '#save' } });
  h.now = 5_000;
  h.flushFrame();
  h.now = 6_000;
  let settlingFrames = 0;
  while (h.hasPendingFrame() && settlingFrames < 8) {
    h.flushFrame();
    settlingFrames++;
  }

  assert.equal(h.hasPendingFrame(), false, 'an active target alone must not spin requestAnimationFrame forever');
  const layer = h.doc.documentElement.children[0].shadowRoot.children[1];
  const focus = layer.children.find((node) => node.classList.contains('focus'));
  h.button.rect = { left: 340, top: 220, right: 460, bottom: 270, width: 120, height: 50 };
  h.dispatchWindowEvent('scroll');
  h.flushFrame();

  assert.equal(focus.style.transform, 'translate3d(336px, 216px, 0)');
  assert.equal(h.hasPendingFrame(), false);
  h.overlay.destroy();
});

test('agent labels stay inside the viewport when their shared target is near the right edge', () => {
  const h = createHarness();
  h.button.rect = { left: 920, top: 100, right: 980, bottom: 130, width: 60, height: 30 };
  h.overlay.update({ agent: 'codex-worker', provider: 'codex', phase: 'start', action: 'clicking Save', target: { selector: '#save' } });
  h.now = 3_000;
  h.flushFrame();

  const layer = h.doc.documentElement.children[0].shadowRoot.children[1];
  const focus = layer.children.find((node) => node.classList.contains('focus'));
  const boxLeft = Number.parseFloat(focus.style.transform.match(/translate3d\(([-\d.]+)px/)[1]);
  const tagLeft = boxLeft + Number.parseFloat(focus.children[0].style.left);
  assert.equal(tagLeft, 676, 'the 320px label is shifted left to fit the 1000px viewport');

  h.overlay.destroy();
});

test('unresolvable selectors use the provided target rectangle for the named highlight', () => {
  const h = createHarness();
  h.overlay.update({
    agent: 'codex-worker', provider: 'codex', phase: 'start', action: 'clicking Save',
    target: { selector: '#missing', rect: { x: 24, y: 48, width: 180, height: 36 } },
  });
  h.flushFrame();

  const layer = h.doc.documentElement.children[0].shadowRoot.children[1];
  const focus = layer.children.find((node) => node.classList.contains('focus'));
  assert.equal(focus.classList.contains('on'), true);
  assert.equal(focus.children[0].textContent, 'codex-worker · Codex');
  assert.equal(focus.style.transform, 'translate3d(20px, 44px, 0)');
  assert.equal(focus.style.width, '188px');
  assert.equal(focus.style.height, '44px');

  h.overlay.destroy();
});
