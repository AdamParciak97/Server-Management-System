'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '../static/js', file), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const response = data => ({data});
const alertItem = (id, extra = {}) => ({id, title: 'Signal ' + id, hostname: 'host-' + id, agent_id: 'agent-' + id, severity: 'medium', type: 'service', message: 'Needs review', created_at: '2026-01-01T12:00:00Z', ...extra});
const hostItem = (id, extra = {}) => ({agent_id: id, hostname: 'host-' + id, status: 'online', last_report_at: '2026-01-01T12:00:00Z', compliant: false, required_agents: [], missing_agents: [], policy_results: [{policy_id: 'policy-1', name: 'Service policy', severity: 'high', compliant: false, message: 'Stopped'}], failed_policies: [{policy_id: 'policy-1'}], ...extra});

// Deliberately small DOM adapter: tests exercise request ordering, API payloads,
// filtering and safe markup. It does not claim to verify browser layout/focus.
function element() {
  return {innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, isConnected: true, attributes: {}, listeners: {},
    setAttribute(k, v) { this.attributes[k] = v; }, addEventListener(k, fn) { this.listeners[k] = fn; }, focus() {},
    querySelector() { return null; }, querySelectorAll() { return []; }};
}
function parse(html) {
  const nodes = new Map();
  for (const match of html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = element();
    if (match[1] === 'select') {
      const rest = html.slice(match.index + match[0].length).split('</select>')[0];
      node.value = rest.match(/<option value="([^"]*)"/)?.[1] || '';
    }
    nodes.set(match[2], node);
  }
  return nodes;
}
function setup(name) {
  let nodes = new Map(), dialogs = [];
  const calls = {}, overrides = {};
  const apiNames = ['listAlerts', 'acknowledgeAlert', 'getCompliance', 'listGroups', 'listCompliancePolicies', 'listComplianceExceptions', 'createCompliancePolicy', 'createComplianceException', 'deleteCompliancePolicy', 'deleteComplianceException'];
  const API = Object.fromEntries(apiNames.map(key => [key, (...args) => { (calls[key] ||= []).push(args); return overrides[key] ? overrides[key](...args) : Promise.resolve(response([])); }]));
  const container = {set innerHTML(html) { for (const node of nodes.values()) node.isConnected = false; dialogs.forEach(d => {d.isConnected = false;}); nodes = parse(html); }};
  const context = vm.createContext({window: {}, Views: {}, document: {getElementById: id => nodes.get(id)}, API, confirm: () => true,
    App: {escHtml: v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), timeAgo: v => v, formatDate: v => v}, console});
  vm.runInContext(read('ui.js'), context); context.UI = context.window.UI;
  context.UI.dialog = (host, title, html) => {
    dialogs.filter(d => d.isConnected).forEach(d => d.close());
    const fields = parse(html), status = element(), save = element(), form = element(), ack = element();
    const dialog = {isConnected: true, html, title, fields, status, save, form, ack,
      close() { this.isConnected = false; },
      querySelector(selector) { if (selector[0] === '#') return fields.get(selector.slice(1)); return {'[data-action-status]': status, '[data-save]': save, form, '[data-acknowledge]': html.includes('data-acknowledge') ? ack : null}[selector] || null; },
      querySelectorAll() { return []; }};
    dialogs.push(dialog); host.querySelector = () => dialogs.findLast(d => d.isConnected) || null; return dialog;
  };
  vm.runInContext(read('views/' + name.toLowerCase() + '.js'), context);
  return {view: context.Views[name], container, calls, overrides, node: id => nodes.get(id), dialog: () => dialogs.at(-1), UI: context.UI};
}

