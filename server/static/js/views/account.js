'use strict';

// Personal security is available to every role, independently of admin settings.
Views.Account = (() => {
  let generation = 0;
  let loading = 0;
  let busy = false;
  let passwordBusy = false;
  let loaded = false;
  let sessions = [];
  const node = id => document.getElementById(id);
  const live = (version, root) => generation === version && root && node('account-security') === root;
  const esc = value => App.escHtml(String(value ?? ''));
  const date = value => {
    const time = new Date(value);
    return value && Number.isFinite(time.getTime()) ? time.toLocaleString() : 'Unavailable';
  };

  function markup(user) {
    generation++; loading++; busy = false; passwordBusy = false; loaded = false; sessions = [];
    return `<section id="account-security" class="card account-security mb-2" aria-labelledby="account-title">
      <header class="account-header">
      <div class="eyebrow">Personal security</div>
      <h3 id="account-title">Your account & sessions</h3>
      <p class="text-muted">Signed in as <strong>${esc(user.username)}</strong> · ${esc(user.role)}</p>
      </header><div class="account-layout"><div class="account-sessions-pane">
      <div class="account-session-heading"><div><h4>Active sessions</h4>
        <p id="sessions-summary" class="text-muted" aria-live="polite">Loading your sessions…</p></div>
        <button id="sessions-refresh" class="btn btn-sm" onclick="Views.Account.load()">Refresh</button></div>
      <p class="text-muted">Sessions expire 7 days after sign-in. Last refresh is a token renewal, not proof that a device is online. Browser descriptions are supplied by the client.</p>
      <div id="sessions-list" aria-busy="true" tabindex="0" role="region" aria-label="Your active sessions"><span class="spinner"></span></div>
      <p id="sessions-feedback" role="status" aria-live="polite"></p>
      <button id="sessions-revoke" class="btn btn-sm" disabled aria-expanded="false" aria-controls="sessions-confirm" onclick="Views.Account.confirmRevoke()">Sign out other sessions</button>
      <div id="sessions-confirm" class="integration-secret" hidden onkeydown="if (event.key === 'Escape') { event.stopPropagation(); Views.Account.cancelRevoke(); }">
        <p>Sign out every other session of your account? This session stays signed in. Other sessions will lose access on their next request.</p>
        <div class="account-actions"><button id="sessions-confirm-button" class="btn btn-danger btn-sm" onclick="Views.Account.revoke()">Confirm sign out</button>
          <button id="sessions-cancel" class="btn btn-sm" onclick="Views.Account.cancelRevoke()">Keep sessions</button></div>
      </div></div>
      <form class="account-password" onsubmit="event.preventDefault(); Views.Account.changePassword()">
        <h4>Change password</h4><p id="password-help" class="text-muted">A successful change signs out all sessions, including this one. Use 8–72 bytes; LDAP passwords are managed by your directory.</p>
        <fieldset id="account-password-fields" aria-describedby="password-help">
          <div class="form-group"><label for="current-password">Current password</label><input type="password" id="current-password" autocomplete="current-password" required></div>
          <div class="account-password-grid"><div class="form-group"><label for="new-account-password">New password</label><input type="password" id="new-account-password" autocomplete="new-password" required></div>
          <div class="form-group"><label for="repeat-account-password">Repeat new password</label><input type="password" id="repeat-account-password" autocomplete="new-password" required></div></div>
          <button id="account-password-submit" class="btn btn-primary btn-sm" type="submit">Change password & sign out</button>
        </fieldset><p id="account-password-feedback" role="status" aria-live="polite"></p>
      </form></div></section>`;
  }

  function controls() {
    if (!node('account-security')) return;
    node('sessions-refresh').disabled = busy;
    // The server revokes all other sessions, including entries beyond the display limit.
    node('sessions-revoke').disabled = busy || !loaded;
    node('sessions-confirm-button').disabled = busy;
    node('sessions-cancel').disabled = busy;
    node('sessions-list').setAttribute('aria-busy', String(busy));
  }

  function paint() {
    node('sessions-summary').textContent = `${sessions.length} active session${sessions.length === 1 ? '' : 's'} shown · up to 100 newest`;
    node('sessions-list').innerHTML = sessions.length ? sessions.map(item => `<article class="account-session ${item.current ? 'account-session-current' : ''}">
      <div class="account-session-heading"><strong>${item.current ? 'This session' : 'Other session'}</strong>${item.current ? '<span class="badge badge-success">Current</span>' : ''}</div>
      <p class="account-user-agent">${esc(item.user_agent || 'Browser description unavailable')}</p>
      <dl><div><dt>Signed in</dt><dd>${esc(date(item.created_at))}</dd></div><div><dt>Last refresh</dt><dd>${esc(date(item.refreshed_at))}</dd></div><div><dt>Expires</dt><dd>${esc(date(item.expires_at))}</dd></div></dl>
    </article>`).join('') : '<p class="account-session-empty">No active sessions returned. Refresh the list to check your current sign-in.</p>';
  }

  async function load() {
    if (busy) return;
    const version = generation, request = ++loading, root = node('account-security');
    if (!root) return;
    busy = true; loaded = false; controls();
    node('sessions-feedback').textContent = '';
    node('sessions-confirm').hidden = true;
    node('sessions-revoke').setAttribute('aria-expanded', 'false');
    try {
      const response = await API.listSessions();
      if (!live(version, root) || request !== loading) return;
      if (!Array.isArray(response?.data)) throw new Error('Invalid sessions response');
      sessions = response.data; loaded = true; paint();
    } catch {
      if (!live(version, root) || request !== loading) return;
      sessions = []; node('sessions-summary').textContent = 'Session list unavailable';
      node('sessions-list').innerHTML = '';
      node('sessions-feedback').textContent = 'Could not load sessions. Refresh to retry.';
    } finally {
      if (live(version, root) && request === loading) { busy = false; controls(); }
    }
  }

  function confirmRevoke() {
    if (busy || !loaded || !node('account-security')) return;
    node('sessions-revoke').setAttribute('aria-expanded', 'true');
    node('sessions-confirm').hidden = false; node('sessions-confirm-button').focus();
  }
  function cancelRevoke() {
    if (busy || !node('account-security')) return;
    node('sessions-revoke').setAttribute('aria-expanded', 'false');
    node('sessions-confirm').hidden = true; node('sessions-revoke').focus();
  }
  async function revoke() {
    const version = generation, root = node('account-security');
    if (!root || busy || !loaded || node('sessions-confirm').hidden) return;
    busy = true; controls(); node('sessions-feedback').textContent = 'Signing out other sessions…';
    try {
      const response = await API.revokeOtherSessions();
      if (!live(version,root)) return;
      if (!Number.isInteger(response?.data?.revoked) || response.data.revoked < 0) throw new Error('Invalid revocation response');
      node('sessions-confirm').hidden = true;
      busy = false; await load();
      if (!live(version,root)) return;
      node('sessions-feedback').textContent = `${response.data.revoked} other session(s) signed out.${loaded ? ' This session stays signed in.' : ' Refresh to reload the list.'}`;
      node(loaded ? 'sessions-revoke' : 'sessions-refresh').focus();
    } catch {
      if (live(version,root)) node('sessions-feedback').textContent = 'Could not confirm sign out. Your other sessions may still be active. Retry or refresh.';
    } finally {
      if (live(version,root)) { busy = false; controls(); }
    }
  }

  async function changePassword() {
    const version = generation, root = node('account-security');
    if (!root || passwordBusy) return;
    const current = node('current-password').value, password = node('new-account-password').value;
    const feedback = node('account-password-feedback');
    if (!current || !password || password !== node('repeat-account-password').value) { feedback.textContent = 'Fill all fields and make sure the new passwords match.'; return; }
    const bytes = new TextEncoder().encode(password).length;
    if (bytes < 8 || bytes > 72) { feedback.textContent = 'New password must contain 8–72 bytes (some characters use several bytes).'; return; }
    passwordBusy = true; node('account-password-fields').disabled = true; feedback.textContent = 'Changing password…';
    try {
      await API.changePassword({current_password: current, new_password: password});
      // API clears credentials only if this is still the session that submitted.
      if (live(version,root)) {
        clearPasswords(); feedback.textContent = 'Password changed. Sign in with your new password.';
      }
    } catch {
      if (live(version,root)) feedback.textContent = 'Password change could not be confirmed. Check your current password and retry. If your session expired, sign in again.';
    } finally {
      if (live(version,root)) { passwordBusy = false; node('account-password-fields').disabled = false; }
    }
  }

  function clearPasswords() {
    for (const id of ['current-password','new-account-password','repeat-account-password']) { if (node(id)) node(id).value = ''; }
  }
  function leave() { generation++; loading++; clearPasswords(); }
  return {markup,load,confirmRevoke,cancelRevoke,revoke,changePassword,leave};
})();
