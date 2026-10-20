'use strict';

// Run without browser dependencies: node --test server/tests/api.test.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../static/js/api.js'), 'utf8');

function setup(responses, refreshToken = 'old-refresh') {
  const session = new Map([['sms_at', 'old-access']]);
  const local = new Map(refreshToken ? [['sms_rt', refreshToken]] : []);
  const storage = map => ({
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    removeItem: key => map.delete(key)
  });
  const calls = [];
  const timers = new Map();
  let nextTimer = 0;
  let loginCount = 0;
  const context = {
    window: {},
    atob,
    TextDecoder,
    URLSearchParams,
    sessionStorage: storage(session),
    localStorage: storage(local),
    App: { showLogin() { loginCount++; } },
    console: { warn() {} },
    setTimeout(fn, delay) {
      timers.set(++nextTimer, { fn, delay });
      return nextTimer;
    },
    clearTimeout(id) { timers.delete(id); },
    async fetch(path, options) {
      calls.push({ path, options: { ...options, headers: { ...options.headers } } });
      assert.ok(responses.length, 'unexpected extra request');
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    }
  };
  vm.runInNewContext(source, context, { filename: 'api.js' });
  const api = context.window.API;
  api.init();
  return {
    api, session, local, calls, timers,
    get loginCount() { return loginCount; },
    async fireTimer() {
      assert.equal(timers.size, 1);
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      await timer.fn();
    }
  };
}

function response(status, data) {
  return {
    status, ok: status >= 200 && status < 300,
    async json() {
      if (data instanceof Error) throw data;
      return data;
    }
  };
}

test('command retry after token rotation preserves idempotency key and exact body', async () => {
  const state = setup([response(401,{}), response(200,{data:{access_token:'new-access',refresh_token:'new-refresh'}}), response(200,{data:{request_key:'synthetic-key'}})]);
  const payload = {group_id:'group',type:'force_report',payload:{}};
  await state.api.createCommand(payload, 'synthetic-key');
  assert.equal(state.calls.length,3);
  for (const call of [state.calls[0],state.calls[2]]) {
    assert.equal(call.path,'/api/commands');
    assert.equal(call.options.headers['Idempotency-Key'],'synthetic-key');
    assert.equal(call.options.body,JSON.stringify(payload));
  }
  assert.equal(state.calls[2].options.headers.Authorization,'Bearer new-access');
});

test('command transport exposes network uncertainty and only repeats on explicit retry', async () => {
  const state=setup([new Error('connection lost'),response(200,{data:{replayed:true}})]);
  await assert.rejects(state.api.createCommand({type:'force_report'},'same-key'),/connection lost/);
  assert.equal(state.calls.length,1);
  await state.api.createCommand({type:'force_report'},'same-key');
  assert.equal(state.calls[1].options.headers['Idempotency-Key'],'same-key');
  assert.equal(state.calls[0].options.body,state.calls[1].options.body);
});

test('group requirement transport keeps the target in one encoded segment and sends explicit replacement', async () => {
  const state = setup([response(200,{success:true,data:{agents:[]}}),response(200,{success:true,data:{agents:[]}})]);
  await state.api.getRequiredAgents('synthetic/other?group=x');
  await state.api.setRequiredAgents('synthetic/other?group=x', []);
  for (const call of state.calls) {
    assert.equal(call.path, '/api/groups/synthetic%2Fother%3Fgroup%3Dx/required-agents');
    assert.equal(call.options.headers.Authorization, 'Bearer old-access');
  }
  assert.equal(state.calls[0].options.method, 'GET');
  assert.equal(state.calls[1].options.method, 'PUT');
  assert.deepEqual(JSON.parse(state.calls[1].options.body), {agents:[]});
});

