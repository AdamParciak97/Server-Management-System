'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };

function setup(role = 'readonly') {
  let nodes = new Map();
  const calls = {}, overrides = {};
  const API = Object.fromEntries(['listSessions','revokeOtherSessions','changePassword'].map(name => [name, (...args) => {
    (calls[name] ||= []).push(args);
    return overrides[name] ? overrides[name](...args) : Promise.resolve({data: name === 'listSessions' ? [] : {revoked:0}});
  }]));
  const context = vm.createContext({Views:{},API,TextEncoder,document:{getElementById:id=>nodes.get(id)||null},
    App:{escHtml:value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../static/js/views/account.js'),'utf8'),context);
  const view = context.Views.Account;
  function mount() {
    const html = view.markup({role,username:'Synthetic user'}); nodes = new Map();
    for (const match of html.matchAll(/<\w+\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
      const attrs = match[0];
      nodes.set(match[1], {value:'',textContent:'',innerHTML:'',disabled:/\sdisabled\b/.test(attrs),hidden:/\shidden\b/.test(attrs),attributes:{},
        setAttribute(k,v){this.attributes[k]=v;},focus(){this.focused=true;}});
    }
    return html;
  }
  const html = mount();
  return {view,html,mount,calls,overrides,node:id=>nodes.get(id),unmount(){nodes=new Map();},set(id,value){nodes.get(id).value=value;}};
}

for (const role of ['admin','operator','readonly']) test(`personal sessions work for ${role} without settings permissions`,async()=>{
  const h=setup(role);await h.view.load();
  assert.equal(h.calls.listSessions.length,1);
  assert.match(h.node('sessions-list').innerHTML,/No active sessions returned/);
  assert.equal(h.node('sessions-revoke').disabled,false);
  assert.match(h.html,/for="current-password"/);
});

test('session display escapes untrusted browser strings and reports real dates only',async()=>{
  const h=setup();h.overrides.listSessions=async()=>({data:[{current:true,user_agent:'<img src=x onerror=alert(1)>',created_at:'invalid',expires_at:null},{current:false,user_agent:'Other browser'}]});
  await h.view.load();const html=h.node('sessions-list').innerHTML;
  assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);assert.match(html,/This session/);assert.match(html,/Other session/);
  assert.match(html,/Unavailable/);assert.match(h.node('sessions-summary').textContent,/2 active/);
});

test('failed list hides stale sessions and recovery is explicit',async()=>{
  const h=setup();h.overrides.listSessions=async()=>({data:[{current:true}]});await h.view.load();
  h.overrides.listSessions=async()=>{throw new Error('private server detail');};await h.view.load();
  assert.equal(h.node('sessions-list').innerHTML,'');assert.equal(h.node('sessions-revoke').disabled,true);
  assert.doesNotMatch(h.node('sessions-feedback').textContent,/private/);
  h.overrides.listSessions=async()=>({data:[]});await h.view.load();assert.equal(h.node('sessions-revoke').disabled,false);
});

test('malformed list is an error, never a fabricated empty success',async()=>{
  const h=setup();h.overrides.listSessions=async()=>({data:{}});await h.view.load();
  assert.match(h.node('sessions-summary').textContent,/unavailable/);assert.equal(h.node('sessions-revoke').disabled,true);
});

test('sign out requires confirmation, blocks duplicate writes, refreshes and keeps current session',async()=>{
  const h=setup();await h.view.load();await h.view.revoke();assert.equal(h.calls.revokeOtherSessions,undefined);
  h.view.confirmRevoke();assert.equal(h.node('sessions-confirm-button').focused,true);
  const pending=deferred();h.overrides.revokeOtherSessions=()=>pending.promise;
  const save=h.view.revoke();await h.view.revoke();await h.view.load();h.view.cancelRevoke();
  assert.equal(h.calls.revokeOtherSessions.length,1);assert.equal(h.calls.listSessions.length,1);assert.equal(h.node('sessions-cancel').disabled,true);
  pending.resolve({data:{revoked:3}});await save;
  assert.equal(h.calls.listSessions.length,2);assert.equal(h.node('sessions-confirm').hidden,true);
  assert.match(h.node('sessions-feedback').textContent,/3 other session/);assert.match(h.node('sessions-feedback').textContent,/stays signed in/);
});

test('revocation failure retains confirmation and allows retry without claiming success',async()=>{
  const h=setup();await h.view.load();h.view.confirmRevoke();h.overrides.revokeOtherSessions=async()=>{throw new Error('private');};
  await h.view.revoke();assert.equal(h.node('sessions-confirm').hidden,false);assert.equal(h.node('sessions-confirm-button').disabled,false);
  assert.match(h.node('sessions-feedback').textContent,/may still be active/);
  h.view.cancelRevoke();assert.equal(h.node('sessions-confirm').hidden,true);assert.equal(h.node('sessions-revoke').focused,true);
});

test('confirmation exposes its expanded state and cancel restores focus', async()=>{
  const h=setup();await h.view.load();
  assert.equal(h.node('sessions-revoke').attributes['aria-expanded'],'false');
  h.view.confirmRevoke();assert.equal(h.node('sessions-revoke').attributes['aria-expanded'],'true');
  h.view.cancelRevoke();assert.equal(h.node('sessions-revoke').attributes['aria-expanded'],'false');
  assert.equal(h.node('sessions-revoke').focused,true);
  h.view.confirmRevoke();await h.view.load();
  assert.equal(h.node('sessions-revoke').attributes['aria-expanded'],'false');
  assert.equal(h.node('sessions-confirm').hidden,true);
});

test('successful revocation followed by failed reload preserves the confirmed result and requests retry', async()=>{
  const h=setup();await h.view.load();h.view.confirmRevoke();
  h.overrides.revokeOtherSessions=async()=>({data:{revoked:4}});
  h.overrides.listSessions=async()=>{throw new Error('synthetic unavailable');};
  await h.view.revoke();
  assert.match(h.node('sessions-feedback').textContent,/4 other session\(s\) signed out/);
  assert.match(h.node('sessions-feedback').textContent,/Refresh to reload/);
  assert.equal(h.node('sessions-list').innerHTML,'');
  assert.equal(h.node('sessions-revoke').disabled,true);
  assert.equal(h.node('sessions-refresh').disabled,false);
  assert.equal(h.node('sessions-refresh').focused,true);
});

test('invalid revocation count cannot claim success or discard confirmation', async()=>{
  const h=setup();await h.view.load();h.view.confirmRevoke();
  h.overrides.revokeOtherSessions=async()=>({data:{revoked:-1}});await h.view.revoke();
  assert.match(h.node('sessions-feedback').textContent,/may still be active/);
  assert.equal(h.node('sessions-confirm').hidden,false);
  assert.equal(h.calls.listSessions.length,1);
});

for (const failure of [false,true]) test(`late list ${failure?'failure':'success'} cannot overwrite remounted account`,async()=>{
  const h=setup();const pending=deferred();h.overrides.listSessions=()=>pending.promise;const loading=h.view.load();
  h.mount();h.overrides.listSessions=async()=>({data:[{user_agent:'New view'}]});await h.view.load();
  failure ? pending.reject(new Error('late')) : pending.resolve({data:[{user_agent:'Old view'}]});await loading;
  assert.match(h.node('sessions-list').innerHTML,/New view/);assert.doesNotMatch(h.node('sessions-list').innerHTML,/Old view/);
});

test('late revocation cannot refresh or unlock a newer view',async()=>{
  const h=setup();await h.view.load();h.view.confirmRevoke();const pending=deferred();h.overrides.revokeOtherSessions=()=>pending.promise;
  const save=h.view.revoke();h.mount();pending.resolve({data:{revoked:9}});await save;
  assert.equal(h.calls.listSessions.length,1);assert.equal(h.node('sessions-feedback').textContent,'');assert.equal(h.node('sessions-revoke').disabled,true);
});

test('password validates matching fields and UTF-8 byte limit before sending',async()=>{
  const h=setup();h.set('current-password','current');h.set('new-account-password','short');h.set('repeat-account-password','different');
  await h.view.changePassword();assert.equal(h.calls.changePassword,undefined);
  h.set('new-account-password','ą'.repeat(37));h.set('repeat-account-password','ą'.repeat(37));await h.view.changePassword();
  assert.match(h.node('account-password-feedback').textContent,/8–72 bytes/);assert.equal(h.calls.changePassword,undefined);
});

test('password save suppresses duplicates, preserves exact spaces and clears fields on success',async()=>{
  const h=setup();h.set('current-password',' current ');h.set('new-account-password',' new password ');h.set('repeat-account-password',' new password ');
  const pending=deferred();h.overrides.changePassword=()=>pending.promise;const save=h.view.changePassword();await h.view.changePassword();
  assert.equal(h.calls.changePassword.length,1);assert.equal(h.calls.changePassword[0][0].new_password,' new password ');
  assert.equal(h.node('account-password-fields').disabled,true);pending.resolve({});await save;
  assert.equal(h.node('current-password').value,'');assert.equal(h.node('new-account-password').value,'');assert.match(h.node('account-password-feedback').textContent,/Sign in/);
});

test('password failure permits correction and leave clears password drafts',async()=>{
  const h=setup();h.set('current-password','current');h.set('new-account-password','new password');h.set('repeat-account-password','new password');
  h.overrides.changePassword=async()=>{throw new Error('private');};await h.view.changePassword();
  assert.equal(h.node('account-password-fields').disabled,false);assert.equal(h.node('new-account-password').value,'new password');
  assert.doesNotMatch(h.node('account-password-feedback').textContent,/private/);
  h.view.leave();assert.equal(h.node('current-password').value,'');assert.equal(h.node('new-account-password').value,'');
});

test('leaving during loading or password save ignores late completion',async()=>{
  const h=setup();const pending=deferred();h.overrides.listSessions=()=>pending.promise;const loading=h.view.load();
  h.view.leave();h.unmount();pending.resolve({data:[]});await loading;
  h.mount();h.set('current-password','current');h.set('new-account-password','new password');h.set('repeat-account-password','new password');
  const savePending=deferred();h.overrides.changePassword=()=>savePending.promise;const save=h.view.changePassword();
  h.mount();h.set('current-password','new draft');savePending.resolve({});await save;
  assert.equal(h.node('current-password').value,'new draft');
});
