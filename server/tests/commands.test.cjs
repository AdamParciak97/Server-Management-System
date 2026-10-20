'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '../static/js', file), 'utf8');
const response = data => ({data});
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const command = (id, extra = {}) => ({id, agent_id:'host-1', type:'force_report', status:'pending', priority:'normal', created_at:'2026-01-01T00:00:00Z', ...extra});
const receiptResponse = (cmd,key,count=1) => response({request_key:key,commands_created:count,created_at:'2026-10-19T00:00:00Z',targets:Array.from({length:count},(_,index)=>({agent_id:cmd.agent_id || `host-${index+1}`,hostname:`Synthetic ${index+1}`,command_id:`created-${index+1}`,status:cmd.type==='run_script' && !cmd.dry_run?'awaiting_approval':'pending'}))});

test('uploaded package commands preserve installer extension using public filename without a storage path', async()=>{
  const h=setup();
  h.overrides.listPackages=async()=>response([{id:'pkg-1',name:'synthetic',version:'1.0',filename:'release installer.deb',os_target:'linux',arch_target:'amd64'}]);
  await h.view.render(h.container);await h.view.showCreateFor('host-1');
  h.set('cmd-type','install_package');h.view.onCmdTypeChange();h.set('cmd-package-file','pkg-1');
  await h.submit();
  assert.equal(h.calls.createCommand?.length,1,h.dialog().status.textContent);
  assert.equal(h.calls.createCommand[0][0].payload.package_url,'https://example.test/api/packages/public/pkg-1/release%20installer.deb');
});

