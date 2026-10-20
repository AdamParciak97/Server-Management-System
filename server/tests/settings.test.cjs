'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };

// DOM adapter for form state and request ordering; this is not a layout test.
function setup(user = {role:'admin'}) {
  let nodes = new Map(), html = '';
  const calls = {}, overrides = {};
  const defaults = {getLDAPSettings:{ldap_bind_password_configured:'true'},getSMTPSettings:{smtp_password_configured:'false'}};
  const names = ['listGroups','getRequiredAgents','setRequiredAgents','createGroup','deleteGroup','listUsers','listTokens','createToken','revokeToken','getPermissionCatalog','listLDAPGroupMappings','getLDAPSettings','getSMTPSettings','setLDAPSettings','setSMTPSettings'];
  const API = Object.fromEntries(names.map(name => [name, (...args) => {
    (calls[name] ||= []).push(args);
    return overrides[name] ? overrides[name](...args) : Promise.resolve({data: defaults[name] || []});
  }]));
  API.getUser = () => user;
  const container = {
    set innerHTML(value) {
      html = value; nodes.forEach(n => {n.isConnected=false;}); nodes = new Map();
      for (const match of value.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const attrs = match[0];
        const node = {id:match[2], value:'', textContent:'', innerHTML:'', disabled:/\sdisabled\b/.test(attrs), hidden:/\shidden\b/.test(attrs), checked:false, required:false,
          isConnected:true, dataset:{}, attributes:{}, focus(){this.focused=true;}, setAttribute(k,v){this.attributes[k]=v;}};
        if (match[1] === 'select') node.value = value.slice(match.index+attrs.length).match(/<option value="([^"]*)"/)?.[1] || '';
        nodes.set(node.id,node);
      }
    }, get innerHTML(){ return html; }
  };
  const document = {getElementById:id=>nodes.get(id) || null};
  const context = vm.createContext({Views:{Account:{markup:()=>'',load:async()=>{}}},API,document,App:{escHtml:v=>String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../static/js/views/settings.js'),'utf8'), context);
  return {view:context.Views.Settings,container,calls,overrides,node:id=>document.getElementById(id),set:(id,value)=>{nodes.get(id).value=value;},save:kind=>context.Views.Settings[`save${kind.toUpperCase()}`]()};
}

test('token history hides legacy secrets and filters lifecycle states', async () => {
  const h=setup();
  h.overrides.listTokens=async()=>({data:[
    {id:'a',note:'available host',token:'secret-never-render',expires_at:'2099-01-01'},
    {id:'b',note:'expired host',expires_at:'2000-01-01'},
    {id:'c',note:'used host',used:true},
    {id:'d',note:'revoked host',revoked_at:'2026-01-01'}]});
  await h.view.render(h.container);
  assert.doesNotMatch(h.node('tokens-list').innerHTML,/secret-never-render/);
  assert.match(h.node('tokens-summary').textContent,/4 of 4 tokens · 1 available/);
  h.set('tokens-filter','revoked');h.view.renderTokens();
  assert.match(h.node('tokens-list').innerHTML,/revoked host/);
  assert.doesNotMatch(h.node('tokens-list').innerHTML,/available host|expired host|used host/);
});

test('creating a token sends expiry, shows the secret once and blocks duplicate submission', async () => {
  const h=setup();await h.view.render(h.container);const pending=deferred();
  h.overrides.createToken=()=>pending.promise;
  h.set('new-token-note','  test host  ');h.set('new-token-ttl','24');
  const started=Date.now();const save=h.view.createToken();await h.view.createToken();
  assert.equal(h.calls.createToken.length,1);assert.equal(h.node('tokens-fields').disabled,true);
  const payload=h.calls.createToken[0][0];assert.equal(payload.note,'test host');
  assert(Math.abs(new Date(payload.expires_at).getTime()-started-86400000)<2000);
  pending.resolve({data:{token:'synthetic-once'}});await save;
  assert.equal(h.node('token-secret').value,'synthetic-once');assert.equal(h.node('token-secret-panel').hidden,false);
  assert.equal(h.node('tokens-fields').disabled,false);
  h.view.hideToken();assert.equal(h.node('token-secret').value,'');assert.equal(h.node('token-secret-panel').hidden,true);
});

test('readonly token access cannot create or revoke', async () => {
  const h=setup({role:'readonly',permissions:['tokens.read']});
  h.overrides.listTokens=async()=>({data:[{id:'a',note:'test'}]});
  await h.view.render(h.container);await h.view.createToken();h.view.requestTokenRevoke(0);await h.view.revokeToken();
  assert.equal(h.calls.createToken,undefined);assert.equal(h.calls.revokeToken,undefined);
  assert.doesNotMatch(h.node('tokens-list').innerHTML,/requestTokenRevoke/);
});

test('revocation requires confirmation and targets the selected token', async () => {
  const h=setup();h.overrides.listTokens=async()=>({data:[{id:'selected-token',note:'test'}]});
  await h.view.render(h.container);h.view.requestTokenRevoke(0);
  assert.equal(h.calls.revokeToken,undefined);assert.equal(h.node('token-revoke-panel').hidden,false);
  h.view.cancelTokenRevoke();await h.view.revokeToken();assert.equal(h.calls.revokeToken,undefined);
  h.view.requestTokenRevoke(0);await h.view.revokeToken();
  assert.equal(h.calls.revokeToken[0][0],'selected-token');assert.equal(h.node('token-revoke-panel').hidden,true);
});

test('late token creation cannot expose its secret in a new Settings view', async () => {
  const h=setup();await h.view.render(h.container);const pending=deferred();h.overrides.createToken=()=>pending.promise;
  const save=h.view.createToken();await h.view.render(h.container);
  pending.resolve({data:{token:'stale-synthetic-secret'}});await save;
  assert.equal(h.node('token-secret').value,'');assert.equal(h.node('token-secret-panel').hidden,true);
});

test('late token history cannot overwrite a newer refresh', async () => {
  const h=setup();await h.view.render(h.container);const pending=deferred();h.overrides.listTokens=()=>pending.promise;
  const stale=h.view.loadTokens();h.overrides.listTokens=async()=>({data:[{id:'new',note:'new metadata'}]});
  await h.view.loadTokens();pending.resolve({data:[{id:'old',note:'old metadata'}]});await stale;
  assert.match(h.node('tokens-list').innerHTML,/new metadata/);assert.doesNotMatch(h.node('tokens-list').innerHTML,/old metadata/);
});

test('token errors do not leak server response secrets and permit retry', async () => {
  const h=setup();h.overrides.listTokens=async()=>{throw new Error('synthetic-private-error');};
  await h.view.render(h.container);assert.match(h.node('tokens-list').innerHTML,/could not be loaded/);
  assert.doesNotMatch(h.node('tokens-list').innerHTML,/synthetic-private-error/);
  h.overrides.listTokens=async()=>({data:[]});await h.view.loadTokens();assert.match(h.node('tokens-list').innerHTML,/No tokens match/);
  h.overrides.createToken=async()=>{throw new Error('synthetic-private-error');};await h.view.createToken();
  assert.match(h.node('tokens-feedback').textContent,/may already have been created/);
  assert.doesNotMatch(h.node('tokens-feedback').textContent,/synthetic-private-error/);
  assert.equal(h.node('tokens-fields').disabled,false);
});

for (const kind of ['ldap','smtp']) {
  const title = kind.toUpperCase(), secret = kind === 'ldap' ? 'ldap_bind_password' : 'smtp_password';
  const get = `get${title}Settings`, save = `set${title}Settings`;

  test(`${title}: credential presence is shown without loading a legacy secret into the form`, async () => {
    const h=setup();h.overrides[get]=async()=>({data:{[secret]:'synthetic-legacy-secret',[`${secret}_configured`]:'true'}});
    await h.view.render(h.container);
    assert.equal(h.node(`${kind}-new-secret`).value,'');
    assert.equal(h.node(`${kind}-new-secret`).disabled,true);
    assert.equal(h.node(`${kind}-secret-status`).textContent,'Credential configured');
    assert.doesNotMatch(h.container.innerHTML,/synthetic-legacy-secret/);
    await h.save(kind);
    const payload=h.calls[save][0][0];
    assert.equal(payload.secret_action,'keep');assert.equal(secret in payload,false);
    assert.match(h.node(`${kind}-feedback`).textContent,/preserved/);
  });

  test(`${title}: replacement is explicit, preserves spaces and clears password after success`, async () => {
    const h=setup();await h.view.render(h.container);
    h.set(`${kind}-secret-action`,'replace');h.view.changeSecretAction(kind);
    assert.equal(h.node(`${kind}-secret-replacement`).hidden,false);
    assert.equal(h.node(`${kind}-new-secret`).required,true);
    await h.save(kind);assert.equal(h.calls[save],undefined);assert.equal(h.node(`${kind}-new-secret`).focused,true);
    h.set(`${kind}-new-secret`,'  synthetic-new  ');await h.save(kind);
    assert.equal(h.calls[save][0][0][secret],'  synthetic-new  ');
    assert.equal(h.calls[save][0][0].secret_action,'replace');
    assert.equal(h.node(`${kind}-new-secret`).value,'');assert.equal(h.node(`${kind}-secret-action`).value,'keep');
    assert.equal(h.node(`${kind}-secret-status`).textContent,'Credential configured');
  });

  test(`${title}: removal requires confirmation, switching intent erases the draft`, async () => {
    const h=setup();await h.view.render(h.container);
    h.set(`${kind}-secret-action`,'replace');h.view.changeSecretAction(kind);h.set(`${kind}-new-secret`,'synthetic');
    h.set(`${kind}-secret-action`,'clear');h.view.changeSecretAction(kind);
    assert.equal(h.node(`${kind}-new-secret`).value,'');assert.equal(h.node(`${kind}-secret-confirmation`).hidden,false);
    await h.save(kind);assert.equal(h.calls[save],undefined);assert.equal(h.node(`${kind}-confirm-clear`).focused,true);
    h.node(`${kind}-confirm-clear`).checked=true;await h.save(kind);
    assert.equal(h.calls[save][0][0].secret_action,'clear');assert.equal(secret in h.calls[save][0][0],false);
    assert.equal(h.node(`${kind}-secret-status`).textContent,'No credential configured');assert.equal(h.node(`${kind}-confirm-clear`).checked,false);
  });

  test(`${title}: failed load locks editing, retry recovers independently of the other integration`, async () => {
    const h=setup();h.overrides[get]=async()=>{throw new Error('synthetic-secret-in-error');};await h.view.render(h.container);
    assert.equal(h.node(`${kind}-fields`).disabled,true);assert.equal(h.node(`${kind}-retry`).hidden,false);
    assert.doesNotMatch(h.node(`${kind}-feedback`).textContent,/synthetic-secret/);
    await h.save(kind);assert.equal(h.calls[save],undefined);
    assert.equal(h.node(`${kind==='ldap'?'smtp':'ldap'}-fields`).disabled,false);
    h.overrides[get]=async()=>({data:{}});await h.view.loadIntegration(kind);
    assert.equal(h.node(`${kind}-fields`).disabled,false);assert.equal(h.node(`${kind}-retry`).hidden,true);
    assert.equal(h.node(`${kind}-secret-status`).textContent,'No credential configured');
  });

  test(`${title}: save failures retain edits and intent, suppress duplicate saves and racing reloads`, async () => {
    const h=setup();await h.view.render(h.container);const pending=deferred();h.overrides[save]=()=>pending.promise;
    h.set(`${kind}-secret-action`,'replace');h.view.changeSecretAction(kind);h.set(`${kind}-new-secret`,'synthetic-retry');
    const first=h.save(kind);await h.save(kind);await h.view.loadIntegration(kind);
    assert.equal(h.calls[save].length,1);assert.equal(h.calls[get].length,1);assert.equal(h.node(`${kind}-fields`).disabled,true);
    pending.reject(new Error('synthetic-secret-in-error'));await first;
    assert.equal(h.node(`${kind}-new-secret`).value,'synthetic-retry');assert.equal(h.node(`${kind}-secret-action`).value,'replace');
    assert.equal(h.node(`${kind}-fields`).disabled,false);assert.equal(h.node(`${kind}-fields`).attributes['aria-busy'],'false');
    assert.match(h.node(`${kind}-feedback`).textContent,/could not be confirmed/);assert.doesNotMatch(h.node(`${kind}-feedback`).textContent,/synthetic-secret/);
    h.overrides[save]=async()=>({data:{status:'saved'}});await h.save(kind);assert.equal(h.calls[save].length,2);
  });

  for (const failure of [false,true]) {
    test(`${title}: late load ${failure?'failure':'success'} cannot overwrite a remounted form`, async () => {
      const h=setup(), pending=deferred();h.overrides[get]=()=>pending.promise;const first=h.view.render(h.container);
      h.overrides[get]=async()=>({data:{[`${secret}_configured`]:'false'}});await h.view.render(h.container);
      h.set(`${kind}-secret-action`,'replace');h.view.changeSecretAction(kind);h.set(`${kind}-new-secret`,'new-draft');
      if(failure)pending.reject(new Error('old failure'));else pending.resolve({data:{[`${secret}_configured`]:'true'}});
      await first;assert.equal(h.node(`${kind}-new-secret`).value,'new-draft');assert.equal(h.node(`${kind}-secret-status`).textContent,'No credential configured');
    });
    test(`${title}: late save ${failure?'failure':'success'} cannot clear or unlock a remounted form`, async () => {
      const h=setup();await h.view.render(h.container);const pending=deferred();h.overrides[save]=()=>pending.promise;
      const first=h.save(kind);await h.view.render(h.container);h.set(`${kind}-secret-action`,'replace');h.view.changeSecretAction(kind);h.set(`${kind}-new-secret`,'new-draft');
      if(failure)pending.reject(new Error('old failure'));else pending.resolve({data:{status:'saved'}});
      await first;assert.equal(h.node(`${kind}-new-secret`).value,'new-draft');assert.equal(h.node(`${kind}-feedback`).textContent,'');
    });
  }

  test(`${title}: readonly permissions keep the form disabled and prevent API writes`, async () => {
    const h=setup({role:'readonly',permissions:['settings.read']});await h.view.render(h.container);
    assert.equal(h.node(`${kind}-fields`).disabled,true);assert.equal(h.node(`${kind}-save`),null);
    await h.save(kind);assert.equal(h.calls[save],undefined);assert.match(h.node(`${kind}-feedback`).textContent,/Read-only/);
  });
}

test('no settings permission means no integration controls or configuration requests', async () => {
  const h=setup({role:'operator',permissions:[]});await h.view.render(h.container);
  assert.equal(h.node('ldap-fields'),null);assert.equal(h.node('smtp-fields'),null);
  assert.equal(h.calls.getLDAPSettings,undefined);assert.equal(h.calls.getSMTPSettings,undefined);
});

test('other settings failure does not discard the usable integration forms', async () => {
  const h=setup();h.overrides.listUsers=async()=>{throw new Error('synthetic');};await h.view.render(h.container);
  assert.match(h.node('settings-load-status').textContent,/could not be loaded/);
  assert.equal(h.node('ldap-fields').disabled,false);assert.equal(h.node('smtp-fields').disabled,false);
});

test('account names cannot become JavaScript in Settings action attributes', async () => {
  const h=setup();
  h.overrides.listUsers=async()=>({data:[{id:'synthetic-user',username:`');globalThis.syntheticAttack=1;//" onmouseover="bad()`,email:'synthetic@example.test',role:'readonly'}]});
  await h.view.render(h.container);
  const html=h.node('users-list').innerHTML;
  const handlers=[...html.matchAll(/onclick="([^"]*)"/g)].map(m=>m[1]);
  assert.deepEqual(handlers,["Views.Settings.userAction(0, 'permissions')","Views.Settings.userAction(0, 'scopes')","Views.Settings.userAction(0, 'delete')"]);
  assert.equal((html.match(/onmouseover=/g)||[]).length,1); // Name is text, never an attribute.
  assert.match(html,/<strong>[^<]*syntheticAttack[^<]*<\/strong>/);
});


const testGroups = [{id:'group-a',name:'Production <synthetic>',server_count:2}, {id:'group-b',name:'Test group',server_count:0}];
async function groupSetup(user) {
  const h = setup(user);
  h.overrides.listGroups = async () => ({data:testGroups});
  h.overrides.getRequiredAgents = async id => ({data:{group_id:id,agents:['Custom sensor','Elastic Agent']}});
  h.overrides.setRequiredAgents = async (id,agents) => ({data:{group_id:id,agents}});
  await h.view.render(h.container);
  return h;
}

test('group requirements load persisted and custom names before editing', async () => {
  const h = await groupSetup();
  assert.equal(h.node('requirements-fields').disabled,true);
  assert.match(h.node('groups-list').innerHTML,/Production &lt;synthetic&gt;/);
  await h.view.selectRequirementGroup(0);
  assert.equal(h.calls.getRequiredAgents[0][0],'group-a');
  assert.equal(h.node('requirements-names').value,'Custom sensor\nElastic Agent');
  assert.equal(h.node('requirements-fields').disabled,false);
  assert.equal(h.node('requirements-count').textContent,'2 required');
});

test('group loading is independent from unrelated access settings failure', async () => {
  const h = setup(); h.overrides.listUsers = async () => {throw new Error('synthetic');};
  h.overrides.listGroups = async () => ({data:testGroups});
  await h.view.render(h.container);
  assert.match(h.node('groups-list').innerHTML,/Production/);
  assert.equal(h.node('requirements-group').disabled,false);
});

test('failed requirements load locks editing, hides old names and supports retry', async () => {
  const h = await groupSetup(); await h.view.selectRequirementGroup(0);
  h.overrides.getRequiredAgents = async () => {throw new Error('private detail');};
  await h.view.selectRequirementGroup(1); await h.view.saveReqAgents();
  assert.equal(h.calls.setRequiredAgents,undefined);
  assert.equal(h.node('requirements-names').value,'');
  assert.equal(h.node('requirements-fields').disabled,true);
  assert.equal(h.node('requirements-retry').hidden,false);
  assert.doesNotMatch(h.node('requirements-feedback').textContent,/private detail/);
  h.overrides.getRequiredAgents = async id => ({data:{group_id:id,agents:[]}});
  await h.view.selectRequirementGroup();
  assert.equal(h.node('requirements-fields').disabled,false);
  assert.match(h.node('requirements-feedback').textContent,/does not mean.*compliant/);
});

test('readonly can inspect requirements but cannot mutate groups or requirements', async () => {
  const h = await groupSetup({role:'readonly',permissions:['groups.read']});
  await h.view.selectRequirementGroup(0);
  assert.equal(h.node('requirements-names').value,'Custom sensor\nElastic Agent');
  assert.equal(h.node('requirements-fields').disabled,true);
  await h.view.saveReqAgents(); await h.view.createGroup(); h.view.requestGroupDelete(0); await h.view.deleteGroup();
  assert.equal(h.calls.setRequiredAgents,undefined); assert.equal(h.calls.createGroup,undefined); assert.equal(h.calls.deleteGroup,undefined);
});

test('scoped writer can edit assigned requirements but cannot create a group', async () => {
  const h = await groupSetup({role:'operator',permissions:['groups.read','groups.write'],group_scopes:['group-a']});
  assert.equal(h.node('new-group-name'),null);
  await h.view.createGroup(); assert.equal(h.calls.createGroup,undefined);
  await h.view.selectRequirementGroup(0); h.set('requirements-names','Synthetic sensor');
  await h.view.saveReqAgents(); assert.equal(h.calls.setRequiredAgents[0][0],'group-a');
});

test('requirements save sends a deduplicated draft once and confirms server state', async () => {
  const h = await groupSetup(); await h.view.selectRequirementGroup(0);
  const pending = deferred(); h.overrides.setRequiredAgents = () => pending.promise;
  h.set('requirements-names','  Synthetic sensor  \nSynthetic sensor\nOther sensor');
  h.view.requirementsChanged();
  const saving = h.view.saveReqAgents(); await h.view.saveReqAgents(); await h.view.selectRequirementGroup(1);
  assert.equal(h.calls.setRequiredAgents.length,1);
  assert.deepEqual(Array.from(h.calls.setRequiredAgents[0][1]),['Synthetic sensor','Other sensor']);
  assert.equal(h.node('requirements-group').disabled,true);
  pending.resolve({data:{group_id:'group-a',agents:['Synthetic sensor','Other sensor']}}); await saving;
  assert.match(h.node('requirements-feedback').textContent,/Requirements saved/);
  assert.equal(h.node('requirements-fields').disabled,false);
});

test('clearing requirements needs explicit confirmation and resets it after save', async () => {
  const h = await groupSetup(); await h.view.selectRequirementGroup(0);
  h.set('requirements-names',''); h.view.requirementsChanged(); await h.view.saveReqAgents();
  assert.equal(h.calls.setRequiredAgents,undefined); assert.equal(h.node('requirements-clear-label').hidden,false);
  assert.equal(h.node('requirements-clear').focused,true);
  h.node('requirements-clear').checked=true; await h.view.saveReqAgents();
  assert.deepEqual(Array.from(h.calls.setRequiredAgents[0][1]),[]);
  assert.equal(h.node('requirements-clear').checked,false);
  assert.equal(h.node('requirements-count').textContent,'0 required');
});

test('invalid requirement drafts never reach the API', async () => {
  const h = await groupSetup(); await h.view.selectRequirementGroup(0);
  for (const value of ['x'.repeat(101),Array.from({length:51},(_,n)=>'sensor'+n).join('\n'),'sensor\u0000name']) {
    h.set('requirements-names',value); await h.view.saveReqAgents();
    assert.equal(h.calls.setRequiredAgents,undefined);
    assert.match(h.node('requirements-feedback').textContent,/without control characters/);
  }
});

test('failed or malformed saves preserve draft and never claim success', async () => {
  const h = await groupSetup(); await h.view.selectRequirementGroup(0);
  for (const response of [null,{data:{group_id:'other',agents:[]}},{data:{status:'saved'}}]) {
    h.set('requirements-names','New sensor'); h.overrides.setRequiredAgents = async () => response;
    await h.view.saveReqAgents();
    assert.equal(h.node('requirements-names').value,'New sensor');
    assert.match(h.node('requirements-feedback').textContent,/could not be confirmed/);
    assert.equal(h.node('requirements-fields').disabled,false);
  }
});

test('late requirements read cannot overwrite a newer selected group', async () => {
  const h = await groupSetup(); const pending = deferred(); h.overrides.getRequiredAgents = () => pending.promise;
  const old = h.view.selectRequirementGroup(0);
  h.overrides.getRequiredAgents = async id => ({data:{group_id:id,agents:['New group sensor']}});
  await h.view.selectRequirementGroup(1);
  pending.resolve({data:{group_id:'group-a',agents:['Old sensor']}}); await old;
  assert.equal(h.node('requirements-names').value,'New group sensor');
});

test('late requirements save cannot overwrite or unlock a remounted form', async () => {
  const h = await groupSetup(); await h.view.selectRequirementGroup(0);
  const pending = deferred(); h.overrides.setRequiredAgents = () => pending.promise;
  const saving = h.view.saveReqAgents(); await h.view.render(h.container);
  pending.resolve({data:{group_id:'group-a',agents:['Old saved sensor']}}); await saving;
  assert.equal(h.node('requirements-names').value,'');
  assert.equal(h.node('requirements-fields').disabled,true);
});

test('lost group scope clears selected requirements after refresh', async () => {
  const h = await groupSetup(); await h.view.selectRequirementGroup(0);
  h.overrides.listGroups = async () => ({data:[]}); await h.view.loadGroups();
  assert.equal(h.node('requirements-names').value,''); assert.equal(h.node('requirements-fields').disabled,true);
  await h.view.saveReqAgents(); assert.equal(h.calls.setRequiredAgents,undefined);
});

test('late group list cannot replace a remounted directory', async () => {
  const h = await groupSetup(); const pending = deferred(); h.overrides.listGroups = () => pending.promise;
  const old = h.view.loadGroups(); h.overrides.listGroups = async () => ({data:[{id:'fresh',name:'Fresh group'}]});
  await h.view.render(h.container); pending.resolve({data:testGroups}); await old;
  assert.match(h.node('groups-list').innerHTML,/Fresh group/); assert.doesNotMatch(h.node('groups-list').innerHTML,/Production/);
});

test('group deletion requires confirmation, keeps conflict visible, and supports cancel', async () => {
  const h = await groupSetup(); await h.view.deleteGroup(); assert.equal(h.calls.deleteGroup,undefined);
  h.view.requestGroupDelete(0); assert.equal(h.calls.deleteGroup,undefined);
  assert.equal(h.node('group-delete-confirm').focused,true);
  assert.match(h.node('groups-list').innerHTML,/aria-expanded="true"/);
  h.overrides.deleteGroup = async () => {throw new Error('private database error');};
  await h.view.deleteGroup(); assert.equal(h.calls.deleteGroup[0][0],'group-a');
  assert.match(h.node('groups-feedback').textContent,/Referenced groups cannot be deleted/);
  assert.equal(h.node('group-delete-panel').hidden,false);
  h.view.cancelGroupDelete(); assert.equal(h.node('groups-refresh').focused,true);
  await h.view.deleteGroup(); assert.equal(h.calls.deleteGroup.length,1);
});

test('confirmed group creation clears fields and refreshes durable state once', async () => {
  const h = await groupSetup(); const pending = deferred(); h.overrides.createGroup = () => pending.promise;
  h.set('new-group-name',' Synthetic group '); h.set('new-group-desc','Description');
  const saving = h.view.createGroup(); await h.view.createGroup();
  assert.equal(h.calls.createGroup.length,1); assert.equal(h.node('group-create-fields').disabled,true);
  pending.resolve({data:{id:'created'}}); await saving;
  assert.equal(h.node('new-group-name').value,''); assert.equal(h.calls.listGroups.length,2);
});

test('confirmed group deletion submits once and refreshes without reopening the removed selection', async () => {
  const h = await groupSetup(); await h.view.selectRequirementGroup(0);
  const pending = deferred(); h.overrides.deleteGroup = () => pending.promise;
  h.view.requestGroupDelete(0); const deleting = h.view.deleteGroup(); await h.view.deleteGroup();
  assert.equal(h.calls.deleteGroup.length,1);
  h.overrides.listGroups = async () => ({data:[]});
  pending.resolve({data:{status:'deleted'}}); await deleting;
  assert.equal(h.node('group-delete-panel').hidden,true);
  assert.equal(h.node('requirements-fields').disabled,true);
  assert.equal(h.node('requirements-names').value,'');
});

test('late group deletion cannot refresh or show errors on a remounted view', async () => {
  const h = await groupSetup(); const pending = deferred(); h.overrides.deleteGroup = () => pending.promise;
  h.view.requestGroupDelete(0); const deleting = h.view.deleteGroup();
  await h.view.render(h.container); const feedback = h.node('groups-feedback').textContent;
  pending.reject(new Error('synthetic-private')); await deleting;
  assert.equal(h.node('groups-feedback').textContent,feedback);
  assert.equal(h.node('group-delete-panel').hidden,true);
});

test('a requirement response for the wrong group is rejected before enabling edits', async () => {
  const h = await groupSetup();
  h.overrides.getRequiredAgents = async () => ({data:{group_id:'group-b',agents:['Foreign sensor']}});
  await h.view.selectRequirementGroup(0);
  assert.equal(h.node('requirements-names').value,'');
  assert.equal(h.node('requirements-fields').disabled,true);
  assert.equal(h.node('requirements-retry').hidden,false);
});
