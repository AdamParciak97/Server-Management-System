const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');
const source = readFileSync(join(__dirname, '../static/js/views/overview.js'), 'utf8');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}

function setup() {
  const elements = new Map();
  const requests = [];
  function element() {
    const classes = new Set();
    return {textContent: '', innerHTML: '', attributes: {},
      classList: {add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value)},
      setAttribute(key, value) {this.attributes[key] = value;}};
  }
  const container = {set innerHTML(html) {
    elements.clear();
    for (const match of html.matchAll(/id="([^"]+)"/g)) elements.set(match[1], element());
  }};
  const context = vm.createContext({Views: {}, document: {getElementById: id => elements.get(id)},
    UI: {icon: () => '', empty: (title, description) => title + ' ' + description},
    App: {escHtml: value => String(value), timeAgo: () => 'now', statusBadge: value => value},
    API: {getStats() {const request = deferred(); requests.push(request); return request.promise;},
      getServers: async () => ({data: []})}, console});
  vm.runInContext(source, context);
  return {view: context.Views.Overview, elements, requests, container};
}

test('empty infrastructure does not claim 100% availability', async () => {
  const h = setup();
  const render = h.view.render(h.container);
  h.requests[0].resolve({data: {total_servers: 0, online_servers: 0}});
  await render;
  assert.equal(h.elements.get('fleet-percent').textContent, '—');
  assert.equal(h.elements.get('fleet-ring').attributes.opacity, '0');
  assert.match(h.elements.get('recent-servers').innerHTML, /Your fleet starts here/);
});

test('availability uses reported server counts', async () => {
  const h = setup();
  const render = h.view.render(h.container);
  h.requests[0].resolve({data: {total_servers: 8, online_servers: 6, offline_servers: 2}});
  await render;
  assert.equal(h.elements.get('fleet-percent').textContent, '75%');
  assert.equal(h.elements.get('st-offline').textContent, 2);
  assert.equal(h.elements.get('fleet-ring').attributes.opacity, '1');
});

test('older overview response cannot overwrite the latest refresh', async () => {
  const h = setup();
  const render = h.view.render(h.container);
  const refresh = h.view.refresh();
  h.requests[1].resolve({data: {total_servers: 8, online_servers: 6}});
  await refresh;
  h.requests[0].resolve({data: {total_servers: 1, online_servers: 1}});
  await render;
  assert.equal(h.elements.get('st-total').textContent, 8);
  assert.equal(h.elements.get('fleet-percent').textContent, '75%');
});

test('failed refresh shows an error and a successful retry clears it', async () => {
  const h = setup();
  const render = h.view.render(h.container);
  h.requests[0].reject(new Error('Network unavailable'));
  await render;
  assert.match(h.elements.get('overview-error').textContent, /Network unavailable/);
  assert.equal(h.elements.get('overview-error').classList.contains('hidden'), false);
  assert.equal(h.elements.get('overview-updated').textContent, 'Snapshot unavailable');
  const refresh = h.view.refresh();
  h.requests[1].resolve({data: {total_servers: 2, online_servers: 1}});
  await refresh;
  assert.equal(h.elements.get('overview-error').classList.contains('hidden'), true);
  assert.equal(h.elements.get('fleet-percent').textContent, '50%');
});

test('response from an unmounted overview cannot touch the replacement view', async () => {
  const h = setup();
  const render = h.view.render(h.container);
  h.container.innerHTML = '<div id="replacement"></div>';
  h.requests[0].resolve({data: {total_servers: 8, online_servers: 6}});
  await render;
  assert.deepEqual([...h.elements.keys()], ['replacement']);
});
