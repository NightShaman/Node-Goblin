import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { mountArchive } from './archive.js';

// Small DOM fixture, following the GSS Archive tests. Text is never parsed as HTML.
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = new Map(); this.textContent = ''; this.value = ''; this.hidden = false; this.disabled = false; this.attributes = {}; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  fire(name) { return this.listeners.get(name)?.({ preventDefault() {} }); }
  click() { if (!this.disabled) return this.fire('click'); }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
}
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const operation = (id, gatewayId = 'host-a', extra = {}) => ({ gatewayId, operationId: id, kind: 'process', state: 'terminal', terminalOutcome: 'completed', startedAt: '2026-09-23T10:00:00Z', endedAt: null, durationMs: null, replay: false, reconnectRequired: false, ...extra });
const page = (operations = [], extra = {}) => ({ operations, nextCursor: null, hasMore: false, history: { source: 'controller_listener_activity', available: true, complete: false, volatile: true, retainedEntries: 20, maxEntries: 100, matchedEntries: 3, lostOnRestart: true, evictsOldestUpdated: true, clearedOnGatewayRevocation: true }, ...extra });
async function fixture(handler, run, date = '2026-09-23') {
  const previous = globalThis.document;
  globalThis.document = { createElement: tag => new Element(tag) };
  const root = new Element('root'), calls = [];
  const mount = mountArchive({ root, date, api: (path, init) => { const call = { path, init, params: new URLSearchParams(path.split('?')[1]) }; calls.push(call); return handler(call, calls.length); } });
  const find = (tag, text) => root.descendants().find(node => node.tagName === tag && node.textContent === text);
  const text = () => root.descendants().filter(node => node.tagName !== 'style').map(node => node.textContent).join(' ');
  try { await flush(); await run({ root, mount, calls, find, text }); }
  finally { mount.unmount(); globalThis.document = previous; }
}

test('manifest registers the Archive alongside existing Settings', async () => {
  const manifest = JSON.parse(await readFile(new URL('../burrow.mod.json', import.meta.url), 'utf8'));
  assert.equal(manifest.ui.archive, 'ui/archive.js');
  assert.equal(manifest.ui.settings, 'ui/settings.js');
  assert.doesNotMatch(manifest.contributions.settings[0].navigation.description, /activity/);
});

test('scoped GET forwards date and browser timezone; renders volatile notice, counts and safe split details', async () => {
  const unsafe = '<img src=x onerror=alert(1)>';
  await fixture(async () => page([operation(unsafe, 'host-a', { acceptedAt: '2026-09-23T10:00:01Z', durationMs: 0, replay: true, reconnectRequired: true, command: 'DO NOT DISPLAY', output: 'SECRET OUTPUT' })]), async ({ root, calls, find, text }) => {
    assert.equal(calls.length, 1);
    assert.ok(calls[0].path.startsWith('/operations/archive?'));
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].params.get('date'), '2026-09-23');
    assert.equal(calls[0].params.get('limit'), '50');
    assert.equal(calls[0].params.get('timeZone'), Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.equal(calls[0].params.has('cursor'), false);
    assert.match(text(), /Volatile controller window, not complete history/);
    assert.match(text(), /Lost on restart; oldest-updated entries evicted at capacity; gateway entries cleared on revocation/);
    assert.match(text(), /1 shown · 3 matched · 20\/100 retained/);
    assert.ok(root.descendants().some(node => node.className === 'ng-split'));
    assert.ok(find('span', unsafe)); // Selecting the list button uses text nodes, not markup.
    root.descendants().find(node => node.tagName === 'button' && node.children.some(child => child.textContent === unsafe)).click();
    assert.ok(find('dd', unsafe)); assert.ok(find('dd', '0 ms')); assert.ok(find('dd', '—')); assert.ok(find('dd', 'Yes'));
    assert.equal(root.descendants().some(node => node.tagName === 'img'), false);
    assert.doesNotMatch(text(), /DO NOT DISPLAY|SECRET OUTPUT/);
    assert.match(root.descendants().find(node => node.tagName === 'style').textContent, /grid-template-columns:minmax\(220px,1fr\) minmax\(240px,1fr\)/);
    assert.match(root.descendants().find(node => node.tagName === 'style').textContent, /@media\(max-width:700px\)/);
  });
});

test('pagination appends and deduplicates composite identities; double clicks do not duplicate requests', async () => {
  const pending = deferred();
  await fixture(async (_, number) => number === 1 ? page([operation('same')], { hasMore: true, nextCursor: 'opaque+/=' }) : pending.promise, async ({ root, calls, find, text }) => {
    find('button', 'Load more').click(); find('button', 'Load more').click();
    assert.equal(calls.length, 2); assert.equal(calls[1].params.get('cursor'), 'opaque+/=');
    pending.resolve(page([operation('same', 'host-a', { state: 'interrupted' }), operation('same', 'host-b')])); await flush();
    assert.match(text(), /2 shown/); assert.equal(find('ul', '').children.length, 2);
    assert.equal(find('button', 'Load more').hidden, true);
    const listButtons = root.descendants().filter(node => node.tagName === 'button' && node.attributes['aria-pressed']);
    listButtons[1].click(); assert.ok(find('dd', 'host-b'));
  });
});

