'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
const sample = (id = 'p1', extra = {}) => ({id, name:'sms-agent', version:'1.0', os_target:'linux', arch_target:'amd64', file_size:1024, sha256:'a'.repeat(64), ...extra});

// Synthetic DOM/API adapter checks behavior; it does not verify browser layout.
function setup(user = {role:'admin'}) {
  let nodes = new Map(), html = '', approved = true;
  const calls = {}, overrides = {};
  const API = {getUser:()=>user};
  for (const name of ['listPackages','uploadPackage','deletePackage']) API[name] = (...args) => {
    (calls[name] ||= []).push(args);
    return overrides[name] ? overrides[name](...args) : Promise.resolve({data:name === 'listPackages' ? [] : {status:'saved'}});
  };
  const container = {
    set innerHTML(value) {
      html = value; nodes = new Map();
      for (const match of value.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const attrs = match[0];
        const node = {id:match[2], value:'', textContent:'', innerHTML:'', files:[], disabled:/\sdisabled\b/.test(attrs), hidden:/\shidden\b/.test(attrs), attributes:{}, events:{},
          focus(){this.focused=true;}, setAttribute(k,v){this.attributes[k]=v;}, addEventListener(k,v){this.events[k]=v;},
          reset(){for(const [id,n] of nodes)if(id.startsWith('pkg-')){n.value='';n.files=[];}}};
        nodes.set(node.id,node);
      }
    }, get innerHTML(){return html;}
  };
  const document = {getElementById:id=>nodes.get(id) || null};
  const context = vm.createContext({Views:{},API,document,TextEncoder,confirm:()=>approved,FormData:class {constructor(){this.fields=new Map();}append(k,v){this.fields.set(k,v);}},
    App:{escHtml:v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),timeAgo:()=> 'just now'},
    UI:{empty:(title,desc)=>`<strong>${title}</strong><p>${desc}</p>`,icon:()=>'<svg></svg>'}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../static/js/views/packages.js'),'utf8'),context);
  return {view:context.Views.Packages,container,calls,overrides,node:id=>document.getElementById(id),approve:v=>{approved=v;},
    fill(file={name:'agent.bin',size:24}){nodes.get('pkg-name').value='sms-agent';nodes.get('pkg-version').value='1.0';nodes.get('pkg-file').files=[file];},
    submit:()=>context.Views.Packages.uploadPackage({preventDefault(){}})};
}

test('Packages: permission denial prevents reads and mutation controls', async()=>{
  const h=setup({role:'readonly',permissions:[]});await h.view.render(h.container);await h.view.reload();await h.submit();await h.view.deletePackage('p1');
  assert.match(h.container.innerHTML,/needs packages.read/);assert.deepEqual(h.calls,{});
});
test('Packages: readonly library can download but cannot upload or delete', async()=>{
  const h=setup({role:'readonly',permissions:['packages.read']});h.overrides.listPackages=async()=>({data:[sample()]});await h.view.render(h.container);
  assert.equal(h.node('pkg-upload-form'),null);assert.match(h.node('packages-tbody').innerHTML,/\/api\/packages\/public\/p1/);
  assert.doesNotMatch(h.node('packages-tbody').innerHTML,/data-package-delete/);await h.submit();await h.view.deletePackage('p1');assert.equal(h.calls.deletePackage,undefined);assert.equal(h.calls.uploadPackage,undefined);
});
test('Packages: empty state has an upload action, expanded state and keyboard focus', async()=>{
  const h=setup();await h.view.render(h.container);assert.match(h.node('packages-tbody').innerHTML,/Upload first package/);assert.match(h.node('packages-summary').textContent,/0 of 0 releases/);
  h.view.showUpload(true);assert.equal(h.node('upload-form').hidden,false);assert.equal(h.node('pkg-name').focused,true);assert.equal(h.node('packages-upload-toggle').attributes['aria-expanded'],'true');
  h.view.showUpload(false);assert.equal(h.node('packages-upload-toggle').focused,true);
});
test('Packages: combined filters include universal packages and persist on refresh', async()=>{
  const h=setup();h.overrides.listPackages=async()=>({data:[sample(),sample('p2',{os_target:'windows'}),sample('p3',{os_target:'',arch_target:'',version:'2.0'})]});await h.view.render(h.container);
  h.node('packages-os').value='linux';h.node('packages-arch').value='amd64';h.node('packages-search').value=' SMS-AGENT ';h.view.draw();
  assert.match(h.node('packages-summary').textContent,/2 of 3 releases/);await h.view.reload();assert.match(h.node('packages-summary').textContent,/2 of 3 releases/);
  h.node('packages-search').value='missing';h.view.draw();assert.match(h.node('packages-tbody').innerHTML,/No matching releases/);h.view.resetFilters();assert.match(h.node('packages-summary').textContent,/3 of 3 releases/);
});
test('Packages: failed list stays failed while filters change and retry recovers', async()=>{
  const h=setup();h.overrides.listPackages=async()=>{throw Error('offline');};await h.view.render(h.container);h.view.draw();assert.match(h.node('packages-tbody').innerHTML,/Could not load/);
  assert.match(h.node('packages-summary').textContent,/unavailable/);h.overrides.listPackages=async()=>({data:[sample()]});await h.view.reload();assert.match(h.node('packages-summary').textContent,/1 of 1/);
});
test('Packages: malicious stored metadata is escaped in text and attributes, never inserted into executable handlers', async()=>{
  const h=setup();const attack=`x'\");alert(1);//" onfocus="alert(2)<script>`;
  h.overrides.listPackages=async()=>({data:[sample(attack,{name:attack,version:attack,description:attack,sha256:attack,os_target:attack})]});await h.view.render(h.container);
  const html=h.node('packages-tbody').innerHTML;assert.doesNotMatch(html,/<script>| onfocus="|onclick=/);assert.match(html,/&quot;/);assert.match(html,/&#39;/);assert.match(html,/&lt;script&gt;/);
});
for(const [name,file] of [['missing',null],['empty',{name:'agent.bin',size:0}],['oversize',{name:'agent.bin',size:500*1024*1024+1}],['path',{name:'../agent.bin',size:20}],['unicode filename',{name:'żółć.bin',size:20}]]) {
  test(`Packages: ${name} file never reaches upload API`,async()=>{
    const h=setup();await h.view.render(h.container);h.fill(file);h.node('pkg-file').files=file?[file]:[];await h.submit();assert.equal(h.calls.uploadPackage,undefined);assert.equal(h.node('pkg-file').focused,true);
  });
}
test('Packages: invalid labels and byte-heavy descriptions are rejected before upload',async()=>{
  const h=setup();await h.view.render(h.container);h.fill();h.node('pkg-name').value='../escape';await h.submit();assert.equal(h.calls.uploadPackage,undefined);
  h.fill();h.node('pkg-desc').value='ż'.repeat(2049);await h.submit();assert.equal(h.calls.uploadPackage,undefined);assert.equal(h.node('pkg-desc').focused,true);
});
test('Packages: upload sends multipart fields, suppresses duplicates and clears only after confirmation',async()=>{
  const h=setup();await h.view.render(h.container);h.fill();const pending=deferred();h.overrides.uploadPackage=()=>pending.promise;const first=h.submit();await h.submit();
  assert.equal(h.calls.uploadPackage.length,1);assert.equal(h.node('pkg-fields').disabled,true);assert.equal(h.node('pkg-upload-form').attributes['aria-busy'],'true');assert.equal(h.calls.uploadPackage[0][0].fields.get('name'),'sms-agent');
  pending.resolve({data:sample()});await first;assert.equal(h.node('pkg-file').files.length,0);assert.equal(h.node('pkg-fields').disabled,false);assert.match(h.node('upload-status').textContent,/Package saved/);assert.equal(h.calls.listPackages.length,2);
});
test('Packages: upload failure preserves file and metadata, permits explicit retry',async()=>{
  const h=setup();await h.view.render(h.container);h.fill();h.overrides.uploadPackage=async()=>{throw Error('disk unavailable');};await h.submit();
  assert.equal(h.node('pkg-name').value,'sms-agent');assert.equal(h.node('pkg-file').files.length,1);assert.equal(h.node('pkg-fields').disabled,false);assert.match(h.node('upload-status').textContent,/Refresh the library before retrying/);
  h.overrides.uploadPackage=async()=>({data:sample()});await h.submit();assert.equal(h.calls.uploadPackage.length,2);
});
for(const failure of [false,true]) {
  test(`Packages: late list ${failure?'failure':'success'} cannot replace a newer refresh`,async()=>{
    const h=setup();await h.view.render(h.container);const pending=deferred();h.overrides.listPackages=()=>pending.promise;const old=h.view.reload();h.overrides.listPackages=async()=>({data:[sample('new',{name:'new-release'})]});await h.view.reload();
    if(failure)pending.reject(Error('old'));else pending.resolve({data:[sample()]});await old;assert.match(h.node('packages-tbody').innerHTML,/new-release/);assert.equal(h.node('packages-refresh').disabled,false);
  });
  test(`Packages: late upload ${failure?'failure':'success'} cannot alter a remounted form`,async()=>{
    const h=setup();await h.view.render(h.container);h.fill();const pending=deferred();h.overrides.uploadPackage=()=>pending.promise;const old=h.submit();await h.view.render(h.container);h.fill({name:'new.bin',size:20});
    if(failure)pending.reject(Error('old'));else pending.resolve({data:sample()});await old;assert.equal(h.node('pkg-file').files[0].name,'new.bin');assert.equal(h.node('upload-status').textContent,'');assert.equal(h.calls.listPackages.length,2);
  });
  test(`Packages: list ${failure?'failure':'success'} after navigation is ignored`,async()=>{
    const h=setup();await h.view.render(h.container);const pending=deferred();h.overrides.listPackages=()=>pending.promise;const old=h.view.reload();h.container.innerHTML='<p>Another view</p>';
    if(failure)pending.reject(Error('old'));else pending.resolve({data:[sample()]});await old;assert.equal(h.container.innerHTML,'<p>Another view</p>');
  });
}
test('Packages: delete requires confirmation and prevents duplicate calls while pending',async()=>{
  const h=setup();h.overrides.listPackages=async()=>({data:[sample()]});await h.view.render(h.container);h.approve(false);await h.view.deletePackage('p1');assert.equal(h.calls.deletePackage,undefined);
  h.approve(true);const pending=deferred();h.overrides.deletePackage=()=>pending.promise;const first=h.view.deletePackage('p1');await h.view.deletePackage('p1');assert.equal(h.calls.deletePackage.length,1);assert.match(h.node('packages-tbody').innerHTML,/Deleting…/);
  pending.reject(Error('offline'));await first;assert.match(h.node('packages-feedback').textContent,/Deletion could not be confirmed/);assert.doesNotMatch(h.node('packages-tbody').innerHTML,/Deleting…/);
});
test('Packages: successful delete surfaces storage cleanup warnings',async()=>{
  const h=setup();h.overrides.listPackages=async()=>({data:[sample()]});h.overrides.deletePackage=async()=>({data:{status:'deleted',warning:'File cleanup requires administrator review'}});await h.view.render(h.container);await h.view.deletePackage('p1');
  assert.match(h.node('packages-feedback').textContent,/cleanup requires administrator/);assert.equal(h.calls.listPackages.length,2);
});
test('Packages: delete response cannot reload or change a newer view',async()=>{
  const h=setup();h.overrides.listPackages=async()=>({data:[sample()]});await h.view.render(h.container);const pending=deferred();h.overrides.deletePackage=()=>pending.promise;const old=h.view.deletePackage('p1');await h.view.render(h.container);
  pending.resolve({data:{status:'deleted'}});await old;assert.equal(h.calls.listPackages.length,2);assert.equal(h.node('packages-feedback').textContent,'');
});