for (const name of ['Alerts', 'Compliance']) {
  const prefix = name.toLowerCase(), api = name === 'Alerts' ? 'listAlerts' : 'getCompliance';
  const fixture = name === 'Alerts' ? alertItem : hostItem;
  test(`${name}: older success and error cannot overwrite the newest snapshot`, async () => {
    for (const reject of [false, true]) {
      const h = setup(name), first = deferred(), second = deferred(); let n = 0;
      h.overrides[api] = () => (++n === 1 ? first : second).promise;
      const initial = h.view.render(h.container), refresh = h.view.reload();
      second.resolve(response([fixture('latest')])); await refresh;
      const markup = h.node(prefix + '-tbody').innerHTML;
      if (reject) first.reject(new Error('Old failure')); else first.resolve(response([fixture('old')]));
      await initial;
      assert.equal(h.node(prefix + '-tbody').innerHTML, markup);
      assert.match(markup, /latest/);
      assert.equal(h.node(prefix + '-refresh').disabled, false);
    }
  });
  test(`${name}: late success and failure after navigation do not modify a replacement view`, async () => {
    for (const reject of [false, true]) {
      const h = setup(name), first = deferred(); h.overrides[api] = () => first.promise;
      const initial = h.view.render(h.container);
      h.container.innerHTML = `<div id="${prefix}-workspace"></div><div id="${prefix}-tbody"></div>`;
      const target = h.node(prefix + '-tbody'); target.innerHTML = 'Replacement';
      if (reject) first.reject(new Error('Gone')); else first.resolve(response([fixture('old')]));
      await initial;
      assert.equal(target.innerHTML, 'Replacement');
    }
  });
  test(`${name}: failed refresh clears counts and filters cannot revive old data`, async () => {
    const h = setup(name); h.overrides[api] = async () => response([fixture('old')]);
    await h.view.render(h.container);
    h.overrides[api] = async () => { throw new Error('Offline'); }; await h.view.reload();
    h.view.applyFilters(); h.view.clearFilters();
    assert.match(h.node(prefix + '-tbody').innerHTML, /Offline/);
    assert.equal(h.node(prefix + '-count').textContent, '');
    assert.match(h.node(prefix + '-summary').innerHTML, /unavailable/);
    h.overrides[api] = async () => response([fixture('recovered')]); await h.view.reload();
    assert.match(h.node(prefix + '-tbody').innerHTML, /recovered/);
    assert.doesNotMatch(h.node(prefix + '-tbody').innerHTML, /Offline/);
  });
  test(`${name}: remount starts with loading state and does not expose cached records`, async () => {
    const h = setup(name); h.overrides[api] = async () => response([fixture('old')]); await h.view.render(h.container);
    const pending = deferred(); h.overrides[api] = () => pending.promise;
    const render = h.view.render(h.container); h.view.applyFilters();
    assert.doesNotMatch(h.node(prefix + '-tbody').innerHTML, /host-old/);
    assert.match(h.node(prefix + '-summary').innerHTML, /Loading/);
    pending.resolve(response([])); await render;
  });
}

test('Alerts: active/history scope is sent to API; severity and normalized search survive refresh', async () => {
  const h = setup('Alerts'); const records = [alertItem('one', {severity: 'high', hostname: 'NODE-01'}), alertItem('two', {severity: 'critical'})];
  h.overrides.listAlerts = async () => response(records); await h.view.render(h.container);
  assert.equal(h.calls.listAlerts[0][0], true);
  h.node('alert-filter').value = 'all'; h.node('alert-search').value = '  node-01  '; h.node('alert-severity').value = 'high';
  await h.view.reload();
  assert.equal(h.calls.listAlerts.at(-1)[0], false);
  assert.equal(h.node('alerts-count').textContent, '1 of 2 signals');
  assert.match(h.node('alerts-tbody').innerHTML, /Signal one/); assert.doesNotMatch(h.node('alerts-tbody').innerHTML, /Signal two/);
  assert.match(h.node('alerts-scope').textContent, /500.*all states/);
});

test('Alerts: severity ordering, newest ordering and resolved precedence', async () => {
  const h = setup('Alerts'); h.overrides.listAlerts = async () => response([alertItem('new', {severity: 'low', created_at: '2026-02-02'}), alertItem('critical', {severity: 'critical', acknowledged: true, resolved: true})]);
  await h.view.render(h.container);
  let html = h.node('alerts-tbody').innerHTML;
  assert.ok(html.indexOf('Signal critical') < html.indexOf('Signal new'));
  assert.match(html, /state-resolved/); assert.doesNotMatch(html, /state-acknowledged/);
  h.node('alert-sort').value = 'newest'; h.view.applyFilters(); html = h.node('alerts-tbody').innerHTML;
  assert.ok(html.indexOf('Signal new') < html.indexOf('Signal critical'));
});