test('inventory requests encode filters and use private view CRUD endpoints', async () => {
  const state=setup(Array.from({length:6},()=>response(200,{success:true,data:{}})));
  await state.api.getInventory({search:'a&group=foreign %_ ::1',page:2,page_size:50,sort:'seen'});
  const url=new URL(state.calls[0].path,'http://localhost');
  assert.equal(url.pathname,'/api/inventory/servers');
  assert.equal(url.searchParams.get('search'),'a&group=foreign %_ ::1');
  assert.equal(url.searchParams.has('group'),false);
  assert.equal(url.searchParams.get('page_size'),'50');
  await state.api.listInventoryGroups();
  await state.api.listInventoryViews();
  await state.api.saveInventoryView('',{name:'Mine',filters:{sort:'name',page_size:25}});
  await state.api.saveInventoryView('view/id',{name:'Updated',filters:{sort:'seen'}});
  await state.api.deleteInventoryView('view/id');
  assert.deepEqual(state.calls.slice(1).map(c=>[c.options.method,c.path]),[
    ['GET','/api/inventory/groups'],['GET','/api/inventory/views'],['POST','/api/inventory/views'],
    ['PUT','/api/inventory/views/view%2Fid'],['DELETE','/api/inventory/views/view%2Fid']
  ]);
  assert.deepEqual(JSON.parse(state.calls[3].options.body),{name:'Mine',filters:{sort:'name',page_size:25}});
});

const refreshed = () => response(200, {
  data: { access_token: 'new-access', refresh_token: 'new-refresh' }
});

test('password change clears both credentials only after confirmed success', async () => {
  const state = setup([response(200, {data:{status:'password_changed'}})]);
  await state.api.changePassword({current_password:'synthetic-old',new_password:'synthetic-new'});
  assert.equal(state.session.has('sms_at'),false);assert.equal(state.local.has('sms_rt'),false);
  assert.equal(state.loginCount,1);assert.equal(state.api.isLoggedIn(),false);
});

test('failed password change preserves credentials for retry', async () => {
  const state = setup([response(503, {})]);
  await assert.rejects(state.api.changePassword({current_password:'synthetic',new_password:'synthetic'}));
  assertSessionPreserved(state);
});

for (const malformed of [null, {}, {data:{status:'saved'}}]) test(`password change rejects malformed confirmation ${JSON.stringify(malformed)}`, async () => {
  const state = setup([response(200, malformed)]);
  await assert.rejects(state.api.changePassword({current_password:'synthetic',new_password:'synthetic'}), /could not be confirmed/);
  assertSessionPreserved(state);
});

test('logout confirms durable revocation and sends no refresh credential in the body', async () => {
  const state = setup([response(200, {data:{revoked:1}})]);
  const result = await state.api.logout();
  assert.equal(result.confirmed, true);
  assert.equal(state.calls[0].options.body, undefined);
  assert.equal(state.calls[0].options.headers.Authorization, 'Bearer old-access');
  assert.equal(state.api.isLoggedIn(), false);
});

test('logout with malformed success clears locally without claiming revocation', async () => {
  const state = setup([response(200, {data:{status:'saved'}})]);
  const result = await state.api.logout();
  assert.equal(result.confirmed, false);
  assert.equal(state.api.isLoggedIn(), false);
});

test('session actions use personal endpoints without accepting another user ID', async () => {
  const state = setup([response(200,{data:[]}),response(200,{data:{revoked:2}})]);
  await state.api.listSessions();await state.api.revokeOtherSessions();
  assert.equal(state.calls[0].path,'/api/account/sessions');
  assert.equal(state.calls[1].path,'/api/account/sessions/revoke-others');
  assert.equal(state.calls[1].options.method,'POST');assert.equal(state.calls[1].options.body,undefined);
});

test('logout storage failure clears locally but does not claim server revocation', async () => {
  const state=setup([response(503,{})]);const result=await state.api.logout();
  assert.equal(result.confirmed,false);assert.equal(result.sessionChanged,false);assert.equal(state.api.isLoggedIn(),false);
});

