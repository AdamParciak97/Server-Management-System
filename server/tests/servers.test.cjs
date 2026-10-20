'use strict';

// Run without browser dependencies: node --test server/tests/*.test.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../static/js/views/servers.js'), 'utf8');

function setup(api = {}) {
  const elements = new Map();
  for (const id of ['filter-search', 'filter-status', 'filter-group', 'filter-os', 'filter-sort', 'servers-tbody', 'servers-count', 'inventory-summary', 'servers-filter-note', 'servers-refresh', 'inventory-page-size', 'inventory-page-note', 'inventory-prev', 'inventory-next', 'inventory-view', 'inventory-views-message', 'inventory-views-retry', 'inventory-update', 'inventory-delete']) {
    elements.set(id, {
      value: '', innerHTML: '', textContent: '', children: [], appendChild(child) { this.children.push(child); },
      addEventListener(type, listener) { this[type] = listener; }
    });
  }
  let servers = [];
  const requests = [];
  const context = {
    Views: {},
    window: {},
    alert() {},
    API: {
      async getServers() { return { data: servers }; },
      async listGroups() { return { data: [{ id: 'group-1', name: 'Production' }] }; },
      ...api,
      async getInventory(filters) {
        requests.push({...filters});
        if (api.getInventory) return api.getInventory(filters);
        const response = api.getServers ? await api.getServers() : {data: servers};
        return inventoryResponse(response.data || [], filters);
      },
      listInventoryGroups: api.listInventoryGroups || api.listGroups || (async () => ({data:[{id:'group-1',name:'Production'}]})),
      listInventoryViews: api.listInventoryViews || (async () => ({success:true,data:[]}))
    },
    document: {
      getElementById: id => elements.get(id) || null,
      createElement: () => ({})
    },
    App: { escHtml: value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]), timeAgo: () => 'now', statusBadge: value => value,
      formatDate: value => String(value) }
  };
  vm.runInNewContext(readFileSync(join(__dirname, '../static/js/ui.js'), 'utf8'), context);
  context.UI = context.window.UI;
  vm.runInNewContext(source, context, { filename: 'servers.js' });
  return {
    view: context.Views.Servers,
    requests, context,
    elements,
    setServers(value) { servers = value; },
    get html() { return elements.get('servers-tbody').innerHTML; }
  };
}

const inventoryResponse = require('./inventory-fixture.cjs');

const host = (id, overrides = {}) => ({
  id, hostname: id, ip_addresses: ['192.0.2.1'],
  status: 'online', os: 'Linux', group_id: 'group-1', ...overrides
});

for (const [filter, value, excluded] of [
  ['filter-search', '192.0.2.1', { ip_addresses: ['198.51.100.2'] }],
  ['filter-status', 'online', { status: 'offline' }],
  ['filter-group', 'group-1', { group_id: 'group-2' }],
  ['filter-os', 'linux', { os: 'Windows' }]
]) {
  test(`reload reapplies ${filter} to fresh server data`, async () => {
    const state = setup();
    state.setServers([host('previous-host')]);
    await state.view.render({ innerHTML: '' });
    assert.match(state.html, /previous-host/);
    state.elements.get(filter).value = value;
    state.setServers([host('matching-host'), host('excluded-host', excluded)]);
    await state.view.reload();
    assert.match(state.html, /matching-host/);
    assert.doesNotMatch(state.html, /excluded-host|previous-host/);
    assert.equal(state.elements.get(filter).value, value);
  });
}

test('reload combines active filters and shows an empty result when none match', async () => {
  const state = setup();
  state.elements.get('filter-status').value = 'online';
  state.elements.get('filter-os').value = 'windows';
  state.setServers([host('linux-host'), host('offline-host', { os: 'Windows', status: 'offline' })]);
  await state.view.reload();
  assert.match(state.html, /No servers found/);
  assert.doesNotMatch(state.html, /linux-host|offline-host/);
});

test('the group filter offers unassigned servers and keeps the option after reload', async () => {
  const state = setup();
  const container = { innerHTML: '' };
  await state.view.render(container);
  assert.match(container.innerHTML, /<option value="__ungrouped__">No group<\/option>/);
  assert.match(state.elements.get('filter-group').innerHTML,
    /<option value="__ungrouped__">No group<\/option>/);
  await state.view.reload();
  assert.match(state.elements.get('filter-group').innerHTML,
    /<option value="__ungrouped__">No group<\/option>/);
});