test('Alerts: summary counts active signals and unique identified hosts, excluding resolved/acknowledged', async () => {
  const h = setup('Alerts'); h.overrides.listAlerts = async () => response([
    alertItem('a', {severity: 'critical', agent_id: 'same'}), alertItem('b', {severity: 'high', agent_id: 'same'}),
    alertItem('c', {acknowledged: true}), alertItem('d', {resolved: true}), alertItem('e', {agent_id: null})]);
  await h.view.render(h.container);
  const html = h.node('alerts-summary').innerHTML;
  assert.match(html, /Active in snapshot<\/span><strong>3/);
  assert.match(html, /Critical \/ high<\/span><strong>2/);
  assert.match(html, /Affected hosts<\/span><strong>1/);
  assert.match(html, /In this snapshot<\/span><strong>5/);
});

test('Alerts: empty inbox and empty filter results offer different next steps', async () => {
  const h = setup('Alerts'); await h.view.render(h.container);
  assert.match(h.node('alerts-tbody').innerHTML, /does not confirm fleet health/);
  assert.match(h.node('alerts-tbody').innerHTML, /href="#servers"/);
  h.overrides.listAlerts = async () => response([alertItem('one')]); await h.view.reload();
  h.node('alert-search').value = 'absent'; h.view.applyFilters();
  assert.match(h.node('alerts-tbody').innerHTML, /No matching signals/);
  h.view.clearFilters(); assert.equal(h.node('alerts-count').textContent, '1 of 1 signals');
});

test('Alerts: one acknowledgement request at a time; failure preserves data and allows retry', async () => {
  const h = setup('Alerts'); h.overrides.listAlerts = async () => response([alertItem('one')]); await h.view.render(h.container);
  const request = deferred(); h.overrides.acknowledgeAlert = () => request.promise;
  const ack = h.view.acknowledge('one'); await h.view.acknowledge('one');
  assert.equal(h.calls.acknowledgeAlert.length, 1); assert.match(h.node('alerts-tbody').innerHTML, /disabled>Saving/);
  request.reject(new Error('Forbidden')); await ack;
  assert.match(h.node('alerts-action-status').textContent, /Forbidden/); assert.doesNotMatch(h.node('alerts-tbody').innerHTML, /disabled>Saving/);
  h.overrides.acknowledgeAlert = async () => response(null); h.overrides.listAlerts = async () => response([]);
  await h.view.acknowledge('one'); assert.equal(h.calls.acknowledgeAlert.length, 2);
  assert.match(h.node('alerts-action-status').textContent, /acknowledged/); assert.equal(h.node('alerts-count').textContent, '0 of 0 signals');
});

test('Alerts: acknowledgement after navigation cannot refresh the new view', async () => {
  const h = setup('Alerts'); h.overrides.listAlerts = async () => response([alertItem('one')]); await h.view.render(h.container);
  const request = deferred(); h.overrides.acknowledgeAlert = () => request.promise; const ack = h.view.acknowledge('one');
  h.container.innerHTML = '<div id="replacement"></div>'; request.resolve(response(null)); await ack;
  assert.equal(h.calls.listAlerts.length, 1);
});

test('Alerts: API text is escaped and never inserted into inline handlers', async () => {
  const h = setup('Alerts'), malicious = `<img src=x onerror="bad()">'`;
  h.overrides.listAlerts = async () => response([alertItem(malicious, {title: malicious, severity: malicious, message: malicious})]);
  await h.view.render(h.container); h.view.showDetail(malicious);
  assert.doesNotMatch(h.node('alerts-tbody').innerHTML, /<img|onclick=/); assert.match(h.node('alerts-tbody').innerHTML, /&lt;img/);
  assert.doesNotMatch(h.dialog().html, /<img|onclick=/); assert.match(h.dialog().html, /&lt;img/);
});