for (const action of ['logout','changePassword']) test(`late ${action} success cannot clear a newer login`,async()=>{
  const pending=deferred();
  const state=setup([pending.promise,response(200,{data:{access_token:'other-access',refresh_token:'other-refresh'}})]);
  const operation=action==='logout' ? state.api.logout() : state.api.changePassword({current_password:'old',new_password:'new'});
  await state.api.login('other-user','synthetic-password');pending.resolve(response(200,{data:{status:'saved'}}));
  if(action==='logout') assert.equal((await operation).sessionChanged,true);
  else await assert.rejects(operation,/Session changed/);
  assert.equal(state.session.get('sms_at'),'other-access');assert.equal(state.local.get('sms_rt'),'other-refresh');assert.equal(state.loginCount,0);
});

function assertSessionPreserved(state) {
  assert.equal(state.session.get('sms_at'), 'old-access');
  assert.equal(state.local.get('sms_rt'), 'old-refresh');
  assert.equal(state.api.isLoggedIn(), true);
  assert.equal(state.loginCount, 0);
}

for (const [name, failure] of [
  ['network failure', new TypeError('Failed to fetch')],
  ['HTTP 503', response(503, {})],
  ['HTTP 429', response(429, {})],
  ['invalid JSON', response(200, new SyntaxError('Invalid JSON'))],
  ['missing tokens', response(200, { data: {} })]
]) {
  test(`refresh ${name} preserves the session and rejects the request`, async () => {
    const state = setup([response(401, {}), failure]);
    await assert.rejects(state.api.getServers());
    assertSessionPreserved(state);
    assert.equal(state.calls.length, 2, 'do not retry with the expired access token');
  });
}

test('an expired refresh token clears the session and shows login once', async () => {
  const state = setup([response(401, {}), response(401, {})]);
  await assert.rejects(state.api.getServers(), /Unauthenticated/);
  assert.equal(state.api.isLoggedIn(), false);
  assert.equal(state.session.size, 0);
  assert.equal(state.local.size, 0);
  assert.equal(state.loginCount, 1);
  assert.equal(state.timers.size, 0);
  assert.equal(state.calls.length, 2);
});

test('a successful refresh retries using the new access token', async () => {
  const payload = { data: [{ id: 'server-1' }] };
  const state = setup([response(401, {}), refreshed(), response(200, payload)]);
  assert.deepEqual(await state.api.getServers(), payload);
  assert.equal(state.calls[0].options.headers.Authorization, 'Bearer old-access');
  assert.equal(state.calls[1].path, '/api/auth/refresh');
  assert.deepEqual(JSON.parse(state.calls[1].options.body), { refresh_token: 'old-refresh' });
  assert.equal(state.calls[2].options.headers.Authorization, 'Bearer new-access');
  assert.equal(state.local.get('sms_rt'), 'new-refresh');
  assert.equal(state.loginCount, 0);
});

for (const needsRefresh of [false, true]) {
  test(`a 204 response returns null ${needsRefresh ? 'after token refresh' : 'without token refresh'}`, async () => {
    // Native Response rejects json() for the empty body required by HTTP 204.
    const noContent = new Response(null, { status: 204 });
    const state = setup(needsRefresh ? [response(401, {}), refreshed(), noContent] : [noContent]);
    assert.equal(await state.api.assignGroup('server-1', 'group-1'), null);
    assert.equal(noContent.bodyUsed, false);
    const mutations = state.calls.filter(call => call.path === '/api/servers/server-1/group');
    assert.equal(mutations.length, needsRefresh ? 2 : 1);
    for (const call of mutations) {
      assert.equal(call.options.method, 'PUT');
      assert.deepEqual(JSON.parse(call.options.body), { group_id: 'group-1' });
    }
    assert.equal(mutations.at(-1).options.headers.Authorization,
      needsRefresh ? 'Bearer new-access' : 'Bearer old-access');
    assert.equal(state.calls.length, needsRefresh ? 3 : 1);
    assert.equal(state.loginCount, 0);
    assert.equal(state.api.isLoggedIn(), true);
  });
}