test('unassigned group filter includes null, empty and missing groups and combines with other filters', async () => {
  const state = setup();
  const missingGroup = host('missing-group');
  delete missingGroup.group_id;
  state.setServers([
    host('null-group', { group_id: null }),
    host('empty-group', { group_id: '' }),
    missingGroup,
    host('assigned-host'),
    host('offline-host', { group_id: null, status: 'offline' }),
    host('windows-host', { group_id: null, os: 'Windows' })
  ]);
  await state.view.render({ innerHTML: '' });
  const filter = state.elements.get('filter-group');
  filter.value = '__ungrouped__';
  await filter.input();
  for (const name of ['null-group', 'empty-group', 'missing-group', 'offline-host', 'windows-host']) {
    assert.ok(state.html.includes(name), `${name} should be visible`);
  }
  assert.doesNotMatch(state.html, /assigned-host/);
  state.elements.get('filter-status').value = 'online';
  state.elements.get('filter-os').value = 'linux';
  state.elements.get('filter-search').value = 'group';
  await filter.input();
  assert.match(state.html, /null-group/);
  assert.doesNotMatch(state.html, /assigned-host|offline-host|windows-host/);
  state.setServers([host('fresh-group', { group_id: null }), host('assigned-group')]);
  await state.view.reload();
  assert.equal(filter.value, '__ungrouped__');
  assert.match(state.html, /fresh-group/);
  assert.doesNotMatch(state.html, /assigned-group|null-group|empty-group|missing-group/);
  filter.value = '';
  await filter.input();
  assert.match(state.html, /fresh-group/);
  assert.match(state.html, /assigned-group/);
});

test('server count follows combined filters, empty results and clearing filters', async () => {
  const state = setup();
  state.setServers([
    host('online-linux'), host('offline-linux', { status: 'offline' }),
    host('online-windows', { os: 'Windows' })
  ]);
  const container = { innerHTML: '' };
  await state.view.render(container);
  assert.match(container.innerHTML, /id="servers-count"[^>]*role="status"/);
  const count = state.elements.get('servers-count');
  assert.equal(count.textContent, 'Showing 3 of 3 servers');
  const status = state.elements.get('filter-status');
  const os = state.elements.get('filter-os');
  status.value = 'online';
  await status.input();
  assert.equal(count.textContent, 'Showing 2 of 3 servers');
  os.value = 'linux';
  await os.input();
  assert.equal(count.textContent, 'Showing 1 of 3 servers');
  const search = state.elements.get('filter-search');
  search.value = 'absent-host';
  await search.input();
  assert.equal(count.textContent, 'Showing 0 of 3 servers');
  assert.match(state.html, /No servers found/);
  status.value = os.value = search.value = '';
  await search.input();
  assert.equal(count.textContent, 'Showing 3 of 3 servers');
});

test('server count uses fresh totals after reload including an empty inventory', async () => {
  const state = setup();
  await state.view.render({ innerHTML: '' });
  const count = state.elements.get('servers-count');
  assert.equal(count.textContent, 'Showing 0 of 0 servers');
  state.elements.get('filter-group').value = '__ungrouped__';
  state.setServers([host('unassigned', { group_id: null }), host('assigned')]);
  await state.view.reload();
  assert.equal(count.textContent, 'Showing 1 of 2 servers');
  state.setServers([host('assigned')]);
  await state.view.reload();
  assert.equal(count.textContent, 'Showing 0 of 1 servers');
  state.setServers([]);
  await state.view.reload();
  assert.equal(count.textContent, 'Showing 0 of 0 servers');
});

test('server count clears on reload failure and returns after recovery', async () => {
  let fail = false;
  const state = setup({ async getServers() {
    if (fail) throw new Error('Network unavailable');
    return { data: [host('available-host')] };
  } });
  await state.view.reload();
  const count = state.elements.get('servers-count');
  assert.equal(count.textContent, 'Showing 1 of 1 servers');
  fail = true;
  await state.view.reload();
  assert.match(state.html, /Network unavailable/);
  assert.equal(count.textContent, '');
  fail = false;
  await state.view.reload();
  assert.equal(count.textContent, 'Showing 1 of 1 servers');
});

for (const failingEndpoint of ['getServers', 'listGroups']) {
  test(`filters preserve a ${failingEndpoint} error until successful reload`, async () => {
    let fail = false;
    let servers = [host('old-host')];
    const state = setup({
      async getServers() {
        if (fail && failingEndpoint === 'getServers') throw new Error('Inventory unavailable');
        return { data: servers };
      },
      async listGroups() {
        if (fail && failingEndpoint === 'listGroups') throw new Error('Inventory unavailable');
        return { data: [{ id: 'group-1', name: 'Production' }] };
      }
    });
    await state.view.render({ innerHTML: '' });
    assert.match(state.html, /old-host/);
    fail = true;
    await state.view.reload();
    const errorHtml = state.html;
    assert.match(errorHtml, /Inventory unavailable/);
    for (const [id, value] of [
      ['filter-search', 'host'], ['filter-status', 'online'],
      ['filter-group', 'group-1'], ['filter-os', 'linux']
    ]) {
      const filter = state.elements.get(id);
      filter.value = value;
      await filter.input();
      assert.equal(state.html, errorHtml);
      assert.equal(state.elements.get('servers-count').textContent, '');
    }
    fail = false;
    servers = [host('fresh-host'), host('offline-host', { status: 'offline' })];
    await state.view.reload();
    assert.match(state.html, /fresh-host/);
    assert.doesNotMatch(state.html, /old-host|offline-host|Inventory unavailable/);
    assert.equal(state.elements.get('servers-count').textContent, 'Showing 1 of 2 servers');
    state.elements.get('filter-status').value = '';
    await state.elements.get('filter-status').input();
    assert.match(state.html, /offline-host/);
    assert.equal(state.elements.get('servers-count').textContent, 'Showing 2 of 2 servers');
  });
}