test('Compliance: no report and no checks never count as compliant', async () => {
  const h = setup('Compliance'); h.overrides.getCompliance = async () => response([
    hostItem('pass', {compliant: true}), hostItem('fail'), hostItem('no-report', {compliant: true, last_report_at: ''}),
    hostItem('no-checks', {compliant: true, policy_results: [], failed_policies: []}), hostItem('unknown', {compliant: undefined})]);
  await h.view.render(h.container); const html = h.node('compliance-summary').innerHTML;
  assert.match(html, /Compliant<\/span><strong>1/); assert.match(html, /Needs attention<\/span><strong>1/); assert.match(html, /Not assessed<\/span><strong>3/);
  assert.equal(h.view.resultState(hostItem('required', {policy_results: [], required_agents: ['AV'], compliant: true})), 'compliant');
  h.node('comp-status-filter').value = 'awaiting'; h.view.applyFilters(); assert.equal(h.node('compliance-count').textContent, '1 of 5 hosts');
  h.view.showDetail('no-report'); assert.match(h.dialog().html, /Receive an inventory report/); assert.doesNotMatch(h.dialog().html, />Passed<|data-add-exception/);
});

test('Compliance: normalized search combines with group and assessment, retains group on refresh', async () => {
  const h = setup('Compliance'); h.overrides.listGroups = async () => response([{id: 'g', name: 'Operations'}]);
  h.overrides.getCompliance = async () => response([hostItem('one', {hostname: 'NODE-01', group_id: 'g', group_name: 'Operations'}), hostItem('two'), hostItem('pass', {group_id: 'g', compliant: true})]);
  await h.view.render(h.container); h.node('comp-search').value = '  node-01 '; h.node('comp-group-filter').value = 'g'; h.node('comp-status-filter').value = 'failed';
  await h.view.reload(); assert.equal(h.node('comp-group-filter').value, 'g'); assert.equal(h.node('compliance-count').textContent, '1 of 3 hosts');
  h.view.clearFilters(); h.node('comp-group-filter').value = '__ungrouped__'; h.view.applyFilters(); assert.match(h.node('compliance-tbody').innerHTML, /host-two/); assert.equal(h.node('compliance-count').textContent, '1 of 3 hosts');
});

test('Compliance: API failure never shows empty policies as a successful response', async () => {
  const h = setup('Compliance'); h.overrides.listCompliancePolicies = async () => { throw new Error('Policies denied'); };
  await h.view.render(h.container);
  assert.match(h.node('compliance-policies-list').innerHTML, /Unavailable/); assert.match(h.node('compliance-exceptions-list').innerHTML, /Unavailable/);
  assert.equal(h.node('policy-create').disabled, true); assert.match(h.node('compliance-tbody').innerHTML, /Policies denied/);
});

test('Compliance: empty inventory and empty library explain setup without invented health', async () => {
  const h = setup('Compliance'); await h.view.render(h.container);
  assert.match(h.node('compliance-tbody').innerHTML, /href="#packages"/); assert.match(h.node('compliance-policies-list').innerHTML, /Add your first policy/);
  assert.doesNotMatch(h.node('compliance-summary').innerHTML, /100%/);
});

test('Compliance: policy form validation, exact API payload, duplicate protection and retry', async () => {
  const h = setup('Compliance'); await h.view.render(h.container); h.view.openPolicy(); const d = h.dialog();
  await h.view.createPolicy(d); assert.match(d.status.textContent, /required/); assert.equal(h.calls.createCompliancePolicy, undefined);
  d.fields.get('policy-name').value = '  Service running  '; d.fields.get('policy-subject').value = '  sshd  '; d.fields.get('policy-expected').value = 'running';
  const request = deferred(); h.overrides.createCompliancePolicy = () => request.promise;
  const save = h.view.createPolicy(d); await h.view.createPolicy(d);
  assert.equal(h.calls.createCompliancePolicy.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.createCompliancePolicy[0][0])), {name: 'Service running', subject: 'sshd', expected_value: 'running', group_id: '', policy_type: 'service_status', severity: 'medium', enabled: true});
  request.reject(new Error('Denied')); await save; assert.equal(d.isConnected, true); assert.equal(d.save.disabled, false); assert.match(d.status.textContent, /Denied/); assert.equal(d.fields.get('policy-name').value, '  Service running  ');
  h.overrides.createCompliancePolicy = async () => response(null); await h.view.createPolicy(d); assert.equal(d.isConnected, false); assert.equal(h.calls.getCompliance.length, 2);
});

