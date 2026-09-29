const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const test = require('node:test');

const source = readFileSync(join(__dirname, '../public/try/presence-overlay.js'), 'utf8');

function classListFor() {
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
}

function createOverlayDocument() {
  const nodes = [];
  const makeNode = (tag) => {
    const properties = new Map();
    const node = {
      tagName: tag,
      style: { setProperty(name, value) { properties.set(name, String(value)); }, properties },
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
    nodes.push(node);
    return node;
  };
  const win = {
    innerWidth: 1200,
    innerHeight: 800,
    document: { hidden: false },
    addEventListener() {},
    removeEventListener() {},
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    requestAnimationFrame() { return 1; },
    cancelAnimationFrame() {},
  };
  return {
    doc: { defaultView: win, documentElement: makeNode('html'), createElement: makeNode },
    nodes,
    win,
  };
}

test('public try overlay reassigns cursor slots when an agent leaves and another joins', () => {
  const { doc, nodes, win } = createOverlayDocument();
  runInNewContext(source, { window: win, URL, Date, Map, Set, Math, performance, console });
  const overlay = win.M9RPresence.createPresenceOverlay(doc, {});

  overlay.update({ agent: 'agent-a', provider: 'codex' });
  overlay.update({ agent: 'agent-b', provider: 'claude' });
  overlay.remove('agent-a');
  overlay.update({ agent: 'agent-c', provider: 'opencode' });

  const slots = nodes
    .filter((node) => node.className === 'agent' && node.isConnected)
    .map((node) => node.style.properties.get('--slot'));

  assert.deepEqual(slots, ['0', '1'], 'remaining and newly joined cursors should have distinct consecutive slots');
  overlay.destroy();
});