test('filters are URL-encoded, reset cursor/detail and retain the date; clearing date omits it', async () => {
  await fixture(async () => page([operation('one')], { hasMore: true, nextCursor: 'old' }), async ({ root, mount, calls, find, text }) => {
    const inputs = root.descendants().filter(node => node.tagName === 'input');
    inputs[0].value = ' host & one '; inputs[1].value = ' failed + <text> ';
    root.descendants().find(node => node.tagName === 'form').fire('submit'); await flush();
    assert.equal(calls[1].params.get('gatewayId'), 'host & one'); assert.equal(calls[1].params.get('q'), 'failed + <text>');
    assert.equal(calls[1].params.has('cursor'), false); assert.equal(calls[1].params.get('date'), '2026-09-23');
    assert.match(text(), /Select an operation/);
    mount.update({ date: '' }); await flush();
    assert.equal(calls[2].params.has('date'), false); assert.equal(calls[2].params.get('q'), 'failed + <text>'); assert.match(text(), /All dates/);
    mount.update({ date: '' }); mount.update({}); await flush(); assert.equal(calls.length, 3);
    find('button', 'Refresh').click(); await flush(); assert.equal(calls[3].params.has('cursor'), false);
  });
});

test('initial failure is not an empty result; retry and unavailable/empty states are distinct', async () => {
  await fixture(async (_, number) => {
    if (number === 1) throw new Error('offline');
    if (number === 2) return page([], { history: { available: false } });
    return page();
  }, async ({ calls, find, text }) => {
    assert.match(text(), /Could not load operations. offline/); assert.doesNotMatch(text(), /No retained operations/);
    assert.equal(find('p', 'Could not load operations. offline').attributes.role, 'alert');
    find('button', 'Retry').click(); await flush(); assert.match(text(), /unavailable; this is not evidence of no activity/);
    find('button', 'Refresh').click(); await flush(); assert.match(text(), /No retained operations match this view/); assert.equal(calls.length, 3);
  });
});

test('page failure preserves results and cursor for retry, while refresh resets them', async () => {
  await fixture(async (_, number) => {
    if (number === 2) throw new Error('temporary');
    return number === 1 ? page([operation('one')], { nextCursor: 'next', hasMore: true }) : page([operation('two')]);
  }, async ({ calls, find, text }) => {
    find('button', 'Load more').click(); await flush(); assert.match(text(), /one/); assert.match(text(), /temporary/);
    find('button', 'Retry').click(); await flush(); assert.equal(calls[2].params.get('cursor'), 'next'); assert.match(text(), /2 shown/);
    find('button', 'Refresh').click(); await flush(); assert.equal(calls[3].params.has('cursor'), false); assert.match(text(), /1 shown/);
  });
});

test('malformed pages and non-advancing cursors fail without corrupting results', async () => {
  await fixture(async (_, number) => number === 1 ? page([operation('one')], { nextCursor: 'same', hasMore: true }) : page([operation('bad')], { nextCursor: 'same', hasMore: true }), async ({ find, text }) => {
    find('button', 'Load more').click(); await flush(); assert.match(text(), /Invalid operation archive response/); assert.doesNotMatch(text(), /bad/); assert.match(text(), /1 shown/);
  });
  await fixture(async () => ({ operations: 'not an array' }), async ({ text }) => { assert.match(text(), /Invalid operation archive response/); });
});

test('date A→B→A cancels obsolete requests and ignores their late success and failure', async () => {
  const pending = [deferred(), deferred(), deferred()];
  await fixture((_, number) => pending[number - 1].promise, async ({ mount, calls, text }) => {
    mount.update({ date: '2026-09-24' }); mount.update({ date: '2026-09-23' });
    assert.equal(calls.length, 3); assert.equal(calls[0].init.signal.aborted, true); assert.equal(calls[1].init.signal.aborted, true);
    pending[2].resolve(page([operation('newest')])); await flush();
    pending[0].resolve(page([operation('stale')])); pending[1].reject(new Error('stale failure')); await flush();
    assert.match(text(), /newest/); assert.doesNotMatch(text(), /stale/);
  });
});

test('filter change supersedes in-flight paging and clears old selection immediately', async () => {
  const oldPage = deferred(), filtered = deferred();
  await fixture((_, number) => number === 1 ? page([operation('old')], { hasMore: true, nextCursor: 'next' }) : number === 2 ? oldPage.promise : filtered.promise, async ({ root, calls, find, text }) => {
    root.descendants().find(node => node.attributes['aria-pressed']).click(); assert.ok(find('dd', 'old'));
    find('button', 'Load more').click(); root.descendants().find(node => node.tagName === 'form').fire('submit');
    assert.equal(calls[1].init.signal.aborted, true); assert.equal(find('dd', 'old'), undefined); assert.equal(find('span', 'old'), undefined);
    oldPage.resolve(page([operation('stale-page')])); await flush(); assert.doesNotMatch(text(), /stale-page/);
    filtered.resolve(page([operation('filtered')])); await flush(); assert.match(text(), /filtered/);
  });
});

test('authentication failure clears metadata and permits retry', async () => {
  await fixture(async (_, number) => {
    if (number === 2) throw Object.assign(new Error('Sign in'), { status: 401 });
    return page([operation('private')], { hasMore: true, nextCursor: 'next' });
  }, async ({ find, text }) => {
    find('button', 'Load more').click(); await flush(); assert.doesNotMatch(text(), /private/); assert.match(text(), /Sign in/);
    find('button', 'Retry').click(); await flush(); assert.match(text(), /private/);
  });
});

test('unmount aborts, blocks later updates and detached controls, and ignores late completion', async () => {
  for (const reject of [false, true]) {
    const pending = deferred();
    await fixture(() => pending.promise, async ({ root, mount, calls, find }) => {
      const refresh = find('button', 'Refresh'), form = root.descendants().find(node => node.tagName === 'form');
      mount.unmount(); mount.unmount(); assert.equal(calls[0].init.signal.aborted, true);
      mount.update({ date: '2026-09-24' }); refresh.fire('click'); form.fire('submit');
      if (reject) pending.reject(new Error('late')); else pending.resolve(page([operation('late')]));
      await flush(); assert.equal(root.children.length, 0); assert.equal(calls.length, 1);
    });
  }
});
