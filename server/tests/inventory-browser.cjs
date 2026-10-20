'use strict';

// Optional real-browser smoke check, using only synthetic fixtures and local assets.
// Run: node server/tests/inventory-browser.cjs <path-to-chrome-or-edge>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const executable = process.argv[2];
if (!executable) throw new Error('Pass the local Chrome or Edge executable path.');
const root = path.resolve(__dirname, '../static');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-inventory-test-'));
const inventoryResponse = require('./inventory-fixture.cjs');
const fixture = `window.inventoryResponse = ${inventoryResponse.toString()}; window.testHosts = []; window.testInventoryViews = [];
window.testAlerts = []; window.testCompliance = []; window.testCommands = [];
window.API = {
  getInventory: async filters => window.inventoryResponse(window.testHosts, filters),
  listInventoryGroups: async () => ({data:[]}),
  listInventoryViews: async () => ({success:true,data:window.testInventoryViews}),
  saveInventoryView: async (id,data) => {const item = {...data,id:id || 'synthetic-view'}; window.testInventoryViews = window.testInventoryViews.filter(v => v.id !== item.id).concat(item); return {success:true,data:item};},
  deleteInventoryView: async id => {window.testInventoryViews = window.testInventoryViews.filter(v => v.id !== id); return {success:true,data:{deleted:true}};},
  init() {}, isLoggedIn: () => true, getUser: () => ({username:'UI test', role:'viewer'}),
  listAlerts: async active => ({data:window.testAlerts.filter(a => !active || (!a.resolved && !a.acknowledged))}), getServers: async () => ({data:window.testHosts}),
  listGroups: async () => ({data:[]}), getServer: async id => ({data:window.testHosts.find(s => s.id === id)}),
  getServerHistory: async () => ({data:[]}), listCommands: async () => ({data:window.testCommands}),
  listPackages: async () => ({data:[]}), listCommandTemplates: async () => ({data:[]}),
  listMaintenanceWindows: async () => ({data:[]}), listScheduledCommands: async () => ({data:[]}),
  getCommandLog: async id => ({data:window.testCommands.find(c => c.id === id)}),
  createCommand: async () => {throw new Error('Synthetic write failure');},
  getServerTimeline: async () => ({data:[]}), getServerBaseline: async () => ({data:null}),
  getCompliance: async () => ({data:window.testCompliance}),
  listCompliancePolicies: async () => ({data:[]}), listComplianceExceptions: async () => ({data:[]})
};`;
const server = http.createServer((req, res) => {
  if (req.url === '/static/js/api.js') {
    res.setHeader('Content-Type', 'application/javascript'); res.end(fixture); return;
  }
  const relative = req.url === '/' ? 'index.html' : req.url.replace(/^\/static\//, '');
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  res.setHeader('Content-Type', ({'.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.svg':'image/svg+xml'})[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
let browser, socket;
const errors = [];
async function run() {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = spawn(executable, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${scratch}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Browser did not expose its debug endpoint')), 15000);
    browser.once('error', err => { clearTimeout(timeout); reject(err); });
    browser.stderr.on('data', data => {
      output += data;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolve(new URL(match[1]).origin.replace('ws:', 'http:')); }
    });
  });
  const targets = await (await fetch(endpoint + '/json/list')).json();
  socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await once(socket, 'open');
  let next = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails);
    if (pending.has(msg.id)) {
      const {resolve, reject, timer} = pending.get(msg.id); pending.delete(msg.id); clearTimeout(timer);
      if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timed out: ' + method)); }, 10000);
    pending.set(id, {resolve, reject, timer}); socket.send(JSON.stringify({id, method, params}));
  });
  const evaluate = async expression => {
    const response = await call('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true});
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  await call('Runtime.enable');
  await call('Page.navigate', {url:`http://127.0.0.1:${server.address().port}/#servers`});
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await evaluate(`!!document.querySelector('.inventory-empty')`)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await evaluate(`!!document.querySelector('.inventory-empty')`), true);
  for (const width of [1440, 390]) {
    await call('Emulation.setDeviceMetricsOverride', {width,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate(`window.testHosts = []; Views.Servers.reload()`);
    const measure = () => evaluate(`({width:innerWidth, body:document.documentElement.scrollWidth, empty:document.querySelector('.inventory-empty')?.getBoundingClientRect().width})`);
    let size = await measure();
    assert.ok(size.body <= width, 'Empty inventory must not overflow: ' + JSON.stringify(size));
    assert.ok(size.empty < width, 'Empty guidance must fit screen: ' + JSON.stringify(size));
    await evaluate(`window.testHosts = [{ id:'fixture-host', hostname:'test-host', fqdn:'host.example.test', status:'offline', os:'Linux', ip_addresses:['2001:db8::1'] }]; Views.Servers.reload()`);
    size = await measure();
    assert.ok(size.body <= width, 'Inventory must not overflow: ' + JSON.stringify(size));
    if (width === 390) {
      assert.equal(await evaluate(`document.querySelector('.inventory-card .table-wrap').scrollWidth > document.querySelector('.inventory-card .table-wrap').clientWidth`), true);
      await evaluate(`document.getElementById('menu-toggle').click()`);
      assert.equal(await evaluate(`document.getElementById('menu-toggle').getAttribute('aria-expanded')`), 'true');
      await evaluate(`document.getElementById('sidebar-backdrop').click()`);
    }
    await evaluate(`window.testHosts = Array.from({length:61},(_,i) => ({id:'host-'+i,hostname:'node-'+String(i).padStart(3,'0'),status:'online',os:'Linux',ip_addresses:[]})); Views.Servers.reload()`);
    assert.equal(await evaluate(`document.querySelectorAll('#servers-tbody .host-link').length`), 25);
    await evaluate(`Views.Servers.changePage(1)`);
    assert.match(await evaluate(`document.getElementById('inventory-page-note').textContent`), /Page 2 of 3/);
    await evaluate(`document.getElementById('inventory-save').focus(); Views.Servers.editView(false)`);
    assert.equal(await evaluate(`document.activeElement.id`), 'inventory-view-name');
    assert.ok((await measure()).body <= width, 'Saved view dialog must fit');
    await evaluate(`document.getElementById('inventory-view-name').value = 'Synthetic workspace'; document.getElementById('inventory-view-form').requestSubmit()`);
    for (let i=0;i<30;i++) { if (await evaluate(`!document.querySelector('.security-dialog[open]')`)) break; await new Promise(resolve=>setTimeout(resolve,50)); }
    assert.equal(await evaluate(`document.getElementById('inventory-view').value`), 'synthetic-view');
    assert.equal(await evaluate(`document.activeElement.id`), 'inventory-save');
    await evaluate(`Views.Servers.deleteView()`);
    await call('Input.dispatchKeyEvent', {type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27});
    await call('Input.dispatchKeyEvent', {type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27});
    assert.equal(await evaluate(`window.testInventoryViews.length`), 1);
    await evaluate(`Views.Servers.deleteView(); document.getElementById('inventory-delete-confirm').click()`);
    for (let i=0;i<30;i++) { if (await evaluate(`!document.querySelector('.security-dialog[open]')`)) break; await new Promise(resolve=>setTimeout(resolve,50)); }
    assert.equal(await evaluate(`window.testInventoryViews.length`), 0);
    await evaluate(`window.testHosts = [{id:'fixture-host',hostname:'test-host',status:'offline',os:'Linux',ip_addresses:[]}]; Views.Servers.reload()`);
    await evaluate(`document.querySelector('.host-link').focus(); Views.Servers.showDetail('fixture-host')`);
    assert.equal(await evaluate(`document.querySelectorAll('[role=tab]').length`), 4);
    await evaluate(`Views.Servers.selectDetailTab('identity', true); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight', bubbles:true}))`);
    assert.equal(await evaluate(`document.activeElement.id`), 'host-tab-reports');
    for (const key of ['identity', 'reports', 'commands', 'timeline']) {
      await evaluate(`Views.Servers.selectDetailTab('${key}')`);
      assert.equal(await evaluate(`document.querySelectorAll('[role=tabpanel]:not([hidden])').length`), 1);
      size = await measure();
      assert.ok(size.body <= width, `Detail ${key} must not overflow: ` + JSON.stringify(size));
    }
    await evaluate(`document.getElementById('server-detail').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
    assert.equal(await evaluate(`document.activeElement.className`), 'host-link');
    assert.equal(await evaluate(`document.getElementById('server-detail').classList.contains('hidden')`), true);
    console.log(`PASS ${width}px: empty state, table overflow, host tabs, keyboard, focus${width === 390 ? ', mobile menu' : ''}`);
  }
  for (const width of [1440, 390]) {
    await call('Emulation.setDeviceMetricsOverride', {width,height:1000,deviceScaleFactor:1,mobile:false});
    const fits = async label => {
      const size = await evaluate(`({width:innerWidth, body:document.documentElement.scrollWidth, dialog:document.querySelector('dialog[open]') ? {width:document.querySelector('dialog[open]').clientWidth, scroll:document.querySelector('dialog[open]').scrollWidth} : null})`);
      assert.ok(size.body <= width, label + ' page overflow: ' + JSON.stringify(size));
      if (size.dialog) assert.ok(size.dialog.scroll <= size.dialog.width, label + ' dialog overflow: ' + JSON.stringify(size));
    };
    await evaluate(`App.navigate('alerts'); Views.Alerts.reload()`);
    assert.equal(await evaluate(`document.getElementById('alerts-tbody').textContent.includes('No alerts in this inbox')`), true);
    await fits('Empty alerts');
    await evaluate(`window.testAlerts = [{id:'test-alert', agent_id:'test-host', hostname:'synthetic-host', title:'Synthetic test signal', message:'A long message '.repeat(40), severity:'critical', type:'test', created_at:'2026-01-01T12:00:00Z'}]; Views.Alerts.reload()`);
    await fits('Alert table');
    if (width === 390) assert.equal(await evaluate(`document.querySelector('.security-results .table-wrap').scrollWidth > document.querySelector('.security-results .table-wrap').clientWidth`), true);
    await evaluate(`document.querySelector('[data-alert][data-action=detail]').focus(); document.activeElement.click()`);
    assert.equal(await evaluate(`!!document.querySelector('dialog[open]') && document.querySelector('dialog').contains(document.activeElement)`), true);
    await fits('Alert details');
    await call('Input.dispatchKeyEvent', {type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27});
    await call('Input.dispatchKeyEvent', {type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27});
    assert.equal(await evaluate(`!document.querySelector('dialog[open]') && document.activeElement.dataset.action === 'detail'`), true);
    await evaluate(`document.getElementById('alert-search').value = 'absent'; Views.Alerts.applyFilters()`);
    assert.equal(await evaluate(`document.getElementById('alerts-count').textContent`), '0 of 1 signals');
    await evaluate(`Views.Alerts.clearFilters()`);
    await evaluate(`window.testAlerts = []; window.testCompliance = []; App.navigate('compliance'); Views.Compliance.reload()`);
    await fits('Empty compliance');
    await evaluate(`Views.Compliance.openPolicy()`);
    assert.equal(await evaluate(`document.querySelectorAll('#policy-type option').length`), 10);
    await fits('Policy form');
    await evaluate(`document.querySelector('dialog').close(); window.testCompliance = [{agent_id:'test-host', hostname:'synthetic-host', compliant:false, last_report_at:'2026-01-01T12:00:00Z', required_agents:[], missing_agents:[], failed_policies:[{policy_id:'test-policy'}], policy_results:[{policy_id:'test-policy',name:'Synthetic test policy',severity:'high',compliant:false,message:'Test evidence'}]}]; Views.Compliance.reload()`);
    await fits('Host assessments');
    await evaluate(`document.querySelector('[data-host]').focus(); document.activeElement.click()`);
    await fits('Host evidence');
    await evaluate(`document.querySelector('[data-add-exception]').click()`);
    assert.equal(await evaluate(`!!document.getElementById('exception-reason')`), true);
    await fits('Exception form');
    await evaluate(`App.navigate('servers'); Views.Servers.reload()`);
    assert.equal(await evaluate(`document.querySelector('dialog[open]') === null`), true);
    console.log(`PASS ${width}px: security empty states, tables, filters, evidence, policy/exception dialogs, Escape and focus`);
  }
  for (const width of [1440, 390]) {
    await call('Emulation.setDeviceMetricsOverride', {width,height:1000,deviceScaleFactor:1,mobile:false});
    const fits = async label => {
      const size = await evaluate(`({body:document.documentElement.scrollWidth, dialog:document.querySelector('dialog[open]') ? {width:document.querySelector('dialog[open]').clientWidth, scroll:document.querySelector('dialog[open]').scrollWidth} : null})`);
      assert.ok(size.body <= width, label + ' page overflow: ' + JSON.stringify(size));
      if (size.dialog) assert.ok(size.dialog.scroll <= size.dialog.width, label + ' dialog overflow: ' + JSON.stringify(size));
    };
    await evaluate(`window.testCommands=[]; App.navigate('commands'); Views.Commands.reload()`);
    assert.equal(await evaluate(`document.getElementById('commands-tbody').textContent.includes('Your execution history starts here')`), true);
    await fits('Empty commands');
    await evaluate(`window.testCommands=[{id:'synthetic-command',agent_id:'fixture-host',type:'force_report',priority:'normal',status:'error',created_at:'2026-01-01T12:00:00Z',output:'Synthetic output '.repeat(100),error:'Synthetic failure'}]; Views.Commands.reload()`);
    await fits('Command history');
    if (width === 390) assert.equal(await evaluate(`document.querySelector('.commands-history .table-wrap').scrollWidth > document.querySelector('.commands-history .table-wrap').clientWidth`), true);
    await evaluate(`document.querySelector('[data-command-action=log]').focus(); Views.Commands.showLog('synthetic-command')`);
    assert.equal(await evaluate(`document.querySelector('dialog').contains(document.activeElement)`), true);
    await fits('Command result');
    await call('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await call('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    assert.equal(await evaluate(`document.activeElement.dataset.commandAction === 'log'`), true);
    await evaluate(`Views.Commands.showCreateFor('fixture-host')`);
    for (const type of ['system_update','install_package','install_agent','run_script','service_control','force_report']) {
      await evaluate(`document.getElementById('cmd-type').value='${type}'; Views.Commands.onCmdTypeChange()`);
      await fits('Composer ' + type);
      assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.commands-form input:not([type=hidden]),.commands-form select,.commands-form textarea')).filter(el => !el.labels?.length).map(el => el.id)`), []);
    }
    await evaluate(`document.querySelector('.commands-form').requestSubmit()`);
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await evaluate(`document.querySelector('[data-form-status]')?.textContent.includes('Synthetic write failure')`)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(await evaluate(`document.querySelector('[data-form-status]').textContent.includes('Synthetic write failure') && !!document.querySelector('dialog[open]')`), true);
    await fits('Composer write failure');
    assert.equal(await evaluate(`document.getElementById('cmd-type').disabled && document.getElementById('cmd-agent-id').disabled`), true);
    await evaluate(`window.receiptRetryKey=null; API.createCommand=async (command,key) => {
      window.receiptRetryKey=key;
      return {data:{request_key:key,replayed:true,commands_created:1,created_at:'2026-10-19T12:00:00Z',targets:[{agent_id:'fixture-host',hostname:'Synthetic receipt host',command_id:'synthetic-command',status:'pending'}]}};
    }; document.querySelector('.commands-form').requestSubmit()`);
    for (let attempt=0;attempt<20;attempt++) {
      if (await evaluate(`!!document.querySelector('.command-receipt')`)) break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.equal(await evaluate(`document.querySelector('.command-receipt').textContent.includes('RECOVERED RECEIPT') && !!window.receiptRetryKey`),true);
    assert.equal(await evaluate(`document.querySelector('dialog[open]').contains(document.activeElement)`),true);
    await fits('Command submission receipt');
    await evaluate(`document.querySelector('[data-receipt-target]').click()`);
    for (let attempt=0;attempt<20;attempt++) {
      if (await evaluate(`!!document.querySelector('[data-refresh-result]')`)) break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.equal(await evaluate(`document.querySelector('dialog[open]').textContent.includes('Synthetic failure')`),true);
    await evaluate(`document.querySelector('dialog[open]').close(); API.createCommand=async()=>{throw new Error('Synthetic write failure');}; Views.Commands.showCreateFor('fixture-host')`);
    await evaluate(`document.getElementById('cmd-execution-mode').value='scheduled'; Views.Commands.onExecutionModeChange(); Views.Commands.toggleTemplateSave()`);
    await fits('Scheduled command and template form');
    await evaluate(`document.querySelector('dialog').close(); Views.Commands.showMaintenanceWindowModal()`);
    await fits('Maintenance window form');
    await evaluate(`App.navigate('servers'); Views.Servers.reload()`);
    assert.equal(await evaluate(`document.querySelector('dialog[open]') === null`), true);
    console.log(`PASS ${width}px: commands empty/history, result, all composer types, validation failure, schedule/window forms, Escape and focus`);
  }
  await evaluate(`API.getUser = () => ({role:'admin',username:'Synthetic settings admin'});
    API.listSessions = async () => ({data:[]});
    API.listUsers = API.listTokens = API.getPermissionCatalog = API.listLDAPGroupMappings = async () => ({data:[]});
    API.getLDAPSettings = async () => ({data:{ldap_bind_password_configured:'true',ldap_server_url:'ldaps://directory.example.test:636'}});
    API.getSMTPSettings = async () => ({data:{smtp_password_configured:'false'}});
    window.testSettingsWrites = [];
    API.setLDAPSettings = API.setSMTPSettings = async data => {window.testSettingsWrites.push(data); return {data:{status:'saved'}};};
    API.listGroups = async () => ({data:[{id:'synthetic-group',name:'Synthetic security group with a long name for mobile layout',server_count:2}]});
    window.testRequirements = ['Custom sensor','Elastic Agent'];
    API.getRequiredAgents = async id => ({data:{group_id:id,agents:window.testRequirements}});
    API.setRequiredAgents = async (id,agents) => {window.testRequirements=agents;return {data:{group_id:id,agents}}};
    API.deleteGroup = async () => {throw new Error('Synthetic group in use')};`);
  for (const width of [1440, 390]) {
    await call('Emulation.setDeviceMetricsOverride', {width,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate(`Views.Settings.render(document.getElementById('content'))`);
    await evaluate(`Views.Settings.selectRequirementGroup(0)`);
    assert.equal(await evaluate(`document.getElementById('requirements-names').value`), 'Custom sensor\nElastic Agent');
    await evaluate(`document.getElementById('requirements-names').value=''; Views.Settings.requirementsChanged(); Views.Settings.saveReqAgents()`);
    assert.equal(await evaluate(`document.activeElement.id`), 'requirements-clear');
    assert.equal(await evaluate(`window.testRequirements.length`), 2);
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), 'Group requirements and clear confirmation fit viewport');
    await evaluate(`document.getElementById('requirements-clear').checked=true; Views.Settings.saveReqAgents()`);
    assert.equal(await evaluate(`window.testRequirements.length`), 0);
    await evaluate(`document.getElementById('requirements-names').value='Custom sensor\\nElastic Agent'; Views.Settings.requirementsChanged(); Views.Settings.saveReqAgents()`);
    await evaluate(`Views.Settings.requestGroupDelete(0)`);
    assert.equal(await evaluate(`document.activeElement.id`), 'group-delete-confirm');
    await evaluate(`Views.Settings.deleteGroup()`);
    assert.match(await evaluate(`document.getElementById('groups-feedback').textContent`), /Referenced groups cannot be deleted/);
    await call('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape'});
    await call('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape'});
    assert.equal(await evaluate(`document.getElementById('group-delete-panel').hidden`), true);
    assert.equal(await evaluate(`document.activeElement.id`), 'groups-refresh');
    for (const kind of ['ldap','smtp']) {
      assert.equal(await evaluate(`document.getElementById('${kind}-new-secret').value`), '');
      await evaluate(`document.getElementById('${kind}-secret-action').value='replace'; Views.Settings.changeSecretAction('${kind}'); document.getElementById('${kind}-new-secret').focus()`);
      assert.equal(await evaluate(`document.activeElement.id`), `${kind}-new-secret`);
      assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), 'Settings replacement form must fit viewport');
      await evaluate(`document.getElementById('${kind}-new-secret').value='  synthetic credential  '; Views.Settings.save${kind.toUpperCase()}()`);
      assert.equal(await evaluate(`document.getElementById('${kind}-new-secret').value`), '');
      await evaluate(`document.getElementById('${kind}-secret-action').value='clear'; Views.Settings.changeSecretAction('${kind}'); Views.Settings.save${kind.toUpperCase()}()`);
      assert.equal(await evaluate(`document.activeElement.id`), `${kind}-confirm-clear`);
      assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), 'Settings removal confirmation must fit viewport');
      await evaluate(`document.getElementById('${kind}-confirm-clear').checked=true; Views.Settings.save${kind.toUpperCase()}()`);
      assert.equal(await evaluate(`document.getElementById('${kind}-secret-status').textContent`), 'No credential configured');
    }
    console.log(`PASS ${width}px: Settings credentials, replacement/removal, focus and page overflow`);
  }
  for (const width of [1440, 390]) {
    await call('Emulation.setDeviceMetricsOverride', {width,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate(`API.getUser = () => ({role:'readonly',username:'Synthetic session user'});
      window.testSessions = [{id:'current',current:true,user_agent:'Synthetic browser '+ 'x'.repeat(250),created_at:'2026-01-01T12:00:00Z',refreshed_at:'2026-01-01T13:00:00Z',expires_at:'2026-01-08T12:00:00Z'}, {id:'other',user_agent:'<img src=x onerror=alert(1)>',created_at:'2026-01-01T12:00:00Z',expires_at:'2026-01-08T12:00:00Z'}];
      API.listSessions = async () => ({data:window.testSessions});
      API.revokeOtherSessions = async () => {window.testSessions=window.testSessions.filter(s=>s.current);return {data:{revoked:1}};};
      Views.Settings.render(document.getElementById('content'))`);
    assert.equal(await evaluate(`document.querySelectorAll('.account-session').length`),2);
    assert.equal(await evaluate(`document.querySelector('#sessions-list img') === null`),true);
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`),'Account sessions fit viewport');
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.account-password input')).filter(el=>!el.labels.length).map(el=>el.id)`),[]);
    await evaluate(`Views.Account.confirmRevoke()`);
    assert.equal(await evaluate(`document.activeElement.id`),'sessions-confirm-button');
    assert.equal(await evaluate(`document.getElementById('sessions-revoke').getAttribute('aria-expanded')`),'true');
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`),'Session confirmation fits viewport');
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))`);
    assert.equal(await evaluate(`document.activeElement.id`),'sessions-revoke');
    assert.equal(await evaluate(`document.getElementById('sessions-revoke').getAttribute('aria-expanded')`),'false');
    await evaluate(`Views.Account.confirmRevoke(); Views.Account.revoke()`);
    assert.equal(await evaluate(`document.querySelectorAll('.account-session').length`),1);
    assert.equal(await evaluate(`document.activeElement.id`),'sessions-revoke');
    await evaluate(`window.testSessions=[];Views.Account.load()`);
    assert.equal(await evaluate(`document.querySelector('.account-session-empty') !== null`),true);
    await evaluate(`API.listSessions=async()=>{throw new Error('Synthetic error')};Views.Account.load()`);
    assert.equal(await evaluate(`document.getElementById('sessions-revoke').disabled`),true);
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`),'Account error state fits viewport');
    console.log(`PASS ${width}px: personal sessions, XSS, confirmation, focus, revocation, empty/error and password labels`);
  }
  await evaluate(`API.getUser=()=>({role:'admin',username:'Synthetic package admin'})`);
  for (const width of [1440, 390]) {
    await call('Emulation.setDeviceMetricsOverride', {width,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate(`API.listPackages=async()=>({data:[]}); Views.Packages.render(document.getElementById('content'))`);
    assert.equal(await evaluate(`document.getElementById('packages-tbody').textContent.includes('Upload first package')`), true);
    await evaluate(`Views.Packages.showUpload(true)`);
    assert.equal(await evaluate(`document.activeElement.id`), 'pkg-name');
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), 'Package upload form fits viewport');
    await evaluate(`Views.Packages.showUpload(false)`);
    assert.equal(await evaluate(`document.activeElement.id`), 'packages-upload-toggle');
    await evaluate(`API.listPackages=async()=>({data:[{id:'synthetic-package',name:'sms-agent',version:'1.0-test',os_target:'linux',arch_target:'amd64',file_size:1024,sha256:'a'.repeat(64),description:'Synthetic package fixture',created_at:new Date().toISOString()}]}); Views.Packages.reload()`);
    await evaluate(`document.querySelector('.packages-hash').open=true`);
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), 'Package table and checksum fit viewport');
    if (width === 390) assert.equal(await evaluate(`document.querySelector('.packages-library .table-wrap').scrollWidth > document.querySelector('.packages-library .table-wrap').clientWidth`), true);
    assert.equal(await evaluate(`document.querySelector('.packages-library a[download]').getAttribute('href')`), '/api/packages/public/synthetic-package');
    console.log(`PASS ${width}px: Packages empty/library, upload form, checksum, public download, focus and overflow`);
  }
  assert.deepEqual(errors, [], 'No browser runtime errors');
}
run().catch(err => { console.error(err); process.exitCode = 1; }).finally(async () => {
  socket?.close();
  if (browser && browser.exitCode === null) { browser.kill(); await Promise.race([once(browser, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))]); }
  server.close();
  const resolved = path.resolve(scratch);
  // Only remove the unique temporary profile created by this test.
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('sms-inventory-test-')) {
    try { fs.rmSync(resolved, {recursive:true, force:true, maxRetries:3, retryDelay:100}); } catch { console.warn('Temporary browser profile remains at ' + resolved); }
  }
});