test('filters preserve an initial load error instead of showing an empty inventory', async () => {
  const state = setup({ async getServers() { throw new Error('Inventory unavailable'); } });
  await state.view.render({ innerHTML: '' });
  const search = state.elements.get('filter-search');
  search.value = 'host';
  await search.input();
  assert.match(state.html, /Inventory unavailable/);
  assert.doesNotMatch(state.html, /No servers found/);
  assert.equal(state.elements.get('servers-count').textContent, '');
});

test('reload without active filters displays all fresh servers', async () => {
  const state = setup();
  state.setServers([host('linux-host'), host('windows-host', { os: 'Windows' })]);
  await state.view.render({ innerHTML: '' });
  assert.match(state.html, /linux-host/);
  assert.match(state.html, /windows-host/);
});

for (const search of ['2001:db8:abcd::42', '2001:DB8:ABCD::42']) {
  test(`server search matches IPv6 regardless of letter case: ${search}`, async () => {
    const state = setup();
    state.setServers([
      host('matching-host', { ip_addresses: ['192.0.2.1', '2001:DB8:ABCD::42'] }),
      host('excluded-host', { ip_addresses: ['2001:DB8:ABCD::43'] }),
      host('no-address-host', { ip_addresses: null })
    ]);
    await state.view.render({ innerHTML: '' });
    const filter = state.elements.get('filter-search');
    filter.value = search;
    await filter.input();
    assert.match(state.html, /matching-host/);
    assert.doesNotMatch(state.html, /excluded-host|no-address-host/);
    assert.match(state.html, /2001:DB8:ABCD::42/, 'keep the original address for display');
    await state.view.reload();
    assert.match(state.html, /matching-host/);
    assert.doesNotMatch(state.html, /excluded-host|no-address-host/);
    assert.equal(filter.value, search);
  });
}

for (const search of ['  MATCHING-HOST\t', '\t192.0.2.42  ', '  2001:DB8::42\n']) {
  test(`server search ignores surrounding whitespace: ${JSON.stringify(search)}`, async () => {
    const state = setup();
    state.setServers([
      host('matching-host', { ip_addresses: ['192.0.2.42', '2001:db8::42'] }),
      host('excluded-host', { ip_addresses: ['198.51.100.2'] })
    ]);
    await state.view.render({ innerHTML: '' });
    const filter = state.elements.get('filter-search');
    filter.value = search;
    await filter.input();
    assert.match(state.html, /matching-host/);
    assert.doesNotMatch(state.html, /excluded-host/);
    await state.view.reload();
    assert.match(state.html, /matching-host/);
    assert.doesNotMatch(state.html, /excluded-host/);
    assert.equal(filter.value, search, 'normalization must not rewrite the input');
  });
}

test('whitespace-only search leaves other inventory filters active', async () => {
  const state = setup();
  state.setServers([host('online-host'), host('offline-host', { status: 'offline' })]);
  await state.view.render({ innerHTML: '' });
  state.elements.get('filter-status').value = 'online';
  const filter = state.elements.get('filter-search');
  filter.value = ' \t ';
  await filter.input();
  assert.match(state.html, /online-host/);
  assert.doesNotMatch(state.html, /offline-host/);
  await state.view.reload();
  assert.match(state.html, /online-host/);
  assert.doesNotMatch(state.html, /offline-host/);
});