test('Compliance: an old form response does not clear or reload a remounted workspace', async () => {
  const h = setup('Compliance'); await h.view.render(h.container); h.view.openPolicy(); const d = h.dialog();
  d.fields.get('policy-name').value = 'Old form'; d.fields.get('policy-subject').value = 'sshd'; const request = deferred(); h.overrides.createCompliancePolicy = () => request.promise;
  const save = h.view.createPolicy(d); await h.view.render(h.container); h.view.openPolicy(); const next = h.dialog(); next.fields.get('policy-name').value = 'New draft';
  request.resolve(response(null)); await save;
  assert.equal(next.isConnected, true); assert.equal(next.fields.get('policy-name').value, 'New draft'); assert.equal(h.calls.getCompliance.length, 2);
});

test('Compliance: exceptions require a failed evaluated policy, reason and future expiry; convert time to UTC', async () => {
  const h = setup('Compliance'); h.overrides.getCompliance = async () => response([hostItem('host')]); await h.view.render(h.container);
  h.view.addException('host', 'missing', 'Missing'); assert.equal(h.dialog(), undefined);
  h.view.addException('host', 'policy-1', 'Service policy'); const d = h.dialog();
  await h.view.saveException(d, 'host', 'policy-1'); assert.equal(h.calls.createComplianceException, undefined); assert.match(d.status.textContent, /reason/);
  d.fields.get('exception-reason').value = '  Maintenance  '; d.fields.get('exception-expiry').value = '2000-01-01T12:00';
  await h.view.saveException(d, 'host', 'policy-1'); assert.equal(h.calls.createComplianceException, undefined); assert.match(d.status.textContent, /future/);
  d.fields.get('exception-expiry').value = '2099-01-01T12:30'; await h.view.saveException(d, 'host', 'policy-1');
  const payload = h.calls.createComplianceException[0][0]; assert.equal(payload.reason, 'Maintenance'); assert.equal(payload.agent_id, 'host'); assert.equal(payload.policy_id, 'policy-1'); assert.equal(payload.expires_at, new Date('2099-01-01T12:30').toISOString());
});

test('Compliance: deletion is single flight and late completion does not refresh another view', async () => {
  const h = setup('Compliance'); h.overrides.listCompliancePolicies = async () => response([{id: 'p', name: 'Test policy'}]); await h.view.render(h.container);
  const request = deferred(); h.overrides.deleteCompliancePolicy = () => request.promise;
  const remove = h.view.deletePolicy('p'); await h.view.deletePolicy('p'); assert.equal(h.calls.deleteCompliancePolicy.length, 1);
  h.container.innerHTML = '<div id="replacement"></div>'; request.resolve(response(null)); await remove; assert.equal(h.calls.getCompliance.length, 1);
});

test('Compliance: policy/host text and group attributes are escaped, actions use indices', async () => {
  const h = setup('Compliance'), malicious = `<img onerror="bad()">'`;
  h.overrides.getCompliance = async () => response([hostItem('host', {hostname: malicious})]);
  h.overrides.listGroups = async () => response([{id: malicious, name: malicious}]);
  h.overrides.listCompliancePolicies = async () => response([{id: malicious, name: malicious, subject: malicious, severity: malicious}]);
  await h.view.render(h.container); h.view.showDetail('host');
  assert.doesNotMatch(h.node('compliance-tbody').innerHTML, /<img|onclick=/);
  assert.doesNotMatch(h.node('compliance-policies-list').innerHTML, /<img|onclick=/);
  assert.match(h.node('comp-group-filter').innerHTML, /&quot;/); assert.doesNotMatch(h.dialog().html, /<img/);
});