test('an error response after token refresh still rejects the mutation', async () => {
  const state = setup([response(401, {}), refreshed(), response(403, { error: 'Access denied' })]);
  await assert.rejects(state.api.assignGroup('server-1', 'group-1'), /Access denied/);
  assert.equal(state.calls.length, 3);
  assert.equal(state.loginCount, 0);
});

test('scheduled refresh retries after a temporary outage and recovers', async () => {
  const state = setup([new TypeError('Failed to fetch'), refreshed()]);
  await state.fireTimer();
  assertSessionPreserved(state);
  assert.equal(state.timers.size, 1);
  assert.equal([...state.timers.values()][0].delay, 60000);
  await state.fireTimer();
  assert.equal(state.session.get('sms_at'), 'new-access');
  assert.equal(state.local.get('sms_rt'), 'new-refresh');
  assert.equal([...state.timers.values()][0].delay, 780000);
});

test('scheduled refresh stops after the session expires', async () => {
  const state = setup([response(401, {})]);
  await state.fireTimer();
  assert.equal(state.api.isLoggedIn(), false);
  assert.equal(state.loginCount, 1);
  assert.equal(state.timers.size, 0);
});

test('an ordinary request network failure preserves the session', async () => {
  const state = setup([new TypeError('Failed to fetch')]);
  await assert.rejects(state.api.getServers(), /Failed to fetch/);
  assertSessionPreserved(state);
  assert.equal(state.calls.length, 1);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

for (const needsRefresh of [false, true]) {
  test(`package upload preserves multipart data ${needsRefresh ? 'after refreshing the session' : 'without refreshing'}`, async () => {
    const payload = { data: { id: 'package-1' } };
    const state = setup(needsRefresh
      ? [response(401, {}), refreshed(), response(200, payload)]
      : [response(200, payload)]);
    const form = new FormData();
    form.append('version', '1.2.3');
    form.append('file', new Blob(['synthetic package']), 'agent.bin');
    assert.deepEqual(await state.api.uploadPackage(form), payload);
    const uploads = state.calls.filter(call => call.path === '/api/packages/upload');
    assert.equal(uploads.length, needsRefresh ? 2 : 1);
    for (const call of uploads) {
      assert.equal(call.options.method, 'POST');
      assert.equal(call.options.body, form);
      // The browser must generate Content-Type with the multipart boundary.
      assert.equal(call.options.headers['Content-Type'], undefined);
      const decoded = await new Request('https://example.invalid/upload', call.options).formData();
      assert.equal(decoded.get('version'), '1.2.3');
      assert.equal(decoded.get('file').name, 'agent.bin');
      assert.equal(await decoded.get('file').text(), 'synthetic package');
    }
    assert.equal(uploads[0].options.headers.Authorization, 'Bearer old-access');
    assert.equal(uploads.at(-1).options.headers.Authorization,
      needsRefresh ? 'Bearer new-access' : 'Bearer old-access');
    assert.equal(state.calls.length, needsRefresh ? 3 : 1);
    assert.equal(state.loginCount, 0);
  });
}

test('package upload preserves the session when refresh is temporarily unavailable', async () => {
  const state = setup([response(401, {}), response(503, {})]);
  await assert.rejects(state.api.uploadPackage(new FormData()), /HTTP 503/);
  assertSessionPreserved(state);
  assert.equal(state.calls.length, 2);
});

test('package upload with an expired refresh token clears the session without retrying', async () => {
  const state = setup([response(401, {}), response(401, {})]);
  await assert.rejects(state.api.uploadPackage(new FormData()), /Unauthenticated/);
  assert.equal(state.calls.length, 2);
  assert.equal(state.loginCount, 1);
  assert.equal(state.session.size, 0);
  assert.equal(state.local.size, 0);
  assert.equal(state.timers.size, 0);
});

test('package upload reports server errors after refresh without further retries', async () => {
  const state = setup([response(401, {}), refreshed(), response(403, { error: 'Access denied' })]);
  await assert.rejects(state.api.uploadPackage(new FormData()), /Access denied/);
  assert.equal(state.calls.length, 3);
  assert.equal(state.loginCount, 0);
});

test('package upload does not retry network failures or ordinary server errors', async () => {
  for (const [failure, expected] of [
    [new TypeError('Failed to fetch'), /Failed to fetch/],
    [response(413, { error: 'Package too large' }), /Package too large/],
    [response(500, new SyntaxError('Invalid JSON')), /Upload failed/]
  ]) {
    const state = setup([failure]);
    await assert.rejects(state.api.uploadPackage(new FormData()), expected);
    assert.equal(state.calls.length, 1);
    assertSessionPreserved(state);
  }
});

for (const username of ['admin', 'Łukasz Żółć', '???~~~']) {
  test(`getUser decodes JWT claims for ${username}`, () => {
    const state = setup([]);
    const claims = {
      user_id: 'user-1', username, role: 'viewer',
      permissions: ['servers.read'], group_scopes: ['group-1']
    };
    const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    if (username === '???~~~') assert.match(payload, /[-_]/);
    state.session.set('sms_at', `header.${payload}.signature`);
    state.api.init();
    const user = state.api.getUser();
    assert.ok(user);
    assert.equal(user.id, claims.user_id);
    assert.equal(user.username, username);
    assert.equal(user.role, claims.role);
    assert.deepEqual(Array.from(user.permissions), claims.permissions);
    assert.deepEqual(Array.from(user.group_scopes), claims.group_scopes);
    assert.equal(state.calls.length, 0);
  });
}

test('getUser supplies empty permissions and scopes when claims omit them', () => {
  const state = setup([]);
  const payload = Buffer.from(JSON.stringify({ username: 'admin' })).toString('base64url');
  state.session.set('sms_at', `header.${payload}.signature`);
  state.api.init();
  const user = state.api.getUser();
  assert.ok(user);
  assert.deepEqual(Array.from(user.permissions), []);
  assert.deepEqual(Array.from(user.group_scopes), []);
});

test('getUser returns null for absent or malformed tokens', () => {
  const state = setup([]);
  for (const token of [null, 'invalid', 'header.%.signature', 'header.bm90LWpzb24.signature']) {
    if (token === null) state.session.delete('sms_at');
    else state.session.set('sms_at', token);
    state.api.init();
    assert.equal(state.api.getUser(), null);
  }
});

test('concurrent unauthorized requests share one refresh and retry with the new token', async () => {
  const payload = { data: [] };
  const state = setup([
    response(401, {}), response(401, {}), refreshed(),
    response(200, payload), response(200, payload)
  ]);
  const results = await Promise.all([state.api.getServers(), state.api.listGroups()]);
  assert.deepEqual(results, [payload, payload]);
  assert.equal(state.calls.filter(call => call.path === '/api/auth/refresh').length, 1);
  assert.equal(state.calls.length, 5);
  for (const call of state.calls.slice(3)) {
    assert.equal(call.options.headers.Authorization, 'Bearer new-access');
  }
  assert.equal(state.loginCount, 0);
  assert.equal(state.local.get('sms_rt'), 'new-refresh');
});

test('an unauthorized request shares a refresh already started by the timer', async () => {
  const pending = deferred();
  const payload = { data: [] };
  const state = setup([pending.promise, response(401, {}), response(200, payload)]);
  const timer = state.fireTimer();
  const request = state.api.getServers();
  const completion = Promise.allSettled([timer, request]);
  // Allow the 401 handler to run while the refresh response is still pending.
  await new Promise(resolve => setImmediate(resolve));
  const callsWhileRefreshing = state.calls.length;
  pending.resolve(refreshed());
  const results = await completion;
  assert.equal(callsWhileRefreshing, 2);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled']);
  assert.deepEqual(results[1].value, payload);
  assert.equal(state.calls.length, 3);
  assert.equal(state.calls[2].options.headers.Authorization, 'Bearer new-access');
});

test('a shared refresh failure rejects all callers and permits a later attempt', async () => {
  const payload = { data: [] };
  const state = setup([
    response(401, {}), response(401, {}), response(503, {}),
    response(401, {}), refreshed(), response(200, payload)
  ]);
  const results = await Promise.allSettled([state.api.getServers(), state.api.listGroups()]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /HTTP 503/);
  }
  assert.equal(state.calls.length, 3);
  assertSessionPreserved(state);
  assert.deepEqual(await state.api.getServers(), payload);
  assert.equal(state.calls.length, 6);
  assert.equal(state.local.get('sms_rt'), 'new-refresh');
});

test('concurrent requests with an expired refresh token show login only once', async () => {
  const state = setup([response(401, {}), response(401, {}), response(401, {})]);
  const results = await Promise.allSettled([state.api.getServers(), state.api.listGroups()]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /Unauthenticated/);
  }
  assert.equal(state.calls.length, 3);
  assert.equal(state.loginCount, 1);
  assert.equal(state.session.size, 0);
  assert.equal(state.local.size, 0);
  assert.equal(state.timers.size, 0);
});