for (const search of ['node.example.test', '  NODE.EXAMPLE.TEST\t', 'example.test']) {
  test(`server search matches FQDN and preserves other filters: ${JSON.stringify(search)}`, async () => {
    const state = setup();
    state.setServers([
      host('matching-host', { fqdn: 'Node.Example.Test' }),
      host('offline-host', { fqdn: 'Node.Example.Test', status: 'offline' }),
      host('excluded-host', { fqdn: 'node.other.test' }),
      host('missing-fqdn-host'),
      host('empty-fqdn-host', { fqdn: '' }),
      host('null-fqdn-host', { fqdn: null })
    ]);
    await state.view.render({ innerHTML: '' });
    state.elements.get('filter-status').value = 'online';
    const filter = state.elements.get('filter-search');
    filter.value = search;
    await filter.input();
    assert.match(state.html, /matching-host/);
    assert.doesNotMatch(state.html, /offline-host|excluded-host|missing-fqdn-host|empty-fqdn-host|null-fqdn-host/);
    state.setServers([host('fresh-host', { fqdn: 'Node.Example.Test' }), host('other-host')]);
    await state.view.reload();
    assert.match(state.html, /fresh-host/);
    assert.doesNotMatch(state.html, /matching-host|other-host/);
    assert.equal(filter.value, search);
  });
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function setupDetails(api = {}) {
  const state = setup({
    async getServer(id) { return { data: host(id) }; },
    async getServerHistory(id) { return { data: [{ id: `${id}-report`, timestamp: id }] }; },
    async listCommands() { return { data: [] }; },
    async getServerTimeline() { return { data: [] }; },
    async getServerBaseline(id) { return { data: { created_at: `${id}-baseline` } }; },
    ...api
  });
  state.elements.set('server-detail', {
    innerHTML: '', classList: { remove() {}, add() {} }, scrollIntoView() {}
  });
  return state;
}

for (const stage of ['server', 'baseline']) {
  for (const outcome of ['success', 'failure']) {
    test(`older detail ${stage} ${outcome} cannot overwrite the selected host`, async () => {
      const pending = deferred();
      const started = deferred();
      const endpoint = stage === 'server' ? 'getServer' : 'getServerBaseline';
      const response = id => ({ data: stage === 'server' ? host(id) : { created_at: `${id}-baseline` } });
      const state = setupDetails({ [endpoint](id) {
        if (id === 'old-host') { started.resolve(); return pending.promise; }
        return Promise.resolve(response(id));
      } });
      const older = state.view.showDetail('old-host');
      await started.promise;
      await state.view.showDetail('selected-host');
      const detail = state.elements.get('server-detail');
      const selectedHtml = detail.innerHTML;
      assert.match(selectedHtml, /<h3>selected-host<\/h3>/);
      assert.match(selectedHtml, /selected-host-baseline/);
      if (outcome === 'success') pending.resolve(response('old-host'));
      else pending.reject(new Error('Old detail unavailable'));
      await older;
      assert.equal(detail.innerHTML, selectedHtml);
    });
  }
}

for (const outcome of ['success', 'failure']) {
  test(`detail ${outcome} after leaving the view leaves detached content untouched`, async () => {
    const pending = deferred();
    const state = setupDetails({ getServer: () => pending.promise });
    const detail = state.elements.get('server-detail');
    const loading = state.view.showDetail('old-host');
    const loadingHtml = detail.innerHTML;
    state.elements.delete('server-detail');
    if (outcome === 'success') pending.resolve({ data: host('old-host') });
    else pending.reject(new Error('Old detail unavailable'));
    await loading;
    assert.equal(detail.innerHTML, loadingHtml);
  });
}

for (const destination of ['another view', 'replacement server list']) {
  for (const outcome of ['success', 'failure']) {
    test(`reload ${outcome} is ignored after navigation to ${destination}`, async () => {
      const pending = deferred();
      const state = setup({ getServers: () => pending.promise });
      const originalElements = new Map(state.elements);
      const loading = state.view.reload();
      // Loading now updates summary and refresh button before navigation.
      const beforeNavigation = new Map([...originalElements].map(([id, el]) => [id, { html: el.innerHTML, disabled: el.disabled }]));
      state.elements.clear();
      if (destination === 'replacement server list') {
        for (const [id, element] of originalElements) {
          state.elements.set(id, { ...element, innerHTML: 'New view content' });
        }
      }
      if (outcome === 'success') pending.resolve({ data: [host('stale-host')] });
      else pending.reject(new Error('Old view network failure'));
      await assert.doesNotReject(loading);
      for (const [id, element] of originalElements) {
        assert.equal(element.innerHTML, beforeNavigation.get(id).html);
        assert.equal(element.disabled, beforeNavigation.get(id).disabled);
      }
      for (const element of state.elements.values()) assert.equal(element.innerHTML, 'New view content');
    });
  }
}

test('reload without a mounted server list does not fetch data', async () => {
  let calls = 0;
  const state = setup({
    async getServers() { calls++; return { data: [] }; },
    async listGroups() { calls++; return { data: [] }; }
  });
  state.elements.clear();
  await assert.doesNotReject(state.view.reload());
  assert.equal(calls, 0);
});

for (const outcome of ['success', 'failure']) {
  test(`an older reload ${outcome} cannot replace the latest server list`, async () => {
    const older = deferred();
    const newer = deferred();
    const replies = [Promise.resolve({ data: [] }), older.promise, newer.promise, Promise.resolve({data:[host('latest-host')]})];
    const state = setup({ getServers: () => replies.shift() });
    await state.view.render({ innerHTML: '' });
    const first = state.view.reload();
    const second = state.view.reload();
    newer.resolve({ data: [host('latest-host')] });
    await second;
    assert.match(state.html, /latest-host/);
    if (outcome === 'success') older.resolve({ data: [host('stale-host')] });
    else older.reject(new Error('Old network failure'));
    await first;
    assert.match(state.html, /latest-host/);
    assert.doesNotMatch(state.html, /stale-host|Old network failure/);
    assert.equal(state.elements.get('servers-count').textContent, 'Showing 1 of 1 servers');
    // A filter event starts a fresh server query and must not restore stale data.
    state.elements.get('filter-status').value = 'online';
    await state.elements.get('filter-status').input();
    assert.match(state.html, /latest-host/);
    assert.doesNotMatch(state.html, /stale-host/);
  });
}

test('a latest reload failure remains visible after an older success and permits recovery', async () => {
  const older = deferred();
  const newer = deferred();
  const replies = [older.promise, newer.promise, Promise.resolve({ data: [host('recovered-host')] })];
  const state = setup({ getServers: () => replies.shift() });
  const first = state.view.reload();
  const second = state.view.reload();
  newer.reject(new Error('Latest network failure'));
  await second;
  assert.match(state.html, /Latest network failure/);
  older.resolve({ data: [host('stale-host')] });
  await first;
  assert.match(state.html, /Latest network failure/);
  assert.doesNotMatch(state.html, /stale-host/);
  await state.view.reload();
  assert.match(state.html, /recovered-host/);
  assert.doesNotMatch(state.html, /Latest network failure|stale-host/);
});

test('empty inventory guides installation; filtered inventory offers reset through the API', async () => {
  const state = setup();
  await state.view.render({ innerHTML: '' });
  assert.match(state.html, /Your inventory starts with one agent/);
  assert.match(state.html, /App.navigate\('packages'\)/);
  state.setServers([host('alpha')]);
  await state.view.reload();
  state.elements.get('filter-search').value = 'missing';
  await state.elements.get('filter-search').input();
  assert.match(state.html, /No servers found/);
  assert.match(state.html, /Views.Servers.clearFilters\(\)/);
  await state.view.clearFilters();
  assert.match(state.html, /alpha/);
  assert.equal(state.elements.get('servers-count').textContent, 'Showing 1 of 1 servers');
});

test('summary uses real totals and unknown statuses match the status shortcut', async () => {
  const state = setup();
  state.setServers([host('up'), host('down', { status: 'offline' }), host('unset', { status: null }), host('unrecognized', { status: 'new' })]);
  await state.view.render({ innerHTML: '' });
  const summary = state.elements.get('inventory-summary').innerHTML;
  assert.match(summary, /Total hosts<\/span><strong>4<\/strong>/);
  assert.match(summary, /Unknown<\/span><strong>2<\/strong>/);
  await state.view.filterStatus('unknown');
  assert.match(state.html, /unset/);
  assert.match(state.html, /unrecognized/);
  assert.doesNotMatch(state.html, /Inspect up|Inspect down/);
  assert.equal(state.elements.get('servers-count').textContent, 'Showing 2 of 4 servers');
  state.elements.get('filter-search').value = 'unset';
  await state.elements.get('filter-search').input();
  assert.equal(state.elements.get('servers-count').textContent, 'Showing 1 of 4 servers');
  assert.equal(state.elements.get('inventory-summary').innerHTML, summary);
});

test('sorting is deterministic, combines with filters and persists across refresh', async () => {
  const state = setup();
  state.setServers([host('node10', { last_seen: null }), host('node2', { status: 'offline', last_seen: '2026-10-01' }), host('node3', { status: 'unknown', last_seen: '2026-10-02' })]);
  await state.view.render({ innerHTML: '' });
  const before = (a, b) => assert.ok(state.html.indexOf(`Inspect ${a}`) < state.html.indexOf(`Inspect ${b}`));
  before('node10', 'node2');
  const sort = state.elements.get('filter-sort');
  sort.value = 'seen'; await sort.input();
  before('node3', 'node2'); before('node2', 'node10');
  sort.value = 'status'; await sort.input();
  before('node2', 'node3'); before('node3', 'node10');
  await state.view.reload();
  before('node2', 'node3');
  assert.equal(sort.value, 'status');
  await state.view.filterStatus('online');
  assert.match(state.html, /node10/);
  assert.doesNotMatch(state.html, /node2|node3/);
});

test('failed refresh removes summary counts, exposes retry and restores button on recovery', async () => {
  let fail = false;
  const state = setup({ getServers: async () => { if (fail) throw new Error('<offline>'); return { data: [host('alpha')] }; } });
  await state.view.render({ innerHTML: '' });
  fail = true;
  await state.view.reload();
  assert.match(state.html, /&lt;offline&gt;/);
  assert.match(state.html, /Try again/);
  assert.doesNotMatch(state.elements.get('inventory-summary').innerHTML, /<strong>1/);
  assert.equal(state.elements.get('servers-refresh').disabled, false);
  await state.view.clearFilters();
  assert.match(state.html, /Inventory could not be loaded/);
  fail = false;
  await state.view.reload();
  assert.match(state.html, /alpha/);
  assert.match(state.elements.get('inventory-summary').innerHTML, /Total hosts<\/span><strong>1/);
});

for (const stage of ['server', 'baseline']) {
  test(`closing details invalidates an in-flight ${stage} response`, async () => {
    const pending = deferred();
    const started = deferred();
    const endpoint = stage === 'server' ? 'getServer' : 'getServerBaseline';
    const state = setupDetails({ [endpoint]() { started.resolve(); return pending.promise; } });
    const detail = state.elements.get('server-detail');
    let hidden = false;
    detail.classList.add = name => { hidden = name === 'hidden'; };
    const loading = state.view.showDetail('closed-host');
    await started.promise;
    state.view.closeDetail();
    const html = detail.innerHTML;
    pending.resolve({ data: stage === 'server' ? host('closed-host') : { created_at: 'late-baseline' } });
    await loading;
    assert.equal(detail.innerHTML, html);
    assert.equal(hidden, true);
  });
}

test('tabs support arrows, wraparound, Home and End with one selected panel', () => {
  const state = setup();
  let focused;
  const names = ['identity', 'reports', 'commands', 'timeline'];
  for (const name of names) {
    state.elements.set(`host-tab-${name}`, { setAttribute(key, value) { this[key] = value; }, focus() { focused = name; } });
    state.elements.set(`host-panel-${name}`, {});
  }
  state.view.selectDetailTab('reports');
  function check(name) {
    for (const item of names) {
      const tab = state.elements.get(`host-tab-${item}`);
      assert.equal(tab['aria-selected'], String(item === name));
      assert.equal(tab.tabIndex, item === name ? 0 : -1);
      assert.equal(state.elements.get(`host-panel-${item}`).hidden, item !== name);
    }
  }
  check('reports');
  for (const [key, from, to] of [['ArrowRight', 'reports', 'commands'], ['ArrowRight', 'timeline', 'identity'], ['ArrowLeft', 'identity', 'timeline'], ['Home', 'timeline', 'identity'], ['End', 'identity', 'timeline']]) {
    let prevented = false;
    state.view.detailTabKey({ key, preventDefault() { prevented = true; } }, from);
    check(to); assert.equal(focused, to); assert.equal(prevented, true);
  }
});

test('baseline failures are distinct from no baseline and report comparison needs two reports', async () => {
  const state = setupDetails({ getServerBaseline: async () => { throw new Error('unavailable'); } });
  await state.view.showDetail('alpha');
  const html = state.elements.get('server-detail').innerHTML;
  assert.match(html, /Baseline could not be loaded/);
  assert.doesNotMatch(html, /No baseline selected/);
  assert.match(html, /disabled onclick="Views.Servers.compareSelectedReports/);
  assert.match(html, /for="compare-report-from"/);
});

for (const operation of ['assignGroup', 'setBaseline']) {
  test(`late ${operation} completion does not reopen a previously selected host`, async () => {
    const pending = deferred();
    const state = setupDetails({ assignGroup: () => pending.promise, setServerBaseline: () => pending.promise });
    state.elements.set('server-group-select', { value: 'group-1' });
    await state.view.showDetail('old-host');
    const mutation = state.view[operation]('old-host', 'report');
    await state.view.showDetail('new-host');
    const html = state.elements.get('server-detail').innerHTML;
    pending.resolve({});
    await mutation;
    assert.equal(state.elements.get('server-detail').innerHTML, html);
    assert.match(html, /<h3>new-host<\/h3>/);
  });
}

test('remounting inventory does not expose a previous view while its first request is pending', async () => {
  const pending = deferred();
  let calls = 0;
  const state = setup({ getServers: () => ++calls === 1 ? Promise.resolve({data:[host('previous-host')]}) : pending.promise });
  await state.view.render({innerHTML:''});
  state.elements.get('servers-tbody').innerHTML = 'Loading new view';
  const loading = state.view.render({innerHTML:''});
  await state.elements.get('filter-search').input();
  assert.equal(state.html, 'Loading new view');
  pending.resolve({data:[]});
  await loading;
  assert.match(state.html, /Your inventory starts with one agent/);
  assert.doesNotMatch(state.html, /previous-host/);
});

test('baseline refresh cannot switch the tabs of a newly selected host', async () => {
  const pending = deferred();
  const started = deferred();
  let calls = 0;
  const state = setupDetails({
    setServerBaseline: async () => ({}),
    getServer(id) {
      if (++calls === 2) { started.resolve(); return pending.promise; }
      return Promise.resolve({data:host(id)});
    }
  });
  await state.view.showDetail('old-host');
  const operation = state.view.setBaseline('old-host', 'report');
  await started.promise;
  await state.view.showDetail('new-host');
  for (const name of ['identity', 'reports', 'commands', 'timeline']) {
    state.elements.set(`host-tab-${name}`, { setAttribute(key, value) { this[key] = value; } });
    state.elements.set(`host-panel-${name}`, {hidden:name !== 'identity'});
  }
  pending.resolve({data:host('old-host')});
  await operation;
  assert.equal(state.elements.get('host-panel-identity').hidden, false);
  assert.equal(state.elements.get('host-panel-reports').hidden, true);
});

test('inventory only renders one page and preserves filters and sorting across navigation', async () => {
  const state = setup();
  state.setServers(Array.from({length:61}, (_,i) => host(`node-${String(i).padStart(3,'0')}`)));
  await state.view.render({innerHTML:''});
  assert.equal((state.html.match(/class="host-link"/g) || []).length,25);
  assert.match(state.html,/node-024/); assert.doesNotMatch(state.html,/node-025/);
  assert.equal(state.elements.get('inventory-prev').disabled,true);
  assert.equal(state.elements.get('inventory-next').disabled,false);
  await state.view.changePage(1);
  assert.match(state.html,/node-025/); assert.doesNotMatch(state.html,/node-024/);
  assert.equal(state.requests.at(-1).page,2);
  await state.view.changePage(1);
  assert.equal((state.html.match(/class="host-link"/g) || []).length,11);
  assert.equal(state.elements.get('inventory-next').disabled,true);
  const calls = state.requests.length; await state.view.changePage(1);
  assert.equal(state.requests.length,calls);
  state.elements.get('filter-search').value = 'node-00';
  await state.elements.get('filter-search').input();
  assert.equal(state.requests.at(-1).page,1);
  assert.equal(state.requests.at(-1).search,'node-00');
  assert.match(state.elements.get('inventory-page-note').textContent,/10 matching hosts/);
  state.elements.get('inventory-page-size').value = '50';
  await state.elements.get('inventory-page-size').input();
  assert.equal(state.requests.at(-1).page_size,50);
  assert.equal(state.requests.at(-1).search,'node-00');
});

test('empty final page is clamped by the API after the fleet shrinks', async () => {
  const state = setup();
  state.setServers(Array.from({length:26},(_,i)=>host(`node-${i}`)));
  await state.view.render({innerHTML:''}); await state.view.changePage(1);
  state.setServers([host('remaining')]); await state.view.reload();
  assert.match(state.html,/remaining/);
  assert.match(state.elements.get('inventory-page-note').textContent,/Page 1 of 1/);
  assert.equal(state.elements.get('inventory-prev').disabled,true);
});

test('latest server filter result wins and returned records are not filtered again locally', async () => {
  const older = deferred(), newer = deferred(); let calls=0;
  const state = setup({getInventory: f => ++calls===1 ? Promise.resolve(inventoryResponse([],f)) : calls===2 ? older.promise : newer.promise});
  await state.view.render({innerHTML:''});
  state.elements.get('filter-search').value='older'; const first=state.elements.get('filter-search').input();
  state.elements.get('filter-search').value='newer'; const second=state.elements.get('filter-search').input();
  newer.resolve(inventoryResponse([host('api-selected-host')],{page:1,page_size:25})); await second;
  older.resolve(inventoryResponse([host('stale')],{page:1,page_size:25})); await first;
  assert.match(state.html,/api-selected-host/); assert.doesNotMatch(state.html,/stale/);
  assert.equal(state.requests.at(-1).search,'newer');
});

test('malformed pagination is an error and disables page navigation', async () => {
  const state=setup({getInventory:async()=>({success:true,data:{items:[],total:2,page:1,page_size:1000}})});
  await state.view.render({innerHTML:''});
  assert.match(state.html,/Invalid inventory response/);
  assert.equal(state.elements.get('inventory-next').disabled,true);
  assert.equal(state.elements.get('servers-count').textContent,'');
});

test('invalid summary values cannot render markup or fabricated counters', async () => {
  const state=setup({getInventory:async()=>({success:true,data:{items:[],total:0,page:1,page_size:25,summary:{total:1,online:'<img onerror=alert(1)>',offline:0,unknown:0}}})});
  await state.view.render({innerHTML:''});
  assert.match(state.html,/Invalid inventory response/);
  assert.doesNotMatch(state.elements.get('inventory-summary').innerHTML,/<img|<strong>/);
});

test('clearing filters explicitly recovers after a saved group is denied', async () => {
  const state=setup({getInventory:async f=>{if(f.group)throw new Error('group outside current scope');return inventoryResponse([host('allowed')],f);}});
  await state.view.render({innerHTML:''});
  state.elements.get('filter-group').value='denied';await state.view.reload();
  assert.match(state.html,/group outside current scope/);
  await state.view.clearFilters();assert.match(state.html,/allowed/);
  assert.equal(state.requests.at(-1).group,'');
});

test('saved views load independently so a preferences outage does not hide inventory', async () => {
  const state=setup({listInventoryViews:async()=>{throw new Error('synthetic outage');}});
  state.setServers([host('available')]); await state.view.render({innerHTML:''});
  assert.match(state.html,/available/);
  assert.match(state.elements.get('inventory-views-message').textContent,/synthetic outage/);
  assert.equal(state.elements.get('inventory-views-retry').hidden,false);
});

test('saved view restores all filters, starts at page one, and retains a removed group', async () => {
  const filters={search:'IPv6',status:'offline',group:'removed-group',os:'linux',sort:'seen',page_size:50};
  const state=setup({listInventoryViews:async()=>({success:true,data:[{id:'view',name:'<img onerror=alert(1)>',filters}]})});
  await state.view.render({innerHTML:''});
  const select=state.elements.get('inventory-view');
  assert.equal(select.children.at(-1).textContent,'<img onerror=alert(1)>');
  assert.doesNotMatch(select.innerHTML,/onerror/);
  select.value='view'; await state.view.applyView();
  assert.deepEqual(state.requests.at(-1),{...filters,page:1});
  assert.equal(state.elements.get('filter-group').value,'removed-group');
  assert.equal(state.elements.get('inventory-update').disabled,false);
});

test('a late saved view list cannot overwrite a remounted inventory', async () => {
  const old=deferred();let calls=0;
  const state=setup({listInventoryViews:()=>++calls===1?old.promise:Promise.resolve({success:true,data:[{id:'new',name:'New',filters:{}}]})});
  const first=state.view.render({innerHTML:''});
  await state.view.render({innerHTML:''});
  old.resolve({success:true,data:[{id:'old',name:'Old',filters:{}}]}); await first;
  assert.equal(state.elements.get('inventory-view').children.at(-1).textContent,'New');
});

function viewDialog(state) {
  const fields=new Map();
  for(const id of ['form','#inventory-view-name','[type="submit"]','#inventory-save-error','#inventory-delete-confirm','#inventory-delete-error']) {
    fields.set(id,{value:'Private view',textContent:'',disabled:false,focus(){},addEventListener(name,fn){this[name]=fn;}});
  }
  const dialog={isConnected:true,querySelector:key=>fields.get(key),close(){this.isConnected=false;}};
  let content='';state.context.UI.dialog=(_host,_title,html)=>{content=html;return dialog;};
  return {dialog,fields,get content(){return content;}};
}

test('saving captures filters, prevents duplicate submit, and requires server confirmation', async () => {
  const pending=deferred();const writes=[];
  const state=setup({saveInventoryView:(id,data)=>{writes.push({id,data});return pending.promise;}});
  await state.view.render({innerHTML:''});
  state.elements.get('filter-status').value='offline';
  const modal=viewDialog(state);state.view.editView(false);
  const submit=modal.fields.get('form').submit;
  const saving=submit({preventDefault(){}});await submit({preventDefault(){}});
  assert.equal(writes.length,1);assert.equal(writes[0].data.filters.status,'offline');
  assert.equal(modal.fields.get('[type="submit"]').disabled,true);
  pending.resolve({success:false});await saving;
  assert.equal(modal.dialog.isConnected,true);
  assert.match(modal.fields.get('#inventory-save-error').textContent,/did not confirm/);
  assert.equal(modal.fields.get('[type="submit"]').disabled,false);
});

test('confirmed update persists the selected view and escapes its name in the dialog', async () => {
  const view={id:'view',name:'"><img onerror=alert(1)>',filters:{sort:'name',page_size:25}};let written;
  const state=setup({listInventoryViews:async()=>({success:true,data:[view]}),saveInventoryView:async(id,data)=>{written={id,data};return {success:true,data:{...data,id}};}});
  await state.view.render({innerHTML:''});state.elements.get('inventory-view').value='view';await state.view.applyView();
  const modal=viewDialog(state);state.view.editView(true);
  assert.doesNotMatch(modal.content,/<img/);assert.match(modal.content,/&lt;img/);
  modal.fields.get('#inventory-view-name').value='Renamed';await modal.fields.get('form').submit({preventDefault(){}});
  assert.equal(written.id,'view');assert.equal(written.data.name,'Renamed');assert.equal(modal.dialog.isConnected,false);
});

test('delete is explicit, keeps the dialog on failure and cannot double-submit', async () => {
  const pending=deferred();let deletes=0;
  const state=setup({listInventoryViews:async()=>({success:true,data:[{id:'view',name:'Private',filters:{}}]}),deleteInventoryView:()=>{deletes++;return pending.promise;}});
  await state.view.render({innerHTML:''});state.elements.get('inventory-view').value='view';await state.view.applyView();
  const modal=viewDialog(state);state.view.deleteView();assert.equal(deletes,0);
  const remove=modal.fields.get('#inventory-delete-confirm').click;
  const first=remove();await remove();assert.equal(deletes,1);
  pending.resolve({success:true,data:{deleted:false}});await first;
  assert.equal(modal.dialog.isConnected,true);assert.match(modal.fields.get('#inventory-delete-error').textContent,/did not confirm/);
});

test('late saved view write after navigation does not select a view on the new page', async () => {
  const pending=deferred();const state=setup({saveInventoryView:()=>pending.promise});
  await state.view.render({innerHTML:''});const modal=viewDialog(state);state.view.editView(false);
  const saving=modal.fields.get('form').submit({preventDefault(){}});
  state.elements.set('inventory-view',{value:'new page',innerHTML:'',appendChild(){}});modal.dialog.isConnected=false;
  pending.resolve({success:true,data:{id:'old-view'}});await saving;
  assert.equal(state.elements.get('inventory-view').value,'new page');
});

test('confirmed create and delete refresh personal views while preserving current filters', async () => {
  let views=[];
  const state=setup({
    listInventoryViews:async()=>({success:true,data:views}),
    saveInventoryView:async(_id,data)=>{const item={id:'created-view',...data};views=[item];return {success:true,data:item};},
    deleteInventoryView:async id=>{assert.equal(id,'created-view');views=[];return {success:true,data:{deleted:true}};}
  });
  state.setServers([host('kept')]);await state.view.render({innerHTML:''});
  state.elements.get('filter-search').value='kept';await state.view.reload();
  const save=viewDialog(state);state.view.editView(false);await save.fields.get('form').submit({preventDefault(){}});
  assert.equal(state.elements.get('inventory-view').value,'created-view');
  assert.equal(state.elements.get('inventory-delete').disabled,false);
  const remove=viewDialog(state);state.view.deleteView();await remove.fields.get('#inventory-delete-confirm').click();
  assert.equal(remove.dialog.isConnected,false);
  assert.equal(state.elements.get('inventory-view').value,'');
  assert.equal(state.elements.get('inventory-delete').disabled,true);
  assert.equal(state.elements.get('filter-search').value,'kept');
  assert.match(state.html,/kept/);
});