// A small DOM adapter for request ordering, form persistence and API contracts.
// Real layout, native focus containment and Escape need the browser smoke test.
function setup() {
  let nodes = new Map(), dialogs = [];
  function element(id = '') {
    let html = '';
    const node = {id, isConnected:true, value:'', checked:false, disabled:false, hidden:false, textContent:'', dataset:{}, listeners:{}, attrs:{},
      classList:{add(){}, toggle(){}}, setAttribute(k,v){this.attrs[k]=v;}, hasAttribute(k){return k in this.attrs;}, focus(){},
      addEventListener(k,fn){this.listeners[k]=fn;}, querySelector(){return null;}, querySelectorAll(){return [];},
      get innerHTML(){return html;}, set innerHTML(value){html=value; parse(value);}};
    return node;
  }
  function parse(html) {
    for (const match of html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
      const node = element(match[2]); node.value = match[0].match(/\bvalue="([^"]*)"/)?.[1] || '';
      if (match[1] === 'select') {
        const rest = html.slice(match.index + match[0].length).split('</select>')[0];
        const options = [...rest.matchAll(/<option value="([^"]*)"([^>]*)>/g)];
        node.value = (options.find(o => o[2].includes('selected')) || options[0])?.[1] || '';
      }
      nodes.set(node.id, node);
    }
  }
  const content = element('content'); nodes.set('content', content);
  const container = {set innerHTML(html) { nodes.forEach(n => {n.isConnected=false;}); dialogs.forEach(d => d.close()); nodes=new Map([['content',content]]); content.isConnected=true; parse(html); }};
  const overrides = {}, calls = {};
  const defaults = {getServers:[{id:'host-1',hostname:'node-one',os:'Linux',architecture:'amd64'},{id:'host-2',hostname:'node-two',os:'Windows',architecture:'amd64'}], listGroups:[{id:'group-1',name:'Production'}]};
  const apiNames = ['getServers','listGroups','listPackages','listCommandTemplates','listMaintenanceWindows','listCommands','listScheduledCommands','getCommandLog','createCommand','createScheduledCommand','createMaintenanceWindow','createCommandTemplate','getServerHistory','cancelCommand','approveCommand','deleteScheduledCommand','deleteMaintenanceWindow','deleteCommandTemplate'];
  const API = Object.fromEntries(apiNames.map(name => [name,(...args) => { (calls[name] ||= []).push(args); return overrides[name] ? overrides[name](...args) : Promise.resolve(name==='createCommand' ? receiptResponse(...args) : response(defaults[name] || [])); }]));
  let user = {id:'synthetic-operator',role:'admin'};
  API.getUser = () => user;
  const document = {getElementById:id => nodes.get(id)?.isConnected ? nodes.get(id) : null,
    querySelector:selector => selector.includes('data-submit') ? dialogs.at(-1)?.querySelector('[data-submit]') : null,
    querySelectorAll:() => [{value:'1'},{value:'2'}]};
  const context = vm.createContext({Views:{}, window:{location:{origin:'https://example.test'}}, crypto:require('node:crypto').webcrypto, document, API, confirm:()=>true,
    App:{escHtml:v => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'), priorityClass:()=> 'priority-normal', timeAgo:v=>v, formatDate:v=>v}, console});
  vm.runInContext(read('ui.js'),context); context.UI=context.window.UI;
  context.UI.dialog = (host,title,html) => {
    dialogs.filter(d => d.isConnected).forEach(d => d.close());
    const dialog=element(), body=element(), form=element(), submit=element(), status=element(), resultStatus=element();
    body.innerHTML=html;
    const dialogNodes = [...nodes.values()].filter(n => html.includes(`id="${n.id}"`));
    dialog.title=title; dialog.body=body; dialog.submit=submit; dialog.status=status; dialog.form=form;
    dialog.close=() => {dialog.isConnected=false; dialogNodes.forEach(n=>{n.isConnected=false;});};
    dialog.querySelector=selector => ({'.security-dialog-body':body,'form':form,'[data-submit]':submit,'[data-form-status]':status,'[data-result-feedback]':resultStatus}[selector] || null);
    body.querySelector=selector => selector==='[data-approve]' ? null : element();
    host.querySelector=() => dialogs.findLast(d=>d.isConnected) || null;
    dialogs.push(dialog); return dialog;
  };
  vm.runInContext(read('views/commands.js'),context);
  return {view:context.Views.Commands, container, calls, overrides, setUser(value){user=value;}, node:id=>document.getElementById(id), dialog:()=>dialogs.at(-1),
    submit:()=>dialogs.at(-1).form.listeners.submit({preventDefault(){}}), set(id,value){nodes.get(id).value=value;}};
}

test('uncertain submission freezes the original operation and retries the same UUID',async()=>{
  const h=setup();await h.view.render(h.container);await h.view.showCreateFor('host-1');
  h.set('cmd-type','force_report');
  h.overrides.createCommand=async()=>{throw new Error('Connection lost after commit');};
  await h.submit();
  const [original,key]=h.calls.createCommand[0];
  assert.match(key,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.match(h.dialog().status.textContent,/original unchanged operation/);
  // Even a synthetic change to disabled controls must never change a retry.
  h.set('cmd-agent-id','host-2');h.set('cmd-execution-mode','scheduled');
  h.overrides.createCommand=async(command,retryKey)=>response({request_key:retryKey,replayed:true,commands_created:1,created_at:'2026-10-19T00:00:00Z',targets:[{agent_id:command.agent_id,hostname:'node-one',command_id:'receipt-command',status:'pending'}]});
  await h.submit();
  assert.equal(h.calls.createCommand[1][1],key);
  assert.deepEqual(h.calls.createCommand[1][0],original);
  assert.equal(h.calls.createScheduledCommand,undefined);
  assert.equal(h.dialog().title,'Submission receipt');
  assert.match(h.dialog().body.innerHTML,/RECOVERED RECEIPT/);
  assert.match(h.dialog().body.innerHTML,/receipt-command/);
});

test('group receipt displays every target, approval and escaped metadata without claiming execution',async()=>{
  const h=setup();await h.view.render(h.container);await h.view.showCreateModal();
  h.set('cmd-target-type','group');h.set('cmd-group-id','group-1');
  h.overrides.createCommand=async(_cmd,key)=>response({request_key:key,commands_created:2,created_at:'2026-10-19',targets:[
    {agent_id:'host-1',hostname:'<img src=x onerror=attack()>',command_id:'command-a',status:'awaiting_approval'},
    {agent_id:'host-2',hostname:'node-two',command_id:'command-b',status:'pending'}]});
  await h.submit();const html=h.dialog().body.innerHTML;
  assert.equal(h.dialog().title,'Submission receipt');
  assert.match(html,/command-a/);assert.match(html,/command-b/);assert.match(html,/Awaiting Approval/);
  assert.match(html,/queueing, not execution/);assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);
});

test('empty group receipt gives a next action and never invents target rows',async()=>{
  const h=setup();await h.view.render(h.container);await h.view.showCreateModal();h.set('cmd-target-type','group');h.set('cmd-group-id','group-1');
  h.overrides.createCommand=async(_cmd,key)=>response({request_key:key,commands_created:0,created_at:'2026-10-19',targets:[]});
  await h.submit();assert.match(h.dialog().body.innerHTML,/No targets in this group/);assert.match(h.dialog().body.innerHTML,/new command/);assert.doesNotMatch(h.dialog().body.innerHTML,/<tbody>/);
});

test('mismatched receipt keeps the operation available for safe retry',async()=>{
  const h=setup();await h.view.render(h.container);await h.view.showCreateFor('host-1');const dialog=h.dialog();
  h.overrides.createCommand=async()=>response({request_key:'other-key',commands_created:0,targets:[]});
  await h.submit();assert.equal(dialog.isConnected,true);assert.match(dialog.status.textContent,/Invalid submission receipt/);
  const key=h.calls.createCommand[0][1];await h.submit();assert.equal(h.calls.createCommand[1][1],key);
});

test('new composer gets a new key and late receipts cannot replace it',async()=>{
  const h=setup(),pending=deferred();await h.view.render(h.container);await h.view.showCreateFor('host-1');
  h.overrides.createCommand=()=>pending.promise;const first=h.submit();const key=h.calls.createCommand[0][1];
  await h.view.showCreateFor('host-2');const newer=h.dialog();
  pending.resolve(response({request_key:key,commands_created:0,targets:[]}));await first;
  assert.equal(h.dialog(),newer);assert.equal(newer.isConnected,true);
  h.overrides.createCommand=async()=>{throw new Error('unconfirmed');};await h.submit();
  assert.notEqual(h.calls.createCommand[1][1],key);
});

test('retry cannot submit the previous account operation as a different user',async()=>{
  const h=setup();await h.view.render(h.container);await h.view.showCreateFor('host-1');
  h.overrides.createCommand=async()=>{throw new Error('unconfirmed');};await h.submit();
  h.setUser({id:'different-account',role:'admin'});await h.submit();
  assert.equal(h.calls.createCommand.length,1);assert.match(h.dialog().status.textContent,/Account changed/);
});

for (const failing of [false,true]) {
  test(`history ignores older ${failing ? 'failure' : 'success'}`,async()=>{
    const h=setup(), first=deferred(); let n=0;
    h.overrides.listCommands=()=>++n===1 ? first.promise : Promise.resolve(response([command('new')]));
    const initial=h.view.render(h.container); await h.view.reload();
    const html=h.node('commands-tbody').innerHTML;
    if(failing) first.reject(new Error('Old failure')); else first.resolve(response([command('old')]));
    await initial;
    assert.equal(h.node('commands-tbody').innerHTML,html); assert.match(html,/new/);
    assert.equal(h.node('commands-refresh').disabled,false);
  });
  test(`history ignores ${failing ? 'failure' : 'success'} after navigation`,async()=>{
    const h=setup(), pending=deferred(); h.overrides.listCommands=()=>pending.promise;
    const initial=h.view.render(h.container); h.container.innerHTML='<div id="commands-workspace"></div><div id="commands-tbody"></div>';
    h.node('commands-tbody').innerHTML='Replacement';
    if(failing) pending.reject(new Error('Gone')); else pending.resolve(response([command('old')]));
    await initial; assert.equal(h.node('commands-tbody').innerHTML,'Replacement');
  });
}
test('filters and normalized search combine, survive refresh, and sort attention first',async()=>{
  const h=setup(); h.overrides.listCommands=async()=>response([command('done',{status:'success',created_at:'2026-02-01'}),command('review',{requires_approval:true}),command('failed',{status:'error'})]);
  await h.view.render(h.container); h.set('cmd-search','  NODE-ONE  ');h.set('cmd-sort','attention');h.view.applyFilters();
  let html=h.node('commands-tbody').innerHTML;
  assert.ok(html.indexOf('review')<html.indexOf('failed'));assert.ok(html.indexOf('failed')<html.indexOf('done'));
  h.set('cmd-filter-status','awaiting_approval');await h.view.reload();
  assert.equal(h.node('commands-count').textContent,'1 of 3 commands'); assert.doesNotMatch(h.node('commands-tbody').innerHTML,/failed/);
  h.view.clearFilters();assert.equal(h.node('commands-count').textContent,'3 of 3 commands');
});
test('failed history clears summary and filtering cannot revive stale records; retry recovers',async()=>{
  const h=setup();h.overrides.listCommands=async()=>response([command('old')]);await h.view.render(h.container);
  h.overrides.listCommands=async()=>{throw new Error('Network unavailable');};await h.view.reload();h.view.clearFilters();
  assert.match(h.node('commands-tbody').innerHTML,/Network unavailable/);assert.match(h.node('commands-summary').innerHTML,/unavailable/);assert.equal(h.node('commands-count').textContent,'');
  h.overrides.listCommands=async()=>response([]);await h.view.reload();assert.match(h.node('commands-tbody').innerHTML,/Your execution history starts here/);
});
test('empty history and no matches have distinct next actions',async()=>{
  const h=setup();await h.view.render(h.container);assert.match(h.node('commands-tbody').innerHTML,/#packages/);
  h.overrides.listCommands=async()=>response([command('one')]);await h.view.reload();h.set('cmd-search','absent');h.view.applyFilters();
  assert.match(h.node('commands-tbody').innerHTML,/No matching commands/);assert.match(h.node('commands-tbody').innerHTML,/Reset filters/);
});
test('summary counts actual statuses, excluding cancelled from failures and unapproved scripts from queue',async()=>{
  const h=setup();h.overrides.listCommands=async()=>response([command('review',{requires_approval:true}),command('queue'),command('cancel',{status:'cancelled'}),command('error',{status:'error'}),command('success',{status:'success'})]);await h.view.render(h.container);
  assert.equal((h.node('commands-summary').innerHTML.match(/<strong>1<\/strong>/g)||[]).length,4);
});
test('partial reference failure leaves history usable and prevents silently using empty resources',async()=>{
  const h=setup();h.overrides.listPackages=async()=>{throw new Error('Forbidden');};h.overrides.listCommands=async()=>response([command('known')]);
  await h.view.render(h.container);assert.match(h.node('commands-tbody').innerHTML,/node-one/);assert.match(h.node('commands-feedback').textContent,/packages/);
  await h.view.showCreateModal();assert.equal(h.dialog().title,'Resources unavailable');assert.equal(h.calls.createCommand,undefined);
});
test('schedules preserve load errors when references finish later',async()=>{
  const h=setup(), refs=deferred();h.overrides.getServers=()=>refs.promise;h.overrides.listScheduledCommands=async()=>{throw new Error('Schedule denied');};
  const render=h.view.render(h.container);await Promise.resolve();refs.resolve(response([]));await render;
  assert.match(h.node('scheduled-tbody').innerHTML,/Schedule denied/);
});
test('out-of-order reference data cannot replace current target names',async()=>{
  const h=setup(), old=deferred();let n=0;h.overrides.getServers=()=>++n===1?old.promise:Promise.resolve(response([{id:'host-1',hostname:'current-host'}]));h.overrides.listCommands=async()=>response([command('one')]);
  const initial=h.view.render(h.container);await h.view.reload();old.resolve(response([{id:'host-1',hostname:'old-host'}]));await initial;
  assert.match(h.node('commands-tbody').innerHTML,/current-host/);assert.doesNotMatch(h.node('commands-tbody').innerHTML,/old-host/);
});
test('history escapes API values and identifiers without inline handler interpolation',async()=>{
  const h=setup();h.overrides.listCommands=async()=>response([command("x'\"><img src=x>",{output:'<script>bad()</script>'})]);await h.view.render(h.container);
  const html=h.node('commands-tbody').innerHTML;assert.doesNotMatch(html,/<img|<script|showLog\('/);assert.match(html,/&lt;script&gt;/);assert.match(html,/&#39;&quot;&gt;/);
});
test('remount shows loading instead of cached history',async()=>{
  const h=setup();h.overrides.listCommands=async()=>response([command('old')]);await h.view.render(h.container);
  const pending=deferred();h.overrides.listCommands=()=>pending.promise;const render=h.view.render(h.container);h.view.applyFilters();
  assert.doesNotMatch(h.node('commands-tbody').innerHTML,/old/);pending.resolve(response([]));await render;
});
test('composer validates target and timeout, keeps form on API error and retries exact payload',async()=>{
  const h=setup();await h.view.render(h.container);await h.view.showCreateModal();const dialog=h.dialog();
  await h.submit();assert.match(dialog.status.textContent,/Choose a server/);assert.equal(dialog.isConnected,true);assert.equal(h.calls.createCommand,undefined);
  h.set('cmd-agent-id','host-1');h.set('cmd-timeout','12.5');await h.submit();assert.match(dialog.status.textContent,/whole number/);
  h.set('cmd-timeout','60');h.set('cmd-type','force_report');h.overrides.createCommand=async()=>{throw new Error('Write denied');};await h.submit();
  assert.equal(dialog.isConnected,true);assert.match(dialog.status.textContent,/Write denied/);assert.equal(h.node('cmd-timeout').value,'60');
  h.overrides.createCommand=async(cmd,key)=>receiptResponse(cmd,key);await h.submit();assert.equal(dialog.isConnected,false);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.createCommand.at(-1)[0])),{agent_id:'host-1',group_id:null,type:'force_report',priority:'normal',timeout_seconds:60,dry_run:false,payload:{}});
  assert.match(h.node('commands-feedback').textContent,/queued/);
});
test('double submit sends one command and a late success cannot close a newer form',async()=>{
  const h=setup(), pending=deferred();await h.view.render(h.container);await h.view.showCreateFor('host-1');h.overrides.createCommand=()=>pending.promise;
  const first=h.submit();await h.submit();assert.equal(h.calls.createCommand.length,1);assert.equal(h.dialog().submit.disabled,true);
  await h.view.showCreateFor('host-2');const newer=h.dialog();pending.resolve(response({id:'created'}));await first;
  assert.equal(newer.isConnected,true);assert.equal(h.node('cmd-agent-id').value,'host-2');
});
test('schedule form validates required fields and preserves target, cron and maintenance window',async()=>{
  const h=setup();h.overrides.listMaintenanceWindows=async()=>response([{id:'mw-1',group_id:'group-1',name:'Window',days_of_week:[1],start_time:'01:00',end_time:'04:00'}]);await h.view.render(h.container);await h.view.showCreateModal('','',true);
  h.set('cmd-target-type','group');h.set('cmd-group-id','group-1');await h.submit();assert.match(h.dialog().status.textContent,/Schedule name/);
  h.set('schedule-name','Nightly');h.set('schedule-cron','0 1 * * *');h.set('schedule-maintenance-window-id','mw-1');await h.submit();
  const sent=h.calls.createScheduledCommand[0][0];assert.equal(sent.group_id,'group-1');assert.equal(sent.agent_id,null);assert.equal(sent.cron_expr,'0 1 * * *');assert.equal(sent.maintenance_window_id,'mw-1');assert.equal(h.calls.createCommand,undefined);
});
test('script template preserves script, dry run and timeout without sending a command',async()=>{
  const h=setup();h.overrides.listCommandTemplates=async()=>response([{id:'template',name:'Diagnostic',type:'run_script',priority:'high',timeout_seconds:90,dry_run:true,payload:{script_type:'bash',script_content:'echo synthetic'}}]);
  await h.view.render(h.container);await h.view.showCreateFromTemplate('template');assert.equal(h.node('script-content').value,'echo synthetic');assert.equal(h.node('cmd-dry-run').checked,true);assert.equal(h.node('cmd-timeout').value,90);
  h.set('cmd-template-name','Copy');h.set('cmd-template-description','Reusable');await h.view.saveCurrentAsTemplate();assert.equal(h.calls.createCommand,undefined);assert.equal(h.calls.createCommandTemplate[0][0].payload.script_content,'echo synthetic');assert.equal(h.dialog().isConnected,true);
});
test('service responses follow the selected agent and failures allow retry',async()=>{
  const h=setup(), first=deferred();await h.view.render(h.container);await h.view.showCreateFor('host-1');h.set('cmd-type','service_control');
  h.overrides.getServerHistory=id=>id==='host-1'?first.promise:Promise.resolve(response([{services:[{name:'new-service',status:'running'}]}]));h.view.onCmdTypeChange();
  h.set('cmd-agent-id','host-2');await h.view.onAgentSelectionChange();const html=h.node('svc-select').innerHTML;first.resolve(response([{services:[{name:'old-service'}]}]));await Promise.resolve();await Promise.resolve();
  assert.equal(h.node('svc-select').innerHTML,html);assert.match(html,/new-service/);assert.doesNotMatch(html,/old-service/);
});
test('service failure is distinct from an empty report and is not cached',async()=>{
  const h=setup();await h.view.render(h.container);await h.view.showCreateFor('host-1');h.set('cmd-type','service_control');h.overrides.getServerHistory=async()=>{throw new Error('No report');};h.view.onCmdTypeChange();await h.view.onAgentSelectionChange();
  assert.match(h.node('svc-select').innerHTML,/unavailable/);h.overrides.getServerHistory=async()=>response([]);await h.view.onAgentSelectionChange();assert.match(h.node('svc-select').innerHTML,/No services in latest report/);
});
test('result request cannot overwrite or reopen a later result',async()=>{
  const h=setup(), old=deferred();await h.view.render(h.container);h.overrides.getCommandLog=id=>id==='old'?old.promise:Promise.resolve(response(command('new',{output:'new output',duration_ms:0,exit_code:0})));
  const first=h.view.showLog('old');await h.view.showLog('new');const dialog=h.dialog();old.resolve(response(command('old',{output:'old output'})));await first;
  assert.match(dialog.body.innerHTML,/new output/);assert.doesNotMatch(dialog.body.innerHTML,/old output/);assert.match(dialog.body.innerHTML,/0 ms/);
});
test('result errors provide retry instead of closing the dialog',async()=>{
  const h=setup();await h.view.render(h.container);h.overrides.getCommandLog=async()=>{throw new Error('Unavailable');};await h.view.showLog('one');assert.equal(h.dialog().isConnected,true);assert.match(h.dialog().body.innerHTML,/Retry result/);
});
test('cancel is deduplicated and late action cannot refresh a replacement view',async()=>{
  const h=setup(), pending=deferred();await h.view.render(h.container);h.overrides.cancelCommand=()=>pending.promise;
  const first=h.view.cancel('one');await h.view.cancel('one');assert.equal(h.calls.cancelCommand.length,1);
  h.container.innerHTML='<div id="commands-workspace"></div><div id="commands-feedback"></div>';const count=h.calls.listCommands.length;pending.resolve(response(null));await first;
  assert.equal(h.calls.listCommands.length,count);assert.equal(h.node('commands-feedback').textContent,'');
});
test('maintenance window validates target and stays open on write failure',async()=>{
  const h=setup();await h.view.render(h.container);await h.view.showMaintenanceWindowModal();h.set('mw-name','Weekday');await h.submit();assert.match(h.dialog().status.textContent,/Select a target/);
  h.set('mw-group-id','group-1');h.overrides.createMaintenanceWindow=async()=>{throw new Error('Write failed');};await h.submit();assert.equal(h.dialog().isConnected,true);assert.match(h.dialog().status.textContent,/Write failed/);
  assert.equal(h.calls.createMaintenanceWindow[0][0].timezone,'Europe/Warsaw');
});
test('group completion uses the API count, including zero commands created',async()=>{
  for (const count of [0,3]) {
    const h=setup();await h.view.render(h.container);await h.view.showCreateModal();h.set('cmd-target-type','group');h.set('cmd-group-id','group-1');
    h.overrides.createCommand=async(cmd,key)=>receiptResponse(cmd,key,count);await h.submit();
    assert.match(h.node('commands-feedback').textContent,count===0?/No commands created/:/3 commands created/);
  }
});
test('script dry run is queued without claiming approval is required',async()=>{
  const h=setup();await h.view.render(h.container);await h.view.showCreateFor('host-1');h.set('cmd-type','run_script');h.view.onCmdTypeChange();h.set('script-content','echo test');h.node('cmd-dry-run').checked=true;
  await h.submit();assert.doesNotMatch(h.node('commands-feedback').textContent,/approval/);assert.equal(h.calls.createCommand[0][0].dry_run,true);
});
test('delayed inventory composer cannot open after its host details are replaced',async()=>{
  const h=setup(), pending=deferred();h.container.innerHTML='<div id="server-detail"></div>';const detail=h.node('server-detail');detail.firstElementChild={};h.overrides.getServers=()=>pending.promise;
  const open=h.view.showCreateFor('host-1');detail.firstElementChild={};pending.resolve(response([{id:'host-1',hostname:'old'}]));await open;assert.equal(h.dialog(),undefined);
});
test('late schedule failure cannot overwrite newer schedules',async()=>{
  const h=setup(), old=deferred();let n=0;h.overrides.listScheduledCommands=()=>++n===1?old.promise:Promise.resolve(response([{id:'new',name:'New schedule',enabled:true,cron_expr:'0 1 * * *',type:'force_report'}]));
  const initial=h.view.render(h.container);await h.view.reload();old.reject(new Error('Stale schedule error'));await initial;
  assert.match(h.node('scheduled-tbody').innerHTML,/New schedule/);assert.doesNotMatch(h.node('scheduled-tbody').innerHTML,/Stale schedule error/);
});
test('template save is deduplicated, preserves configuration on failure and can retry',async()=>{
  const h=setup(), pending=deferred();await h.view.render(h.container);await h.view.showCreateFor('host-1');h.set('cmd-template-name','Reusable');h.overrides.createCommandTemplate=()=>pending.promise;
  const first=h.view.saveCurrentAsTemplate();await h.view.saveCurrentAsTemplate();assert.equal(h.calls.createCommandTemplate.length,1);pending.reject(new Error('Template denied'));await first;
  assert.equal(h.dialog().isConnected,true);assert.equal(h.node('cmd-template-name').value,'Reusable');assert.equal(h.node('cmd-template-save-button').disabled,false);assert.match(h.node('cmd-template-feedback').textContent,/Template denied/);
  h.overrides.createCommandTemplate=async()=>response({id:'saved'});await h.view.saveCurrentAsTemplate();assert.match(h.node('cmd-template-feedback').textContent,/Template saved/);
});

test('operation review follows target, effects and dry run without creating work', async () => {
  const h = setup(); await h.view.render(h.container); await h.view.showCreateFor('host-1');
  assert.match(h.node('cmd-review').innerHTML, /node-one/);
  assert.match(h.node('cmd-review').innerHTML, /Services may restart/);
  h.set('cmd-target-type', 'group'); h.set('cmd-group-id', 'group-1');
  h.set('cmd-type', 'run_script'); h.view.onCmdTypeChange();
  h.set('script-content', 'echo synthetic'); h.dialog().form.listeners.change();
  let html = h.node('cmd-review').innerHTML;
  assert.match(html, /Production/); assert.match(html, /Group operation/);
  assert.match(html, /agent process privileges/); assert.match(html, /wait for approval/);
  assert.match(html, /echo synthetic/); assert.match(html, /membership may change/);
  h.node('cmd-dry-run').checked = true; h.dialog().form.listeners.input();
  html = h.node('cmd-review').innerHTML;
  assert.match(html, /Dry run/); assert.doesNotMatch(html, /will wait for approval/);
  assert.equal(h.calls.createCommand, undefined); assert.equal(h.calls.createScheduledCommand, undefined);
});

test('scheduled script review shows cron and approval for every execution', async () => {
  const h = setup(); await h.view.render(h.container); await h.view.showCreateModal('', '', true);
  h.set('cmd-type', 'run_script'); h.view.onCmdTypeChange();
  h.set('script-content', 'echo synthetic'); h.set('schedule-cron', '0 1 * * *');
  h.dialog().form.listeners.change();
  assert.match(h.node('cmd-review').innerHTML, /Each scheduled script requires approval/);
  assert.match(h.node('cmd-review').innerHTML, /0 1 \* \* \*/);
  assert.equal(h.calls.createScheduledCommand, undefined);
});

test('operation review escapes target and script and reflects templates loaded after opening', async () => {
  const h = setup();
  h.overrides.getServers = async () => response([{id:'host-1', hostname:'<img src=x onerror=bad()>'}]);
  h.overrides.listCommandTemplates = async () => response([{id:'script', type:'run_script', name:'Synthetic', timeout_seconds:90, payload:{script_content:'<script>bad()</script>', script_type:'bash'}}]);
  await h.view.render(h.container); await h.view.showCreateFor('host-1');
  h.set('cmd-template-id', 'script'); h.view.applySelectedTemplate();
  const html = h.node('cmd-review').innerHTML;
  assert.doesNotMatch(html, /<img|<script>/); assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/); assert.match(html, /90 seconds/);
  assert.match(html, /wait for approval/); assert.equal(h.calls.createCommand, undefined);
});

test('review explains incomplete configuration and updates after correcting it', async () => {
  const h = setup(); await h.view.render(h.container); await h.view.showCreateModal();
  assert.match(h.node('cmd-review').innerHTML, /Choose a target/);
  h.set('cmd-timeout', '1'); h.dialog().form.listeners.input();
  assert.match(h.node('cmd-review').innerHTML, /at least 30 seconds/);
  h.set('cmd-timeout', '60'); h.set('cmd-type', 'force_report'); h.dialog().form.listeners.input();
  assert.doesNotMatch(h.node('cmd-review').innerHTML, /at least 30 seconds/);
  assert.match(h.node('cmd-review').innerHTML, /fresh inventory report/);
});

test('reported service names cannot inject attributes into the command composer', async () => {
  const h = setup();
  h.overrides.getServerHistory = async () => response([{services:[{name:'svc" onmouseover="bad()', status:'running'}]}]);
  await h.view.render(h.container); await h.view.showCreateFor('host-1');
  h.set('cmd-type', 'service_control'); h.view.onCmdTypeChange(); await h.view.onAgentSelectionChange();
  const html = h.node('svc-select').innerHTML;
  assert.match(html, /value="svc&quot; onmouseover=&quot;bad\(\)"/);
  assert.doesNotMatch(html, /value="svc" onmouseover=/);
});