for (const stage of ['response', 'json']) {
  test(`refresh ${stage} arriving after logout cannot restore the session`, async () => {
    const pending = deferred();
    const started = deferred();
    const refresh = stage === 'response' ? pending.promise : {
      status: 200, ok: true,
      json() { started.resolve(); return pending.promise; }
    };
    const state = setup([refresh, response(204, null)]);
    const timer = state.fireTimer();
    if (stage === 'json') await started.promise;
    await state.api.logout();
    assert.equal(state.api.isLoggedIn(), false);
    pending.resolve(stage === 'response' ? refreshed() : await refreshed().json());
    await timer;
    assert.equal(state.api.isLoggedIn(), false);
    assert.equal(state.session.size, 0);
    assert.equal(state.local.size, 0);
    assert.equal(state.timers.size, 0);
    assert.equal(state.loginCount, 0);
    assert.equal(state.calls.length, 2);
  });
}

for (const status of [200, 401, 503]) {
  test(`old refresh HTTP ${status} cannot change a newly logged-in session`, async () => {
    const pending = deferred();
    const state = setup([pending.promise, response(204, null), response(200, {
      data: { access_token: 'other-access', refresh_token: 'other-refresh' }
    })]);
    const timer = state.fireTimer();
    await state.api.logout();
    await state.api.login('other-user', 'synthetic-password');
    const newTimer = [...state.timers.entries()];
    pending.resolve(status === 200 ? refreshed() : response(status, {}));
    await timer;
    assert.equal(state.api.isLoggedIn(), true);
    assert.equal(state.session.get('sms_at'), 'other-access');
    assert.equal(state.local.get('sms_rt'), 'other-refresh');
    assert.deepEqual([...state.timers.entries()], newTimer);
    assert.equal(state.loginCount, 0);
    assert.equal(state.calls.length, 3);
  });
}

