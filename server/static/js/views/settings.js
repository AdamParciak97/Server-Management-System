'use strict';

Views.Settings = (() => {
  let groups = [];
  let users = [];
  let tokens = [];
  let permissionCatalog = [];
  let ldapSettings = {};
  let ldapGroupMappings = [];
  let smtpSettings = {};

  async function render(container) {
    const user = API.getUser() || { permissions: [] };
    container.innerHTML = `
      <div class="page-header"><h2>Settings</h2></div>
      <div class="grid-2">
        <div>
          ${renderAccountSection(user)}
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

    await loadAll();
  }

  function renderAccountSection(user) {
    return `
      <div class="card mb-2">
        <div class="section-title">My Account</div>
        <div class="text-muted mb-1">${App.escHtml(user.username || '')} (${App.escHtml(user.role || '')})</div>
        <div class="form-row">
          <div class="form-group">
            <label>Current Password</label>
            <input type="password" id="current-password" autocomplete="current-password">
          </div>
          <div class="form-group">
            <label>New Password</label>
            <input type="password" id="new-account-password" autocomplete="new-password">
          </div>
          <div class="form-group">
            <label>Repeat New Password</label>
            <input type="password" id="repeat-account-password" autocomplete="new-password">
          </div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="Views.Settings.changePassword()">Change Password</button>
      </div>
    `;
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
      <div class="card mb-2">
        <div class="section-title">Groups</div>
        <div id="groups-list" class="mb-2"><span class="spinner"></span></div>
        ${hasPermission('groups.write') ? `
          <div class="form-row">
            <div class="form-group"><label>Name</label><input type="text" id="new-group-name" placeholder="Group name"></div>
            <div class="form-group"><label>Description</label><input type="text" id="new-group-desc" placeholder="Description"></div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="Views.Settings.createGroup()">Add Group</button>
        ` : ''}
      </div>
    `;
  }

  function renderTokensSection() {
    return `
      <div class="card mb-2">
        <div class="section-title">Registration Tokens</div>
        <div id="tokens-list" class="mb-2"><span class="spinner"></span></div>
        ${hasPermission('tokens.write') ? `
          <div class="form-row">
            <div class="form-group"><label>Note</label><input type="text" id="new-token-note" placeholder="Note (optional)"></div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="Views.Settings.createToken()">Generate Token</button>
        ` : ''}
      </div>
    `;
  }

  function renderLDAPSection() {
    return `
      <div class="card mb-2">
        <div class="section-title">LDAP Authentication</div>
        <div class="form-row">
          <div class="form-group">
            <label>Enabled</label>
            <select id="ldap-enabled"><option value="false">Disabled</option><option value="true">Enabled</option></select>
          </div>
          <div class="form-group">
            <label>Server URL</label>
            <input type="text" id="ldap-server-url" placeholder="ldaps://dc01.example.local:636">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Bind DN</label><input type="text" id="ldap-bind-dn" placeholder="CN=sms-bind,OU=Svc,DC=example,DC=local"></div>
          <div class="form-group"><label>Bind Password</label><input type="password" id="ldap-bind-password"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Base DN</label><input type="text" id="ldap-base-dn" placeholder="DC=example,DC=local"></div>
          <div class="form-group"><label>User Filter</label><input type="text" id="ldap-user-filter" placeholder="(sAMAccountName=%s)"></div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>StartTLS</label>
            <select id="ldap-start-tls"><option value="false">No</option><option value="true">Yes</option></select>
          </div>
          <div class="form-group">
            <label>Default Role For LDAP Users</label>
            <select id="ldap-default-role">
              <option value="readonly">Readonly</option>
              <option value="operator">Operator</option>
              <option value="admin">Admin</option>
            </select>
          </div>
        </div>
        <div class="section-title mt-2">LDAP Group Mappings</div>
        <div id="ldap-group-mappings" class="mb-2"><span class="spinner"></span></div>
        <div class="form-row">
          <div class="form-group"><label>LDAP Group DN</label><input type="text" id="ldap-map-dn" placeholder="CN=SMS-Operators,OU=Groups,DC=example,DC=local"></div>
          <div class="form-group">
            <label>Role</label>
            <select id="ldap-map-role">
              <option value="readonly">Readonly</option>
              <option value="operator">Operator</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div class="form-group">
            <label>App Group Scope</label>
            <select id="ldap-map-group"><option value="">No scope</option></select>
          </div>
        </div>
        ${hasPermission('settings.write') ? `<button class="btn btn-sm" onclick="Views.Settings.createLDAPGroupMapping()">Add LDAP Group Mapping</button>` : ''}
        ${hasPermission('settings.write') ? `<button class="btn btn-primary btn-sm" onclick="Views.Settings.saveLDAP()">Save LDAP Settings</button>` : ''}
      </div>
    `;
  }

  function renderSMTPSection() {
    return `
      <div class="card mb-2">
        <div class="section-title">SMTP Alerting (Outlook)</div>
        <div class="form-row">
          <div class="form-group">
            <label>Enabled</label>
            <select id="smtp-enabled"><option value="false">Disabled</option><option value="true">Enabled</option></select>
          </div>
          <div class="form-group"><label>Host</label><input type="text" id="smtp-host" placeholder="smtp.office365.com"></div>
          <div class="form-group"><label>Port</label><input type="number" id="smtp-port" placeholder="587"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Username</label><input type="text" id="smtp-username" placeholder="alerts@company.com"></div>
          <div class="form-group"><label>Password / App Password</label><input type="password" id="smtp-password"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>From</label><input type="text" id="smtp-from" placeholder="alerts@company.com"></div>
          <div class="form-group"><label>Recipients</label><input type="text" id="smtp-to" placeholder="soc@company.com, admin@company.com"></div>
        </div>
        ${hasPermission('settings.write') ? `<button class="btn btn-primary btn-sm" onclick="Views.Settings.saveSMTP()">Save SMTP Settings</button>` : ''}
      </div>
    `;
  }

  function renderRequiredAgentsSection() {
    return `
      <div class="card mb-2">
        <div class="section-title">Required Security Agents per Group</div>
        <div id="req-agents-section"><span class="spinner"></span></div>
      </div>
    `;
  }

  async function loadAll() {
    const tasks = [];
    if (hasPermission('groups.read')) tasks.push(API.listGroups()); else tasks.push(Promise.resolve({ data: [] }));
    if (hasPermission('users.read')) tasks.push(API.listUsers()); else tasks.push(Promise.resolve({ data: [] }));
    if (hasPermission('tokens.read')) tasks.push(API.listTokens()); else tasks.push(Promise.resolve({ data: [] }));
    if (hasPermission('users.read')) tasks.push(API.getPermissionCatalog()); else tasks.push(Promise.resolve({ data: [] }));
    if (hasPermission('settings.read')) tasks.push(API.getLDAPSettings()); else tasks.push(Promise.resolve({ data: {} }));
    if (hasPermission('settings.read')) tasks.push(API.listLDAPGroupMappings()); else tasks.push(Promise.resolve({ data: [] }));
    if (hasPermission('settings.read')) tasks.push(API.getSMTPSettings()); else tasks.push(Promise.resolve({ data: {} }));

    const [groupResp, userResp, tokenResp, permissionResp, ldapResp, ldapMappingsResp, smtpResp] = await Promise.all(tasks);
    groups = (groupResp && groupResp.data) ? groupResp.data : [];
    users = (userResp && userResp.data) ? userResp.data : [];
    tokens = (tokenResp && tokenResp.data) ? tokenResp.data : [];
    permissionCatalog = (permissionResp && permissionResp.data) ? permissionResp.data : [];
    ldapSettings = (ldapResp && ldapResp.data) ? ldapResp.data : {};
    ldapGroupMappings = (ldapMappingsResp && ldapMappingsResp.data) ? ldapMappingsResp.data : [];
    smtpSettings = (smtpResp && smtpResp.data) ? smtpResp.data : {};

    renderGroups();
    renderUsers();
    renderTokens();
    renderReqAgents(groups);
    bindLDAP();
    renderLDAPGroupMappings();
    bindSMTP();
  }

  function renderUsers() {
    const el = document.getElementById('users-list');
    if (!el) return;
    if (!users.length) {
      el.innerHTML = '<p class="text-muted">No users</p>';
      return;
    }
    el.innerHTML = users.map(user => `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;padding:.4rem 0;border-bottom:1px solid #2e3347;gap:1rem">
        <div>
          <strong>${App.escHtml(user.username)}</strong>
          <span class="text-muted"> (${App.escHtml(user.role)})</span>
          <span class="text-muted"> - ${App.escHtml(user.email)}</span>
          <div class="text-muted">Auth: ${App.escHtml(user.auth_source || 'local')}</div>
        </div>
        <div style="display:flex;gap:.4rem;flex-wrap:wrap;justify-content:flex-end">
          ${hasPermission('users.write') ? `<button class="btn btn-sm" onclick="Views.Settings.editPermissions('${user.id}', '${App.escHtml(user.username)}', '${App.escHtml(user.role)}')">Permissions</button>` : ''}
          ${hasPermission('users.write') ? `<button class="btn btn-sm" onclick="Views.Settings.editScopes('${user.id}', '${App.escHtml(user.username)}')">Scopes</button>` : ''}
          ${hasPermission('users.write') && user.username !== 'admin' ? `<button class="btn btn-sm btn-danger" onclick="Views.Settings.deleteUser('${user.id}', '${App.escHtml(user.username)}')">Delete</button>` : ''}
        </div>
      </div>
    `).join('');
  }

  function renderGroups() {
    const el = document.getElementById('groups-list');
    if (!el) return;
    if (!groups.length) {
      el.innerHTML = '<p class="text-muted">No groups yet</p>';
      return;
    }
    el.innerHTML = groups.map(group => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:.4rem 0;border-bottom:1px solid #2e3347">
        <div>
          <strong>${App.escHtml(group.name)}</strong>
          <span class="text-muted"> (${group.server_count} servers)</span>
          ${group.description ? `<span class="text-muted"> - ${App.escHtml(group.description)}</span>` : ''}
        </div>
        ${hasPermission('groups.write') ? `<button class="btn btn-sm btn-danger" onclick="Views.Settings.deleteGroup('${group.id}')">Delete</button>` : ''}
      </div>
    `).join('');
  }

  function renderTokens() {
    const el = document.getElementById('tokens-list');
    if (!el) return;
    if (!tokens.length) {
      el.innerHTML = '<p class="text-muted">No tokens yet</p>';
      return;
    }
    el.innerHTML = tokens.map(token => `
      <div style="padding:.4rem 0;border-bottom:1px solid #2e3347">
        <div class="monospace" style="font-size:.8rem;color:${token.used ? '#64748b' : '#22c55e'}">${token.token}</div>
        <div class="text-muted" style="font-size:.75rem">
          ${token.used ? '&#10007; Used ' + App.timeAgo(token.used_at) : '&#10003; Available'}
          ${token.note ? ' - ' + App.escHtml(token.note) : ''}
          &bull; Created ${App.timeAgo(token.created_at)}
        </div>
      </div>
    `).join('');
  }

  function bindLDAP() {
    setValue('ldap-enabled', ldapSettings.ldap_enabled || 'false');
    setValue('ldap-server-url', ldapSettings.ldap_server_url || '');
    setValue('ldap-bind-dn', ldapSettings.ldap_bind_dn || '');
    setValue('ldap-bind-password', ldapSettings.ldap_bind_password || '');
    setValue('ldap-base-dn', ldapSettings.ldap_base_dn || '');
    setValue('ldap-user-filter', ldapSettings.ldap_user_filter || '');
    setValue('ldap-start-tls', ldapSettings.ldap_start_tls || 'false');
    setValue('ldap-default-role', ldapSettings.ldap_default_role || 'readonly');
    const groupSelect = document.getElementById('ldap-map-group');
    if (groupSelect) {
      groupSelect.innerHTML = '<option value="">No scope</option>' + groups.map(group =>
        `<option value="${group.id}">${App.escHtml(group.name)}</option>`).join('');
    }
  }

  function bindSMTP() {
    setValue('smtp-enabled', smtpSettings.smtp_enabled || 'false');
    setValue('smtp-host', smtpSettings.smtp_host || 'smtp.office365.com');
    setValue('smtp-port', smtpSettings.smtp_port || '587');
    setValue('smtp-username', smtpSettings.smtp_username || '');
    setValue('smtp-password', smtpSettings.smtp_password || '');
    setValue('smtp-from', smtpSettings.smtp_from || '');
    setValue('smtp-to', smtpSettings.smtp_to || '');
  }

  function setValue(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value;
  }

  function renderReqAgents(groupsList) {
    const el = document.getElementById('req-agents-section');
    if (!el) return;
    if (!groupsList.length) {
      el.innerHTML = '<p class="text-muted">No groups configured</p>';
      return;
    }
    const knownAgents = ['Elastic Agent', 'FireEye HX', 'CrowdStrike Falcon', 'Carbon Black',
      'Splunk Universal Forwarder', 'Zabbix Agent', 'Wazuh Agent', 'SentinelOne', 'Tenable Nessus Agent'];
    el.innerHTML = groupsList.map(group => `
      <div class="mb-2">
        <strong>${App.escHtml(group.name)}</strong>
        <div style="display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.4rem">
          ${knownAgents.map(agent => `
            <label style="display:flex;align-items:center;gap:.3rem;font-size:.82rem;cursor:pointer">
              <input type="checkbox" class="req-agent-cb" data-group="${group.id}" data-agent="${App.escHtml(agent)}">
              ${App.escHtml(agent)}
            </label>
          `).join('')}
        </div>
        ${hasPermission('groups.write') ? `<button class="btn btn-sm btn-primary mt-1" onclick="Views.Settings.saveReqAgents('${group.id}')">Save</button>` : ''}
      </div>
    `).join('');
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
    try {
      await API.setLDAPSettings({
        ldap_enabled: getValue('ldap-enabled'),
        ldap_server_url: getValue('ldap-server-url'),
        ldap_bind_dn: getValue('ldap-bind-dn'),
        ldap_bind_password: getValue('ldap-bind-password'),
        ldap_base_dn: getValue('ldap-base-dn'),
        ldap_user_filter: getValue('ldap-user-filter'),
        ldap_start_tls: getValue('ldap-start-tls'),
        ldap_default_role: getValue('ldap-default-role')
      });
      alert('LDAP settings saved');
    } catch (err) {
      alert('Error: ' + err.message);
    }
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
    try {
      await API.setSMTPSettings({
        smtp_enabled: getValue('smtp-enabled'),
        smtp_host: getValue('smtp-host'),
        smtp_port: getValue('smtp-port'),
        smtp_username: getValue('smtp-username'),
        smtp_password: getValue('smtp-password'),
        smtp_from: getValue('smtp-from'),
        smtp_to: getValue('smtp-to')
      });
      alert('SMTP settings saved');
    } catch (err) {
      alert('Error: ' + err.message);
    }
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

  async function changePassword() {
    const currentPassword = document.getElementById('current-password').value;
    const newPassword = document.getElementById('new-account-password').value;
    const repeatPassword = document.getElementById('repeat-account-password').value;
    if (!currentPassword || !newPassword || !repeatPassword) {
      alert('Fill all password fields');
      return;
    }
    if (newPassword !== repeatPassword) {
      alert('New passwords do not match');
      return;
    }
    try {
      await API.changePassword({ current_password: currentPassword, new_password: newPassword });
      setValue('current-password', '');
      setValue('new-account-password', '');
      setValue('repeat-account-password', '');
      alert('Password changed');
    } catch (err) {
      alert('Error: ' + err.message);
    }
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

  async function createGroup() {
    const name = getValue('new-group-name');
    const description = getValue('new-group-desc');
    if (!name) {
      alert('Name required');
      return;
    }
    try {
      await API.createGroup({ name, description });
      await loadAll();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function deleteGroup(id) {
    if (!confirm('Delete this group?')) return;
    try {
      await API.deleteGroup(id);
      await loadAll();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function createToken() {
    try {
      await API.createToken({ note: getValue('new-token-note') });
      await loadAll();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function saveReqAgents(groupId) {
    const checkboxes = document.querySelectorAll(`.req-agent-cb[data-group="${groupId}"]`);
    const agents = [];
    checkboxes.forEach(cb => { if (cb.checked) agents.push(cb.dataset.agent); });
    try {
      await API.setRequiredAgents(groupId, agents);
      alert('Required agents saved for group');
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  return {
    render,
    changePassword,
    createUser,
    deleteUser,
    editPermissions,
    editScopes,
    createGroup,
    deleteGroup,
    createToken,
    saveReqAgents,
    saveLDAP,
    saveSMTP,
    createLDAPGroupMapping,
    deleteLDAPGroupMapping
  };
})();