test('Compliance: policy hints follow the selected type and ignored fields are not submitted', async () => {
  const h = setup('Compliance'); await h.view.render(h.container); h.view.openPolicy(); const d = h.dialog();
  assert.match(d.fields.get('policy-expected-help').textContent, /blank uses running/);
  d.fields.get('policy-type').value = 'package_installed'; d.fields.get('policy-type').listeners.change();
  assert.equal(d.fields.get('policy-expected').disabled, true); assert.match(d.fields.get('policy-subject-help').textContent, /Exact package name/);
  d.fields.get('policy-name').value = 'Package rule'; d.fields.get('policy-subject').value = 'test-package'; d.fields.get('policy-expected').value = 'old value';
  await h.view.createPolicy(d); assert.equal(h.calls.createCompliancePolicy[0][0].expected_value, '');
});

test('Compliance: invalid numeric, boolean and remote-access values are rejected before sending', async () => {
  const h = setup('Compliance'); await h.view.render(h.container); h.view.openPolicy(); const d = h.dialog();
  d.fields.get('policy-name').value = 'Rule'; d.fields.get('policy-subject').value = 'All';
  for (const [type, expected, message] of [['patch_compliance', 'not-a-number', /whole number/], ['local_admin_count', '-1', /whole number/], ['certificate_expiry', '0.5', /whole number/], ['firewall_enabled', 'maybe', /true, false/], ['remote_access_disabled', 'true', /RDP, WinRM or SSH/]]) {
    d.fields.get('policy-type').value = type; d.fields.get('policy-expected').value = expected;
    await h.view.createPolicy(d); assert.match(d.status.textContent, message); assert.equal(h.calls.createCompliancePolicy, undefined);
  }
});

test('Compliance: exceptions can omit expiry; failed save keeps the reason and permits retry', async () => {
  const h = setup('Compliance'); h.overrides.getCompliance = async () => response([hostItem('host')]); await h.view.render(h.container);
  h.view.addException('host', 'policy-1', 'Service policy'); const d = h.dialog(); d.fields.get('exception-reason').value = 'Accepted risk';
  const request = deferred(); h.overrides.createComplianceException = () => request.promise;
  const save = h.view.saveException(d, 'host', 'policy-1'); await h.view.saveException(d, 'host', 'policy-1');
  assert.equal(h.calls.createComplianceException.length, 1); assert.equal(h.calls.createComplianceException[0][0].expires_at, '');
  request.reject(new Error('Conflict')); await save;
  assert.equal(d.fields.get('exception-reason').value, 'Accepted risk'); assert.equal(d.isConnected, true); assert.equal(d.save.disabled, false); assert.match(d.status.textContent, /Conflict/);
});

test('Compliance: expired exceptions and disabled policies are labeled accurately', async () => {
  const h = setup('Compliance'); h.overrides.listCompliancePolicies = async () => response([{id:'p', name:'Policy', enabled:false}]);
  h.overrides.listComplianceExceptions = async () => response([{id:'old', policy_id:'p', agent_id:'h', reason:'Old exception', expires_at:'2000-01-01T00:00:00Z'}, {id:'new', policy_id:'p', agent_id:'h', reason:'Ongoing', expires_at:null}]);
  await h.view.render(h.container); assert.match(h.node('compliance-policies-list').innerHTML, />Disabled</);
  assert.match(h.node('compliance-exceptions-list').innerHTML, />Expired</); assert.match(h.node('compliance-exceptions-list').innerHTML, />No expiry</);
});

test('Alerts: an old acknowledgement does not unlock a pending action in the remounted view', async () => {
  const h = setup('Alerts'); h.overrides.listAlerts = async () => response([alertItem('one')]); await h.view.render(h.container);
  const first = deferred(), second = deferred(); let n = 0; h.overrides.acknowledgeAlert = () => (++n === 1 ? first : second).promise;
  const old = h.view.acknowledge('one'); await h.view.render(h.container); const current = h.view.acknowledge('one');
  first.resolve(response(null)); await old; await h.view.acknowledge('one');
  assert.equal(h.calls.acknowledgeAlert.length, 2); assert.match(h.node('alerts-tbody').innerHTML, /disabled>Saving/);
  second.reject(new Error('Retry')); await current; assert.doesNotMatch(h.node('alerts-tbody').innerHTML, /disabled>Saving/);
});