test('a request awaiting refresh is not retried after logout', async () => {
  const pending = deferred();
  const state = setup([response(401, {}), pending.promise, response(204, null)]);
  const request = state.api.getServers();
  const rejected = assert.rejects(request, /Session changed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.calls[1].path, '/api/auth/refresh');
  await state.api.logout();
  pending.resolve(refreshed());
  await rejected;
  assert.equal(state.calls.length, 3);
  assert.equal(state.api.isLoggedIn(), false);
  assert.equal(state.timers.size, 0);
});

test('new session refresh stays shared when the old refresh finishes', async () => {
  const oldRefresh = deferred();
  const newRefresh = deferred();
  const payload = { data: [] };
  const state = setup([
    oldRefresh.promise, response(204, null), refreshed(), newRefresh.promise,
    response(401, {}), response(200, payload)
  ]);
  const oldTimer = state.fireTimer();
  await state.api.logout();
  await state.api.login('other-user', 'synthetic-password');
  const newTimer = state.fireTimer();
  assert.equal(state.calls.length, 4, 'new session must start its own refresh');
  oldRefresh.resolve(response(401, {}));
  await oldTimer;
  const request = state.api.getServers();
  const completion = Promise.allSettled([newTimer, request]);
  await new Promise(resolve => setImmediate(resolve));
  const callsWhileRefreshing = state.calls.length;
  newRefresh.resolve(response(200, {
    data: { access_token: 'latest-access', refresh_token: 'latest-refresh' }
  }));
  const results = await completion;
  assert.equal(callsWhileRefreshing, 5, 'request must share the new pending refresh');
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled']);
  assert.deepEqual(results[1].value, payload);
  assert.equal(state.calls.length, 6);
  assert.equal(state.calls[5].options.headers.Authorization, 'Bearer latest-access');
  assert.equal(state.session.get('sms_at'), 'latest-access');
  assert.equal(state.local.get('sms_rt'), 'latest-refresh');
  assert.equal(state.timers.size, 1);
  assert.equal(state.loginCount, 0);
});

