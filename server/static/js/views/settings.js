'use strict';

Views.Settings = (() => {
  let groups = [];
  let users = [];
  let tokens = [];
  let tokenLoadVersion = 0;
  let tokenBusy = false;
  let tokenLoaded = false;
  let tokenRevokeID = null;
  let permissionCatalog = [];
  let ldapSettings = {};
  let ldapGroupMappings = [];
  let smtpSettings = {};
  let renderVersion = 0;
  let groupLoadVersion = 0;
  let requirementVersion = 0;
  let requirementGroup = null;
  let requirementReady = false;
  let requirementBusy = false;
  let requirementSaved = [];
  let groupBusy = false;
  let deleteGroupID = null;

  async function render(container) {
    const version = ++renderVersion;
    groups = [];
    requirementGroup = null;
    requirementReady = false;
    requirementBusy = false;
    groupBusy = false;
    deleteGroupID = null;
    tokens = [];
    tokenBusy = false;
    tokenLoaded = false;
    tokenRevokeID = null;
    const user = API.getUser() || { permissions: [] };
    container.innerHTML = `
      <div class="page-header"><div><div class="eyebrow">Workspace configuration</div><h2>Settings</h2>
        <p class="page-subtitle">Manage access and connect your identity and alerting services.</p></div></div>
      <div id="settings-load-status" role="status" aria-live="polite"></div>
      ${Views.Account.markup(user)}
      <div class="grid-2 settings-layout">
        <div>
          ${hasPermission('users.read') ? renderUsersSection() : ''}
          ${hasPermission('groups.read') ? renderGroupsSection() : ''}
          ${hasPermission('tokens.read') ? renderTokensSection() : ''}
        </div>
        <div>
          ${hasPermission('settings.read') ? renderLDAPSection() : ''}
          ${hasPermission('settings.read') ? renderSMTPSection() : ''}
          ${hasPermission('groups.read') ? renderRequiredAgentsSection() : ''}
        </div>
      </div>
    `;

    await Promise.all([
      Views.Account.load(),
      hasPermission('groups.read') ? loadGroups() : Promise.resolve(),
      hasPermission('tokens.read') ? loadTokens() : Promise.resolve(),
      loadAll().catch(() => {
        if (version !== renderVersion) return;
        const status = document.getElementById('settings-load-status');
        if (status) status.textContent = 'Some account or access settings could not be loaded. Reopen Settings to retry.';
      }),
      hasPermission('settings.read') ? loadIntegration('ldap') : Promise.resolve(),
      hasPermission('settings.read') ? loadIntegration('smtp') : Promise.resolve()
    ]);
  }

  function renderUsersSection() {
    return `
      <div class="card mb-2">
        <div class="section-title">Users & Permissions</div>
        <div id="users-list" class="mb-2"><span class="spinner"></span></div>
        ${hasPermission('users.write') ? `
          <div class="form-row">
            <div class="form-group"><label>Username</label><input type="text" id="new-username" placeholder="Username"></div>
            <div class="form-group"><label>Email</label><input type="email" id="new-email" placeholder="Email"></div>
            <div class="form-group"><label>Password</label><input type="password" id="new-password" placeholder="Password"></div>
            <div class="form-group"><label>Role</label>
              <select id="new-role">
                <option value="readonly">Readonly</option>
                <option value="operator">Operator</option>
                <option value="admin">Admin</option>
              </select>
            </div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="Views.Settings.createUser()">Add User</button>
        ` : ''}
      </div>
    `;
  }

  function renderGroupsSection() {
    return `
      <section id="groups-root" class="card mb-2 integration-card groups-card" aria-labelledby="groups-title">
        <div class="integration-heading"><div><div class="eyebrow">Access boundaries</div><h3 id="groups-title">Server groups</h3></div>
          <button id="groups-refresh" class="btn btn-sm" onclick="Views.Settings.loadGroups()">Refresh</button></div>
        <p class="page-subtitle">Organize hosts and define security requirements. Only groups in your current access scope appear here.</p>
        <div id="groups-feedback" class="integration-feedback" role="status" aria-live="polite"></div>
        <div id="groups-list" class="mb-2" aria-busy="true"><span class="spinner"></span></div>
        ${canCreateGroup() ? `<form onsubmit="event.preventDefault(); Views.Settings.createGroup()"><fieldset id="group-create-fields">
          <div class="integration-fields">
            <div><label for="new-group-name">Group name</label><input id="new-group-name" maxlength="100" required placeholder="Group name"></div>
            <div><label for="new-group-desc">Description</label><input id="new-group-desc" maxlength="500" placeholder="Purpose of this group"></div>
          </div><button class="btn btn-primary btn-sm mt-1" type="submit">Create group</button></fieldset></form>`
          : `<p class="text-muted">${hasPermission('groups.write') ? 'Creating groups requires global access. You can edit requirements for your assigned groups.' : 'Read-only access. Changes require groups.write.'}</p>`}
        <div id="group-delete-panel" class="integration-secret" hidden onkeydown="if(event.key==='Escape') Views.Settings.cancelGroupDelete()">
          <p id="group-delete-description"></p><p>Deletion is blocked while servers, account scopes or directory mappings reference this group. Review these dependencies first.</p>
          <button id="group-delete-confirm" class="btn btn-danger btn-sm" onclick="Views.Settings.deleteGroup()">Confirm deletion</button>
          <button class="btn btn-sm" onclick="Views.Settings.cancelGroupDelete()">Keep group</button>
        </div>
      </section>
    `;
  }

  function canCreateGroup() {
    const user = API.getUser() || {};
    return hasPermission('groups.write') && (user.role === 'admin' || !user.group_scopes?.length);
  }

  function renderTokensSection() {
    return `
      <section id="tokens-root" class="card mb-2 integration-card tokens-card" aria-labelledby="tokens-title">
        <div class="integration-heading"><div><div class="eyebrow">Agent onboarding</div>
          <h3 id="tokens-title">Registration tokens</h3></div><span class="integration-status">Single use</span></div>
        <p class="page-subtitle">Issue access for one new agent. Revoking a token blocks future registration; it does not disconnect an existing agent.</p>
        <div id="tokens-feedback" class="integration-feedback" role="status" aria-live="polite"></div>
        ${hasPermission('tokens.write') ? `
          <form onsubmit="event.preventDefault(); Views.Settings.createToken()">
            <fieldset id="tokens-fields"><div class="integration-fields">
              <div><label for="new-token-note">Purpose / host (optional)</label><input id="new-token-note" maxlength="200" placeholder="Describe the planned installation"></div>
              <div><label for="new-token-ttl">Valid for</label><select id="new-token-ttl"><option value="24">24 hours</option><option value="1">1 hour</option><option value="168">7 days</option><option value="720">30 days</option></select></div>
            </div><p class="text-muted">The secret is shown once after creation. Keep it private and use it with your agent installer.</p>
            <button class="btn btn-primary" type="submit">Create registration token</button></fieldset>
          </form>
          <div id="token-secret-panel" class="integration-secret" hidden>
            <label for="token-secret">New token — copy before leaving</label>
            <input id="token-secret" readonly autocomplete="off" spellcheck="false" aria-describedby="token-secret-help">
            <p id="token-secret-help">This secret cannot be retrieved later. If lost, revoke it and create another.</p>
            <button type="button" class="btn btn-sm" onclick="Views.Settings.copyToken()">Copy token</button>
            <button type="button" class="btn btn-sm" onclick="Views.Settings.hideToken()">Hide secret</button>
          </div>
          <div id="token-revoke-panel" class="integration-secret" hidden>
            <p id="token-revoke-description"></p>
            <button id="token-revoke-confirm" class="btn btn-danger btn-sm" onclick="Views.Settings.revokeToken()">Confirm revocation</button>
            <button class="btn btn-sm" onclick="Views.Settings.cancelTokenRevoke()">Keep token</button>
          </div>
        ` : '<p class="text-muted">Read-only access. Creating and revoking tokens requires tokens.write.</p>'}
        <div class="tokens-toolbar"><div><label for="tokens-filter">Token history</label><select id="tokens-filter" onchange="Views.Settings.renderTokens()"><option value="all">All states</option><option value="available">Available</option><option value="used">Used</option><option value="expired">Expired</option><option value="revoked">Revoked</option></select></div>
          <button id="tokens-reload" class="btn btn-sm" onclick="Views.Settings.loadTokens()">Refresh</button></div>
        <p id="tokens-summary" class="text-muted" aria-live="polite"></p>
        <div id="tokens-list" aria-busy="true"><span class="spinner"></span></div>
      </section>
    `;
  }

  const integrations = {
    ldap: { title: 'Directory authentication', subtitle: 'LDAP', secret: 'ldap_bind_password',
      fields: ['enabled', 'server_url', 'bind_dn', 'base_dn', 'user_filter', 'start_tls', 'default_role'],
      get: () => API.getLDAPSettings(), save: data => API.setLDAPSettings(data) },
    smtp: { title: 'Email alerting', subtitle: 'SMTP', secret: 'smtp_password',
      fields: ['enabled', 'host', 'port', 'username', 'from', 'to'],
      get: () => API.getSMTPSettings(), save: data => API.setSMTPSettings(data) }
  };

  function integrationField(kind, field, label, placeholder = '', options = null) {
    const id = `${kind}-${field.replaceAll('_', '-')}`;
    return `<div class="form-group"><label for="${id}">${label}</label>${options
      ? `<select id="${id}">${options.map(([value, text]) => `<option value="${value}">${text}</option>`).join('')}</select>`
      : `<input type="${field === 'port' ? 'number' : 'text'}" id="${id}" placeholder="${placeholder}">`}</div>`;
  }

  function integrationCard(kind, fields) {
    const spec = integrations[kind];
    return `<section class="card mb-2 integration-card" aria-labelledby="${kind}-title">
      <div class="integration-heading"><div><div class="eyebrow">${spec.subtitle} integration</div>
        <h3 id="${kind}-title">${spec.title}</h3></div><span class="integration-status" id="${kind}-secret-status" role="status">Loading configuration…</span></div>
      <p class="page-subtitle">Saved credentials stay on the server. Choose an explicit action to change them.</p>
      <form onsubmit="event.preventDefault(); Views.Settings.save${kind.toUpperCase()}()" autocomplete="off">
        <fieldset id="${kind}-fields" disabled><legend class="sr-only">${spec.title} settings</legend>
          <div class="integration-fields">${fields}</div>
          <div class="integration-secret">
            <label for="${kind}-secret-action">Saved credential</label>
            <select id="${kind}-secret-action" onchange="Views.Settings.changeSecretAction('${kind}')" aria-describedby="${kind}-secret-help">
              <option value="keep">Keep current credential</option><option value="replace">Replace credential</option><option value="clear">Remove credential</option>
            </select>
            <p id="${kind}-secret-help" class="text-muted">Other changes leave the saved credential untouched.</p>
            <div id="${kind}-secret-replacement" hidden><label for="${kind}-new-secret">New ${kind === 'ldap' ? 'bind password' : 'password / app password'}</label>
              <input type="password" id="${kind}-new-secret" autocomplete="new-password" disabled aria-describedby="${kind}-secret-help"></div>
            <label id="${kind}-secret-confirmation" class="integration-confirm" hidden><input type="checkbox" id="${kind}-confirm-clear"> I understand that removing this credential may stop ${kind === 'ldap' ? 'directory sign-in' : 'email delivery'}.</label>
          </div>
          ${hasPermission('settings.write') ? `<button type="submit" class="btn btn-primary" id="${kind}-save">Save ${spec.subtitle} settings</button>` : '<p class="text-muted">You have read-only access to these settings.</p>'}
        </fieldset>
      </form>
      <div class="integration-feedback" id="${kind}-feedback" role="status" aria-live="polite"></div>
      <button class="btn btn-sm" id="${kind}-retry" hidden onclick="Views.Settings.loadIntegration('${kind}')">Retry loading ${spec.subtitle}</button>
    </section>`;
  }

  function renderLDAPSection() {
    const field = (...args) => integrationField('ldap', ...args);
    return integrationCard('ldap',
      field('enabled', 'Authentication', '', [['false', 'Disabled'], ['true', 'Enabled']]) +
      field('server_url', 'Server URL', 'ldaps://directory.example.test:636') +
      field('bind_dn', 'Bind DN', 'CN=sms-bind,OU=Svc,DC=example,DC=test') +
      field('base_dn', 'Base DN', 'DC=example,DC=test') +
      field('user_filter', 'User filter', '(sAMAccountName=%s)') +
      field('start_tls', 'StartTLS', '', [['false', 'No'], ['true', 'Yes']]) +
      field('default_role', 'Default role', '', [['readonly', 'Readonly'], ['operator', 'Operator'], ['admin', 'Admin']])) + `
      <section class="card mb-2"><div class="section-title">LDAP Group Mappings</div>
        <div id="ldap-group-mappings" class="mb-2"><span class="spinner"></span></div>
        ${hasPermission('settings.write') ? `<div class="form-row">
          <div class="form-group"><label for="ldap-map-dn">LDAP Group DN</label><input type="text" id="ldap-map-dn"></div>
          <div class="form-group"><label for="ldap-map-role">Role</label><select id="ldap-map-role"><option value="readonly">Readonly</option><option value="operator">Operator</option><option value="admin">Admin</option></select></div>
          <div class="form-group"><label for="ldap-map-group">App Group Scope</label><select id="ldap-map-group"><option value="">No scope</option></select></div>
        </div><button class="btn btn-sm" onclick="Views.Settings.createLDAPGroupMapping()">Add LDAP Group Mapping</button>` : ''}
      </section>`;
  }

  function renderSMTPSection() {
    const field = (...args) => integrationField('smtp', ...args);
    return integrationCard('smtp',
      field('enabled', 'Email delivery', '', [['false', 'Disabled'], ['true', 'Enabled']]) +
      field('host', 'Host', 'smtp.example.test') + field('port', 'Port', '587') +
      field('username', 'Username', 'alerts@example.test') + field('from', 'From', 'alerts@example.test') +
      field('to', 'Recipients', 'soc@example.test, admin@example.test'));
  }

  function integrationIsCurrent(kind, feedback) {
    return feedback && feedback.isConnected && document.getElementById(`${kind}-feedback`) === feedback;
  }

  async function loadIntegration(kind) {
    const spec = integrations[kind];
    if (!spec || !hasPermission('settings.read')) return;
    const feedback = document.getElementById(`${kind}-feedback`);
    const fields = document.getElementById(`${kind}-fields`);
    if (!feedback || !fields || fields.dataset.loading === 'true' || fields.dataset.saving === 'true') return;
    fields.dataset.loading = 'true';
    fields.dataset.ready = 'false';
    fields.disabled = true;
    feedback.textContent = 'Loading saved configuration…';
    document.getElementById(`${kind}-retry`).hidden = true;
    try {
      const response = await spec.get();
      if (!integrationIsCurrent(kind, feedback)) return;
      const data = response?.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid configuration response');
      // Store only public fields. Even a stale API response must not fill a password input.
      const settings = {};
      for (const field of spec.fields) {
        const key = `${kind}_${field}`;
        settings[key] = typeof data[key] === 'string' ? data[key] : '';
        setValue(`${kind}-${field.replaceAll('_', '-')}`, settings[key] || (field === 'enabled' || field === 'start_tls' ? 'false' : field === 'default_role' ? 'readonly' : ''));
      }
      settings[`${spec.secret}_configured`] = data[`${spec.secret}_configured`] === 'true';
      if (kind === 'ldap') ldapSettings = settings; else smtpSettings = settings;
      resetSecret(kind);
      fields.dataset.ready = 'true';
      fields.disabled = !hasPermission('settings.write');
      feedback.textContent = hasPermission('settings.write') ? '' : 'Read-only configuration. Credentials are never displayed.';
    } catch (_) {
      if (!integrationIsCurrent(kind, feedback)) return;
      feedback.textContent = 'Could not load this integration. Retry before editing to avoid overwriting saved settings.';
      document.getElementById(`${kind}-secret-status`).textContent = 'Configuration unavailable';
      document.getElementById(`${kind}-retry`).hidden = false;
    } finally {
      fields.dataset.loading = 'false';
    }
  }

  function resetSecret(kind) {
    const spec = integrations[kind];
    const settings = kind === 'ldap' ? ldapSettings : smtpSettings;
    document.getElementById(`${kind}-secret-status`).textContent = settings[`${spec.secret}_configured`] ? 'Credential configured' : 'No credential configured';
    setValue(`${kind}-secret-action`, 'keep');
    setValue(`${kind}-new-secret`, '');
    document.getElementById(`${kind}-confirm-clear`).checked = false;
    changeSecretAction(kind);
  }

  function changeSecretAction(kind) {
    if (!integrations[kind]) return;
    const action = getValue(`${kind}-secret-action`);
    const input = document.getElementById(`${kind}-new-secret`);
    input.value = '';
    input.disabled = action !== 'replace';
    input.required = action === 'replace';
    document.getElementById(`${kind}-secret-replacement`).hidden = action !== 'replace';
    document.getElementById(`${kind}-secret-confirmation`).hidden = action !== 'clear';
    document.getElementById(`${kind}-confirm-clear`).checked = false;
    document.getElementById(`${kind}-secret-help`).textContent = action === 'replace'
      ? 'Enter a new credential. It will only be sent when you save; spaces are preserved.'
      : action === 'clear' ? 'This removes the saved credential when you save. Confirm the impact below.'
      : 'Other changes leave the saved credential untouched.';
  }

  async function saveIntegration(kind) {
    const spec = integrations[kind];
    const fields = document.getElementById(`${kind}-fields`);
    const feedback = document.getElementById(`${kind}-feedback`);
    if (!hasPermission('settings.write') || !fields || fields.disabled || fields.dataset.ready !== 'true') return;
    const action = getValue(`${kind}-secret-action`);
    const secret = document.getElementById(`${kind}-new-secret`).value;
    if (action === 'replace' && !secret) {
      feedback.textContent = 'Enter the replacement credential before saving.';
      document.getElementById(`${kind}-new-secret`).focus();
      return;
    }
    if (action === 'clear' && !document.getElementById(`${kind}-confirm-clear`).checked) {
      feedback.textContent = 'Confirm credential removal before saving.';
      document.getElementById(`${kind}-confirm-clear`).focus();
      return;
    }
    const data = { secret_action: action };
    for (const field of spec.fields) data[`${kind}_${field}`] = getValue(`${kind}-${field.replaceAll('_', '-')}`);
    if (action === 'replace') data[spec.secret] = secret;
    fields.disabled = true;
    fields.dataset.saving = 'true';
    fields.setAttribute('aria-busy', 'true');
    feedback.textContent = 'Saving configuration…';
    try {
      await spec.save(data);
      if (!integrationIsCurrent(kind, feedback)) return;
      const settings = kind === 'ldap' ? ldapSettings : smtpSettings;
      if (action !== 'keep') settings[`${spec.secret}_configured`] = action === 'replace';
      resetSecret(kind);
      feedback.textContent = `${spec.subtitle} settings saved. ${action === 'keep' ? 'Saved credential preserved.' : action === 'replace' ? 'Credential replaced.' : 'Credential removed.'}`;
    } catch (_) {
      if (integrationIsCurrent(kind, feedback)) feedback.textContent = 'Save could not be confirmed. Your entries are retained; retry to apply these settings.';
    } finally {
      fields.dataset.saving = 'false';
      if (integrationIsCurrent(kind, feedback)) {
        fields.disabled = !hasPermission('settings.write');
        fields.setAttribute('aria-busy', 'false');
      }
    }
  }

  function renderRequiredAgentsSection() {
    return `
      <section id="requirements-root" class="card mb-2 integration-card groups-card" aria-labelledby="requirements-title">
        <div class="integration-heading"><div><div class="eyebrow">Security coverage</div><h3 id="requirements-title">Required agents</h3></div><span id="requirements-count" class="integration-status">Choose a group</span></div>
        <p class="page-subtitle">Define the agents expected on every host in a group. Compliance and incoming reports use this saved list; saving does not install software.</p>
        <label for="requirements-group">Server group</label><select id="requirements-group" disabled onchange="Views.Settings.selectRequirementGroup()"><option value="">Loading groups…</option></select>
        <div id="requirements-feedback" class="integration-feedback" role="status" aria-live="polite"></div>
        <form onsubmit="event.preventDefault(); Views.Settings.saveReqAgents()"><fieldset id="requirements-fields" disabled>
          <label for="requirements-names">Required agent names — one per line</label>
          <textarea id="requirements-names" rows="7" maxlength="8192" aria-describedby="requirements-help" oninput="Views.Settings.requirementsChanged()"></textarea>
          <p id="requirements-help" class="text-muted">Use names reported by your agents. Up to 50 names, 100 characters each. Custom names are preserved.</p>
          <label id="requirements-clear-label" class="integration-confirm" hidden><input type="checkbox" id="requirements-clear"> I confirm removing all requirements for this group.</label>
          ${hasPermission('groups.write') ? '<button id="requirements-save" class="btn btn-primary" type="submit">Save requirements</button>' : '<p class="text-muted">Read-only access to saved requirements.</p>'}
        </fieldset></form>
        <button id="requirements-retry" class="btn btn-sm mt-1" hidden onclick="Views.Settings.selectRequirementGroup()">Retry loading requirements</button>
      </section>
    `;
  }

  async function loadAll() {
    const version = renderVersion;
    const tasks = [];
    if (hasPermission('users.read')) tasks.push(API.listUsers()); else tasks.push(Promise.resolve({ data: [] }));
    if (hasPermission('users.read')) tasks.push(API.getPermissionCatalog()); else tasks.push(Promise.resolve({ data: [] }));
    if (hasPermission('settings.read')) tasks.push(API.listLDAPGroupMappings()); else tasks.push(Promise.resolve({ data: [] }));

    const [userResp, permissionResp, ldapMappingsResp] = await Promise.all(tasks);
    if (version !== renderVersion) return;
    users = (userResp && userResp.data) ? userResp.data : [];
    permissionCatalog = (permissionResp && permissionResp.data) ? permissionResp.data : [];
    ldapGroupMappings = (ldapMappingsResp && ldapMappingsResp.data) ? ldapMappingsResp.data : [];

    renderUsers();
    bindLDAPGroups();
    renderLDAPGroupMappings();
  }

  function renderUsers() {
    const el = document.getElementById('users-list');
    if (!el) return;
    if (!users.length) {
      el.innerHTML = '<p class="text-muted">No users</p>';
      return;
    }
    el.innerHTML = users.map((user, index) => `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;padding:.4rem 0;border-bottom:1px solid #2e3347;gap:1rem">
        <div>
          <strong>${App.escHtml(user.username)}</strong>
          <span class="text-muted"> (${App.escHtml(user.role)})</span>
          <span class="text-muted"> - ${App.escHtml(user.email)}</span>
          <div class="text-muted">Auth: ${App.escHtml(user.auth_source || 'local')}</div>
        </div>
        <div style="display:flex;gap:.4rem;flex-wrap:wrap;justify-content:flex-end">
          ${hasPermission('users.write') ? `<button class="btn btn-sm" onclick="Views.Settings.userAction(${index}, 'permissions')">Permissions</button>` : ''}
          ${hasPermission('users.write') ? `<button class="btn btn-sm" onclick="Views.Settings.userAction(${index}, 'scopes')">Scopes</button>` : ''}
          ${hasPermission('users.write') && user.username !== 'admin' ? `<button class="btn btn-sm btn-danger" onclick="Views.Settings.userAction(${index}, 'delete')">Delete</button>` : ''}
        </div>
      </div>
    `).join('');
  }

  function userAction(index, action) {
    if (!hasPermission('users.write') || !Number.isInteger(index)) return;
    const user = users[index];
    if (!user) return;
    // User-controlled names and IDs never become JavaScript source in HTML.
    if (action === 'permissions') return editPermissions(user.id, user.username, user.role);
    if (action === 'scopes') return editScopes(user.id, user.username);
    if (action === 'delete' && user.username !== 'admin') return deleteUser(user.id, user.username);
  }

  function renderGroups() {
    const el = document.getElementById('groups-list');
    if (!el) return;
    if (!groups.length) {
      el.innerHTML = '<p class="text-muted">No groups in your current scope. Create a group below if you have global write access, or ask an administrator to assign one.</p>';
      return;
    }
    el.innerHTML = groups.map((group, index) => `
      <div class="group-row">
        <div>
          <strong>${App.escHtml(group.name)}</strong>
          <span class="text-muted"> (${Number(group.server_count) || 0} servers)</span>
          ${group.description ? `<span class="text-muted"> - ${App.escHtml(group.description)}</span>` : ''}
        </div>
        <div class="page-actions"><button class="btn btn-sm" onclick="Views.Settings.selectRequirementGroup(${index})">Requirements</button>
        ${hasPermission('groups.write') ? `<button class="btn btn-sm btn-danger" onclick="Views.Settings.requestGroupDelete(${index})" aria-controls="group-delete-panel" aria-expanded="${deleteGroupID === group.id}">Delete</button>` : ''}</div>
      </div>
    `).join('');
  }

  function tokenState(token) {
    if (token.revoked_at) return 'revoked';
    if (token.used) return 'used';
    if (token.expires_at && new Date(token.expires_at).getTime() <= Date.now()) return 'expired';
    return 'available';
  }

  function tokenFeedback(message) {
    const el = document.getElementById('tokens-feedback');
    if (el) el.textContent = message;
  }

  function setTokenBusy(busy) {
    tokenBusy = busy;
    for (const id of ['tokens-fields', 'tokens-reload', 'token-revoke-confirm']) {
      const el = document.getElementById(id);
      if (el) el.disabled = busy;
    }
  }

  async function loadTokens() {
    const root = document.getElementById('tokens-root');
    if (!root || !hasPermission('tokens.read')) return;
    const version = ++tokenLoadVersion;
    const isCurrent = () => version === tokenLoadVersion && document.getElementById('tokens-root') === root;
    document.getElementById('tokens-list').setAttribute('aria-busy', 'true');
    try {
      const response = await API.listTokens();
      if (!isCurrent()) return;
      // Never retain a secret accidentally returned by an older server.
      tokens = (Array.isArray(response?.data) ? response.data : []).map(({token, ...metadata}) => metadata);
      tokenLoaded = true;
      renderTokens();
    } catch {
      if (!isCurrent()) return;
      tokens = [];
      tokenLoaded = false;
      renderTokens();
    } finally {
      if (isCurrent()) document.getElementById('tokens-list').setAttribute('aria-busy', 'false');
    }
  }

  function renderTokens() {
    const el = document.getElementById('tokens-list');
    if (!el) return;
    const summary = document.getElementById('tokens-summary');
    if (!tokenLoaded) {
      el.innerHTML = '<p class="error-msg">Token history could not be loaded. Use Refresh to try again.</p>';
      if (summary) summary.textContent = '';
      return;
    }
    const filter = getValue('tokens-filter') || 'all';
    const visible = tokens.map((token, index) => ({token, index, state: tokenState(token)}))
      .filter(item => filter === 'all' || item.state === filter);
    if (summary) summary.textContent = `${visible.length} of ${tokens.length} tokens · ${tokens.filter(t => tokenState(t) === 'available').length} available`;
    if (!visible.length) {
      el.innerHTML = '<p class="text-muted">No tokens match this view. Create a token to register your first agent or choose another filter.</p>';
      return;
    }
    const formatDate = value => value ? new Date(value).toLocaleString() : 'No expiry (legacy)';
    el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Purpose</th><th>State</th><th>Expires</th><th>Action</th></tr></thead><tbody>${visible.map(({token, index, state}) => `
      <tr><td>${App.escHtml(token.note || 'Agent registration')}<div class="text-muted">Created ${App.escHtml(formatDate(token.created_at))}</div></td>
      <td><span class="status ${state === 'available' ? 'status-online' : 'status-unknown'}">${state}</span></td>
      <td>${App.escHtml(formatDate(token.expires_at))}</td><td>${hasPermission('tokens.write') && state === 'available'
        ? `<button class="btn btn-sm" onclick="Views.Settings.requestTokenRevoke(${index})" ${tokenBusy ? 'disabled' : ''}>Revoke</button>` : '—'}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function hideToken() {
    setValue('token-secret', '');
    const panel = document.getElementById('token-secret-panel');
    if (panel) panel.hidden = true;
  }

  async function copyToken() {
    const input = document.getElementById('token-secret');
    if (!input?.value) return;
    try {
      await navigator.clipboard.writeText(input.value);
      if (document.getElementById('token-secret') === input) tokenFeedback('Token copied. Store it securely; it will not be shown again.');
    } catch {
      if (document.getElementById('token-secret') !== input) return;
      input.focus(); input.select();
      tokenFeedback('Clipboard unavailable. Copy the selected token manually.');
    }
  }

  function requestTokenRevoke(index) {
    if (tokenBusy || !hasPermission('tokens.write') || !Number.isInteger(index)) return;
    const token = tokens[index];
    if (!token || tokenState(token) !== 'available') return;
    tokenRevokeID = token.id;
    document.getElementById('token-revoke-description').textContent = `Revoke access for “${token.note || 'Agent registration'}”? This cannot be undone.`;
    document.getElementById('token-revoke-panel').hidden = false;
    document.getElementById('token-revoke-confirm').focus();
  }

  function cancelTokenRevoke() {
    if (tokenBusy) return;
    tokenRevokeID = null;
    const panel = document.getElementById('token-revoke-panel');
    if (panel) panel.hidden = true;
  }

  async function revokeToken() {
    if (tokenBusy || !tokenRevokeID || !hasPermission('tokens.write')) return;
    const root = document.getElementById('tokens-root');
    const id = tokenRevokeID;
    setTokenBusy(true);
    try {
      await API.revokeToken(id);
      if (document.getElementById('tokens-root') !== root) return;
      tokenRevokeID = null;
      document.getElementById('token-revoke-panel').hidden = true;
      hideToken();
      tokenFeedback('Token revoked. It can no longer register an agent.');
      await loadTokens();
    } catch {
      if (document.getElementById('tokens-root') === root) tokenFeedback('Could not revoke the token. Refresh its state before retrying.');
    } finally {
      if (document.getElementById('tokens-root') === root) { setTokenBusy(false); renderTokens(); }
    }
  }

  function bindLDAPGroups() {
    const groupSelect = document.getElementById('ldap-map-group');
    if (groupSelect) {
      groupSelect.innerHTML = '<option value="">No scope</option>' + groups.map(group =>
        `<option value="${group.id}">${App.escHtml(group.name)}</option>`).join('');
    }
  }

  function setValue(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value;
  }

  async function loadGroups() {
    const root = document.getElementById('groups-root');
    if (!root || !hasPermission('groups.read') || groupBusy || requirementBusy) return;
    const version = ++groupLoadVersion;
    const current = () => document.getElementById('groups-root') === root && version === groupLoadVersion;
    document.getElementById('groups-list').setAttribute('aria-busy', 'true');
    document.getElementById('groups-feedback').textContent = 'Loading groups…';
    try {
      const response = await API.listGroups();
      if (!current()) return;
      if (!Array.isArray(response?.data)) throw new Error('Invalid groups');
      groups = response.data;
      renderGroups();
      bindLDAPGroups();
      const select = document.getElementById('requirements-group');
      const previous = requirementGroup;
      select.innerHTML = '<option value="">Choose a group</option>' + groups.map((g, index) => `<option value="${index}">${App.escHtml(g.name)}</option>`).join('');
      select.disabled = !groups.length;
      const index = groups.findIndex(g => g.id === previous);
      select.value = index < 0 ? '' : String(index);
      // Keep unsaved entries when refreshing the directory, but discard a lost scope.
      if (index < 0) await selectRequirementGroup();
      document.getElementById('groups-feedback').textContent = `${groups.length} groups in your current scope.`;
    } catch {
      if (!current()) return;
      groups = [];
      ++requirementVersion;
      requirementReady = false;
      requirementGroup = null;
      document.getElementById('groups-list').innerHTML = '';
      document.getElementById('groups-feedback').textContent = 'Groups could not be loaded. Use Refresh to retry.';
      document.getElementById('requirements-group').disabled = true;
      document.getElementById('requirements-group').innerHTML = '<option value="">Groups unavailable</option>';
      document.getElementById('requirements-fields').disabled = true;
      document.getElementById('requirements-names').value = '';
      document.getElementById('requirements-count').textContent = 'Unavailable';
      document.getElementById('requirements-feedback').textContent = 'Refresh the group list before editing.';
    } finally {
      if (current()) document.getElementById('groups-list').setAttribute('aria-busy', 'false');
    }
  }

  async function selectRequirementGroup(index) {
    if (requirementBusy || !hasPermission('groups.read')) return;
    const root = document.getElementById('requirements-root');
    if (!root) return;
    const select = document.getElementById('requirements-group');
    if (Number.isInteger(index) && groups[index]) select.value = String(index);
    const selected = select.value === '' ? null : groups[Number(select.value)];
    const version = ++requirementVersion;
    requirementGroup = selected?.id || null;
    requirementReady = false;
    requirementSaved = [];
    const fields = document.getElementById('requirements-fields');
    fields.disabled = true;
    fields.setAttribute('aria-busy', selected ? 'true' : 'false');
    setValue('requirements-names', '');
    document.getElementById('requirements-clear-label').hidden = true;
    document.getElementById('requirements-clear').checked = false;
    document.getElementById('requirements-retry').hidden = true;
    document.getElementById('requirements-count').textContent = selected ? 'Loading…' : 'Choose a group';
    const feedback = document.getElementById('requirements-feedback');
    feedback.textContent = selected ? 'Loading saved requirements…' : 'Select a group to inspect its saved requirements.';
    if (!selected) return;
    const current = () => document.getElementById('requirements-root') === root && version === requirementVersion;
    try {
      const response = await API.getRequiredAgents(selected.id);
      if (!current()) return;
      const data = response?.data;
      if (data?.group_id !== selected.id || !Array.isArray(data.agents) || data.agents.some(name => typeof name !== 'string')) throw new Error('Invalid requirements');
      requirementSaved = [...data.agents];
      setValue('requirements-names', data.agents.join('\n'));
      requirementReady = true;
      fields.disabled = !hasPermission('groups.write');
      document.getElementById('requirements-count').textContent = `${data.agents.length} required`;
      feedback.textContent = data.agents.length ? 'Saved requirements loaded.' : 'No agents are required for this group yet. This does not mean its hosts are compliant.';
      if (Number.isInteger(index)) document.getElementById('requirements-group').focus();
    } catch {
      if (!current()) return;
      feedback.textContent = 'Requirements could not be loaded. Retry before editing; saved settings have not been changed.';
      document.getElementById('requirements-count').textContent = 'Unavailable';
      document.getElementById('requirements-retry').hidden = false;
    } finally {
      if (current()) fields.setAttribute('aria-busy', 'false');
    }
  }

  function requirementNames() {
    return [...new Set(getValue('requirements-names').split(/\r?\n/).map(name => name.trim()).filter(Boolean))];
  }

  function requirementsChanged() {
    if (!requirementReady || requirementBusy) return;
    const names = requirementNames();
    document.getElementById('requirements-clear-label').hidden = names.length > 0 || !requirementSaved.length;
    document.getElementById('requirements-clear').checked = false;
    document.getElementById('requirements-count').textContent = `${names.length} in draft`;
    document.getElementById('requirements-feedback').textContent = 'Unsaved changes. Save to apply this list to the selected group.';
  }

  function renderLDAPGroupMappings() {
    const el = document.getElementById('ldap-group-mappings');
    if (!el) return;
    if (!ldapGroupMappings.length) {
      el.innerHTML = '<p class="text-muted">No LDAP mappings configured</p>';
      return;
    }
    el.innerHTML = ldapGroupMappings.map(item => `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;padding:.4rem 0;border-bottom:1px solid #2e3347;gap:1rem">
        <div>
          <strong>${App.escHtml(item.ldap_group_dn)}</strong>
          <div class="text-muted">Role: ${App.escHtml(item.role)}${item.group_name ? ` | Scope: ${App.escHtml(item.group_name)}` : ''}</div>
        </div>
        ${hasPermission('settings.write') ? `<button class="btn btn-sm btn-danger" onclick="Views.Settings.deleteLDAPGroupMapping('${item.id}')">Delete</button>` : ''}
      </div>
    `).join('');
  }

  async function editPermissions(userID, username, role) {
    try {
      const resp = await API.getUserPermissions(userID);
      const current = new Set(((resp && resp.data && resp.data.permissions) ? resp.data.permissions : []));
      const defaults = new Set(((resp && resp.data && resp.data.defaults) ? resp.data.defaults : []));
      App.showModal(`Permissions: ${username}`, `
        <div class="text-muted mb-1">Default permissions come from role <strong>${App.escHtml(role)}</strong>. Additional permissions below are additive.</div>
        <div class="report-scroll-table">
          ${permissionCatalog.map(permission => `
            <label style="display:flex;align-items:center;justify-content:space-between;padding:.35rem 0;border-bottom:1px solid rgba(255,255,255,.05)">
              <span>${App.escHtml(permission)}${defaults.has(permission) ? ' <span class="text-muted">(role default)</span>' : ''}</span>
              <input type="checkbox" class="user-permission-cb" value="${permission}" ${current.has(permission) ? 'checked' : ''} ${defaults.has(permission) ? 'disabled' : ''}>
            </label>
          `).join('')}
        </div>
      `, async () => {
        const selected = [];
        document.querySelectorAll('.user-permission-cb').forEach(cb => {
          if (cb.checked && !cb.disabled) selected.push(cb.value);
        });
        await API.setUserPermissions(userID, selected);
        alert('Permissions saved');
      }, { size: 'wide', cancelLabel: 'Close' });
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function editScopes(userID, username) {
    try {
      const resp = await API.getUserScopes(userID);
      const current = new Set(((resp && resp.data && resp.data.group_ids) ? resp.data.group_ids : []));
      App.showModal(`Group Scope: ${username}`, `
        <div class="text-muted mb-1">If no groups are selected, the user has global visibility. Once groups are selected, views are restricted to those groups.</div>
        <div class="report-scroll-table">
          ${groups.map(group => `
            <label style="display:flex;align-items:center;justify-content:space-between;padding:.35rem 0;border-bottom:1px solid rgba(255,255,255,.05)">
              <span>${App.escHtml(group.name)}</span>
              <input type="checkbox" class="user-scope-cb" value="${group.id}" ${current.has(group.id) ? 'checked' : ''}>
            </label>
          `).join('')}
        </div>
      `, async () => {
        const selected = [];
        document.querySelectorAll('.user-scope-cb').forEach(cb => {
          if (cb.checked) selected.push(cb.value);
        });
        await API.setUserScopes(userID, selected);
        alert('Scopes saved');
      }, { size: 'wide', cancelLabel: 'Close' });
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function saveLDAP() {
    return saveIntegration('ldap');
  }

  async function createLDAPGroupMapping() {
    const ldap_group_dn = getValue('ldap-map-dn');
    const role = getValue('ldap-map-role');
    const group_id = getValue('ldap-map-group');
    if (!ldap_group_dn || !role) {
      alert('LDAP group DN and role are required');
      return;
    }
    try {
      await API.createLDAPGroupMapping({ ldap_group_dn, role, group_id });
      setValue('ldap-map-dn', '');
      setValue('ldap-map-group', '');
      await loadAll();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function deleteLDAPGroupMapping(id) {
    if (!confirm('Delete this LDAP mapping?')) return;
    try {
      await API.deleteLDAPGroupMapping(id);
      await loadAll();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function saveSMTP() {
    return saveIntegration('smtp');
  }

  function getValue(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }

  function hasPermission(permission) {
    const user = API.getUser();
    if (!user) return false;
    if (user.role === 'admin') return true;
    return Array.isArray(user.permissions) && user.permissions.includes(permission);
  }

  async function createUser() {
    const username = getValue('new-username');
    const email = getValue('new-email');
    const password = document.getElementById('new-password') ? document.getElementById('new-password').value : '';
    const role = getValue('new-role');
    if (!username || !email || !password) {
      alert('All fields required');
      return;
    }
    try {
      await API.createUser({ username, email, password, role, permissions: [] });
      await loadAll();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function deleteUser(id, username) {
    if (!confirm(`Delete user ${username}?`)) return;
    try {
      await API.deleteUser(id);
      await loadAll();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  function setGroupBusy(value) {
    groupBusy = value;
    for (const id of ['group-create-fields', 'groups-refresh', 'group-delete-confirm']) {
      const node = document.getElementById(id);
      if (node) node.disabled = value;
    }
  }

  async function createGroup() {
    if (!canCreateGroup() || groupBusy) return;
    const root = document.getElementById('groups-root');
    if (!root) return;
    const name = getValue('new-group-name').trim();
    const description = getValue('new-group-desc').trim();
    const feedback = document.getElementById('groups-feedback');
    if (!name || [...name].length > 100 || [...description].length > 500) { feedback.textContent = 'Provide a name up to 100 characters and a description up to 500.'; return; }
    setGroupBusy(true);
    ++groupLoadVersion;
    try {
      const response = await API.createGroup({name, description});
      if (document.getElementById('groups-root') !== root) return;
      if (!response?.data?.id) throw new Error('Unconfirmed group');
      setValue('new-group-name', ''); setValue('new-group-desc', '');
      setGroupBusy(false);
      await loadGroups();
    } catch {
      if (document.getElementById('groups-root') === root) feedback.textContent = 'Creation could not be confirmed. Refresh the list before retrying; your entries are retained.';
    } finally {
      if (document.getElementById('groups-root') === root) setGroupBusy(false);
    }
  }

  function requestGroupDelete(index) {
    if (groupBusy || !hasPermission('groups.write') || !Number.isInteger(index) || !groups[index]) return;
    deleteGroupID = groups[index].id;
    document.getElementById('group-delete-description').textContent = `Delete “${groups[index].name}” and its requirements?`;
    document.getElementById('group-delete-panel').hidden = false;
    renderGroups();
    document.getElementById('group-delete-confirm').focus();
  }

  function cancelGroupDelete() {
    if (groupBusy) return;
    deleteGroupID = null;
    document.getElementById('group-delete-panel').hidden = true;
    renderGroups();
    document.getElementById('groups-refresh').focus();
  }

  async function deleteGroup() {
    if (groupBusy || !deleteGroupID || !hasPermission('groups.write')) return;
    const root = document.getElementById('groups-root');
    const id = deleteGroupID;
    if (!root) return;
    setGroupBusy(true);
    ++groupLoadVersion;
    try {
      const response = await API.deleteGroup(id);
      if (document.getElementById('groups-root') !== root) return;
      if (response?.data?.status !== 'deleted') throw new Error('Unconfirmed deletion');
      setGroupBusy(false);
      cancelGroupDelete();
      await loadGroups();
    } catch {
      if (document.getElementById('groups-root') === root) document.getElementById('groups-feedback').textContent = 'Deletion was not confirmed. Referenced groups cannot be deleted: reassign hosts, account scopes and directory mappings first. Refresh before retrying.';
    } finally {
      if (document.getElementById('groups-root') === root) setGroupBusy(false);
    }
  }

  async function createToken() {
    if (tokenBusy || !hasPermission('tokens.write')) return;
    const root = document.getElementById('tokens-root');
    if (!root) return;
    const hours = Number(getValue('new-token-ttl'));
    if (![1, 24, 168, 720].includes(hours)) { tokenFeedback('Choose a valid expiry period.'); return; }
    hideToken();
    cancelTokenRevoke();
    setTokenBusy(true);
    try {
      const response = await API.createToken({ note: getValue('new-token-note').trim(), expires_at: new Date(Date.now() + hours * 3600000).toISOString() });
      if (document.getElementById('tokens-root') !== root) return;
      if (typeof response?.data?.token !== 'string' || !response.data.token) throw new Error('Missing token');
      setValue('token-secret', response.data.token);
      document.getElementById('token-secret-panel').hidden = false;
      document.getElementById('token-secret').focus();
      tokenFeedback('Token created. Copy it now; the secret is only shown once.');
      await loadTokens();
    } catch {
      if (document.getElementById('tokens-root') === root) tokenFeedback('Creation could not be confirmed. Refresh history before retrying; a token may already have been created.');
    } finally {
      if (document.getElementById('tokens-root') === root) { setTokenBusy(false); renderTokens(); }
    }
  }

  async function saveReqAgents() {
    if (!requirementReady || requirementBusy || !requirementGroup || !hasPermission('groups.write')) return;
    const root = document.getElementById('requirements-root');
    if (!root) return;
    const names = requirementNames();
    const feedback = document.getElementById('requirements-feedback');
    if (names.length > 50 || names.some(name => [...name].length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(name))) {
      feedback.textContent = 'Use up to 50 names of 100 characters each, without control characters.'; return;
    }
    if (!names.length && requirementSaved.length && !document.getElementById('requirements-clear').checked) {
      document.getElementById('requirements-clear-label').hidden = false;
      feedback.textContent = 'Confirm removing all requirements before saving an empty list.';
      document.getElementById('requirements-clear').focus(); return;
    }
    const id = requirementGroup;
    const version = ++requirementVersion;
    const current = () => document.getElementById('requirements-root') === root && version === requirementVersion;
    requirementBusy = true;
    const fields = document.getElementById('requirements-fields');
    fields.disabled = true;
    fields.setAttribute('aria-busy', 'true');
    document.getElementById('requirements-group').disabled = true;
    feedback.textContent = 'Saving requirements…';
    try {
      const response = await API.setRequiredAgents(id, names);
      if (!current()) return;
      const data = response?.data;
      if (data?.group_id !== id || !Array.isArray(data.agents) || data.agents.some(name => typeof name !== 'string')) throw new Error('Unconfirmed requirements');
      requirementSaved = [...data.agents];
      setValue('requirements-names', data.agents.join('\n'));
      document.getElementById('requirements-clear-label').hidden = true;
      document.getElementById('requirements-clear').checked = false;
      document.getElementById('requirements-count').textContent = `${data.agents.length} required`;
      feedback.textContent = 'Requirements saved. Compliance uses this list; host alerts are evaluated on incoming reports.';
    } catch {
      if (current()) feedback.textContent = 'Save could not be confirmed. Your draft is retained; retry to apply it.';
    } finally {
      if (current()) {
        requirementBusy = false;
        fields.disabled = !hasPermission('groups.write');
        fields.setAttribute('aria-busy', 'false');
        document.getElementById('requirements-group').disabled = false;
      }
    }
  }

  return {
    render,

    createUser,
    deleteUser,
    userAction,
    editPermissions,
    editScopes,
    createGroup,
    deleteGroup,
    createToken,
    loadTokens,
    renderTokens,
    hideToken,
    copyToken,
    requestTokenRevoke,
    cancelTokenRevoke,
    revokeToken,
    saveReqAgents,
    loadGroups,
    selectRequirementGroup,
    requirementsChanged,
    requestGroupDelete,
    cancelGroupDelete,
    loadIntegration,
    changeSecretAction,
    saveLDAP,
    saveSMTP,
    createLDAPGroupMapping,
    deleteLDAPGroupMapping
  };
})();