for (const operation of ['assignGroup', 'uploadPackage']) {
  test(`a late 401 cannot retry ${operation} under a newly logged-in user`, async () => {
    const late = deferred();
    const state = setup([
      late.promise, response(204, null), refreshed(), response(204, null)
    ]);
    const request = operation === 'assignGroup'
      ? state.api.assignGroup('server-1', 'group-1')
      : state.api.uploadPackage(new FormData());
    const rejected = assert.rejects(request, /Session changed/);
    await state.api.logout();
    await state.api.login('other-user', 'synthetic-password');
    const newTimer = [...state.timers.entries()];
    late.resolve(response(401, {}));
    await rejected;
    assert.equal(state.calls.length, 3, 'do not refresh or retry the old operation');
    assert.equal(state.calls[0].options.headers.Authorization, 'Bearer old-access');
    assert.equal(state.session.get('sms_at'), 'new-access');
    assert.equal(state.local.get('sms_rt'), 'new-refresh');
    assert.deepEqual([...state.timers.entries()], newTimer);
    assert.equal(state.loginCount, 0);
  });
}

test('a late 401 after logout does not reopen login or retry the operation', async () => {
  const late = deferred();
  const state = setup([late.promise, response(204, null)]);
  const request = state.api.assignGroup('server-1', 'group-1');
  const rejected = assert.rejects(request, /Session changed/);
  await state.api.logout();
  late.resolve(response(401, {}));
  await rejected;
  assert.equal(state.calls.length, 2);
  assert.equal(state.api.isLoggedIn(), false);
  assert.equal(state.session.size, 0);
  assert.equal(state.local.size, 0);
  assert.equal(state.timers.size, 0);
  assert.equal(state.loginCount, 0);
});

test('a late 401 for an old access token retries without refreshing again', async () => {
  const late = deferred();
  const payload = { data: [] };
  const state = setup([
    response(401, {}), late.promise, refreshed(),
    response(200, payload), response(200, payload)
  ]);
  const first = state.api.getServers();
  const second = state.api.listGroups();
  await first;
  late.resolve(response(401, {}));
  assert.deepEqual(await second, payload);
  assert.equal(state.calls.filter(call => call.path === '/api/auth/refresh').length, 1);
  assert.equal(state.calls[4].options.headers.Authorization, 'Bearer new-access');
  assert.equal(state.local.get('sms_rt'), 'new-refresh');
  assert.equal(state.loginCount, 0);
});
