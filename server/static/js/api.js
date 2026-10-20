'use strict';

window.API = (() => {
  let accessToken = null;
  let refreshToken = null;
  let refreshTimer = null;
  let refreshPromise = null;
  let sessionVersion = 0;

  const BASE = '';

  function saveTokens(at, rt) {
    accessToken = at;
    refreshToken = rt;
    if (at) sessionStorage.setItem('sms_at', at);
    if (rt) localStorage.setItem('sms_rt', rt);
  }

  function loadTokens() {
    sessionVersion++;
    refreshPromise = null;
    accessToken = sessionStorage.getItem('sms_at');
    refreshToken = localStorage.getItem('sms_rt');
  }

  function clearTokens() {
    sessionVersion++;
    refreshPromise = null;
    accessToken = null;
    refreshToken = null;
    sessionStorage.removeItem('sms_at');
    localStorage.removeItem('sms_rt');
    if (refreshTimer) clearTimeout(refreshTimer);
  }

  function scheduleRefresh(delay = (15 * 60 - 120) * 1000) {
    if (refreshTimer) clearTimeout(refreshTimer);
    const version = sessionVersion;
    // Refresh 2 minutes before expiry (15min tokens)
    refreshTimer = setTimeout(async () => {
      try {
        await doRefresh();
      } catch {
        // A temporary outage is not evidence that the session has expired.
        if (version === sessionVersion && refreshToken) scheduleRefresh(60 * 1000);
      }
    }, delay);
  }

  async function doRefresh() {
    // Requests and the timer must share token rotation within this page.
    if (refreshPromise) return refreshPromise;
    if (!refreshToken) return;
    const pending = refreshTokens();
    refreshPromise = pending;
    try {
      await pending;
    } finally {
      if (refreshPromise === pending) refreshPromise = null;
    }
  }

  async function refreshTokens() {
    const version = sessionVersion;
    const resp = await fetch(BASE + '/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken })
    });
    // Logout or a new login invalidates every response from the old session.
    if (version !== sessionVersion) throw new Error('Session changed');
    if (resp.status === 401) {
      clearTokens();
      App.showLogin();
      throw new Error('Unauthenticated');
    }
    if (!resp.ok) throw new Error(`Token refresh failed: HTTP ${resp.status}`);
    const data = await resp.json();
    if (version !== sessionVersion) throw new Error('Session changed');
    if (!data?.data || typeof data.data.access_token !== 'string' || !data.data.access_token ||
        typeof data.data.refresh_token !== 'string' || !data.data.refresh_token) {
      throw new Error('Invalid token refresh response');
    }
    saveTokens(data.data.access_token, data.data.refresh_token);
    scheduleRefresh();
  }

  async function request(method, path, body, opts = {}) {
    const version = sessionVersion;
    // Let fetch supply the multipart boundary when sending a FormData body.
    const headers = opts.multipart ? {} : { 'Content-Type': 'application/json' };
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    if (accessToken) headers['Authorization'] = 'Bearer ' + accessToken;

    const fetchOpts = { method, headers };
    if (body != null) fetchOpts.body = opts.multipart ? body : JSON.stringify(body);

    const resp = await fetch(BASE + path, fetchOpts);

    if (resp.status === 401) {
      // Never replay an old session's operation as a newly logged-in user.
      if (version !== sessionVersion) throw new Error('Session changed');
      // A late 401 may refer to a token that another request already refreshed.
      if (!accessToken || headers['Authorization'] === 'Bearer ' + accessToken) {
        await doRefresh();
      }
      if (version !== sessionVersion) throw new Error('Session changed');
      if (!accessToken) {
        App.showLogin();
        throw new Error('Unauthenticated');
      }
      headers['Authorization'] = 'Bearer ' + accessToken;
      const retry = await fetch(BASE + path, { method, headers, body: fetchOpts.body });
      if (!retry.ok) {
        const err = await retry.json().catch(() => ({}));
        throw new Error(err.error || opts.errorMessage || 'Request failed');
      }
      if (retry.status === 204) return null;
      return retry.json();
    }

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || opts.errorMessage || `HTTP ${resp.status}`);
    }

    if (resp.status === 204) return null;
    return resp.json();
  }

  return {
    init() { loadTokens(); if (refreshToken) scheduleRefresh(); },
    isLoggedIn() { return !!accessToken || !!refreshToken; },
    getUser() {
      if (!accessToken) return null;
      try {
        const parts = accessToken.split('.');
        // JWT claims are Base64URL-encoded UTF-8, while atob returns raw bytes.
        const encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
        const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        return { id: payload.user_id, username: payload.username, role: payload.role, permissions: payload.permissions || [], group_scopes: payload.group_scopes || [] };
      } catch { return null; }
    },

    async login(username, password) {
      const resp = await fetch(BASE + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || 'Login failed');
      }
      const data = await resp.json();
      sessionVersion++;
      refreshPromise = null;
      saveTokens(data.data.access_token, data.data.refresh_token);
      scheduleRefresh();
      return data.data;
    },

    async logout() {
      const version = sessionVersion;
      let confirmed = false;
      try {
        const result = await request('POST', '/api/auth/logout');
        confirmed = Number.isInteger(result?.data?.revoked) && result.data.revoked >= 0;
      } catch {}
      const sessionChanged = version !== sessionVersion;
      if (!sessionChanged) clearTokens();
      return { confirmed, sessionChanged };
    },

    // Servers
    getServers: () => request('GET', '/api/servers'),
    getInventory: (filters) => request('GET', `/api/inventory/servers?${new URLSearchParams(filters)}`),
    listInventoryGroups: () => request('GET', '/api/inventory/groups'),
    listInventoryViews: () => request('GET', '/api/inventory/views'),
    saveInventoryView: (id, data) => request(id ? 'PUT' : 'POST', `/api/inventory/views${id ? '/' + encodeURIComponent(id) : ''}`, data),
    deleteInventoryView: (id) => request('DELETE', `/api/inventory/views/${encodeURIComponent(id)}`),
    getServer: (id) => request('GET', `/api/servers/${id}`),
    getServerHistory: (id, limit = 50) => request('GET', `/api/servers/${id}/history?limit=${limit}`),
    getServerTimeline: (id, limit = 50) => request('GET', `/api/servers/${id}/timeline?limit=${limit}`),
    getServerBaseline: (id) => request('GET', `/api/servers/${id}/baseline`),
    setServerBaseline: (id, reportId) => request('POST', `/api/servers/${id}/baseline`, { report_id: reportId }),
    getConfigDiff: (id, from, to) => request('GET', `/api/servers/${id}/config/diff?from=${from}&to=${to}`),
    forceReport: (id) => request('POST', `/api/servers/${id}/report/force`),
    assignGroup: (id, groupId) => request('PUT', `/api/servers/${id}/group`, { group_id: groupId }),

    // Stats
    getStats: () => request('GET', '/api/stats'),

    // Commands
    listCommands: (agentId = '') => request('GET', `/api/commands${agentId ? '?agent_id=' + agentId : ''}`),
    createCommand: (data, idempotencyKey) => request('POST', '/api/commands', data, {idempotencyKey}),
    listCommandTemplates: () => request('GET', '/api/commands/templates'),
    createCommandTemplate: (data) => request('POST', '/api/commands/templates', data),
    deleteCommandTemplate: (id) => request('DELETE', `/api/commands/templates/${id}`),
    createScheduledCommand: (data) => request('POST', '/api/commands/scheduled', data),
    listScheduledCommands: () => request('GET', '/api/commands/scheduled'),
    listMaintenanceWindows: () => request('GET', '/api/maintenance-windows'),
    createMaintenanceWindow: (data) => request('POST', '/api/maintenance-windows', data),
    deleteMaintenanceWindow: (id) => request('DELETE', `/api/maintenance-windows/${id}`),
    getCommandLog: (id) => request('GET', `/api/commands/${id}/log`),
    cancelCommand: (id) => request('DELETE', `/api/commands/${id}`),
    deleteScheduledCommand: (id) => request('DELETE', `/api/commands/scheduled/${id}`),
    approveCommand: (id, note = '') => request('POST', `/api/commands/${id}/approve`, { note }),
    emailReport: (id, data) => request('POST', `/api/reports/${id}/email`, data),

    // Alerts
    listAlerts: (active = true) => request('GET', `/api/alerts?active=${active}`),
    acknowledgeAlert: (id) => request('POST', `/api/alerts/${id}/acknowledge`),

    // Packages
    listPackages: () => request('GET', '/api/packages'),
    deletePackage: (id) => request('DELETE', `/api/packages/${id}`),
    uploadPackage: (formData) => request('POST', '/api/packages/upload', formData,
      { multipart: true, errorMessage: 'Upload failed' }),

    // Groups
    listGroups: () => request('GET', '/api/groups'),
    createGroup: (data) => request('POST', '/api/groups', data),
    deleteGroup: (id) => request('DELETE', `/api/groups/${id}`),
    setRequiredAgents: (id, agents) => request('PUT', `/api/groups/${encodeURIComponent(id)}/required-agents`, { agents }),
    getRequiredAgents: (id) => request('GET', `/api/groups/${encodeURIComponent(id)}/required-agents`),

    // Users
    listUsers: () => request('GET', '/api/users'),
    createUser: (data) => request('POST', '/api/users', data),
    deleteUser: (id) => request('DELETE', `/api/users/${id}`),
    getUserPermissions: (id) => request('GET', `/api/users/${id}/permissions`),
    setUserPermissions: (id, permissions) => request('PUT', `/api/users/${id}/permissions`, { permissions }),
    getUserScopes: (id) => request('GET', `/api/users/${id}/scopes`),
    setUserScopes: (id, group_ids) => request('PUT', `/api/users/${id}/scopes`, { group_ids }),
    listSessions: () => request('GET', '/api/account/sessions'),
    revokeOtherSessions: () => request('POST', '/api/account/sessions/revoke-others'),
    async changePassword(data) {
      const version = sessionVersion;
      const result = await request('POST', '/api/account/password', data);
      if (version !== sessionVersion) throw new Error('Session changed');
      if (result?.data?.status !== 'password_changed') throw new Error('Password change could not be confirmed');
      clearTokens();
      App.showLogin('Password changed. Sign in with your new password.');
      return result;
    },

    // Tokens
    listTokens: () => request('GET', '/api/tokens'),
    createToken: (data) => request('POST', '/api/tokens', data),
    revokeToken: (id) => request('POST', `/api/tokens/${encodeURIComponent(id)}/revoke`),

    // Compliance
    getCompliance: () => request('GET', '/api/compliance'),
    listCompliancePolicies: () => request('GET', '/api/compliance/policies'),
    createCompliancePolicy: (data) => request('POST', '/api/compliance/policies', data),
    deleteCompliancePolicy: (id) => request('DELETE', `/api/compliance/policies/${id}`),
    listComplianceExceptions: () => request('GET', '/api/compliance/exceptions'),
    createComplianceException: (data) => request('POST', '/api/compliance/exceptions', data),
    deleteComplianceException: (id) => request('DELETE', `/api/compliance/exceptions/${id}`),

    // Audit
    listAudit: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request('GET', `/api/audit${qs ? '?' + qs : ''}`);
    },

    // Settings
    getLDAPSettings: () => request('GET', '/api/settings/ldap'),
    setLDAPSettings: (data) => request('PUT', '/api/settings/ldap', data),
    listLDAPGroupMappings: () => request('GET', '/api/settings/ldap/mappings'),
    createLDAPGroupMapping: (data) => request('POST', '/api/settings/ldap/mappings', data),
    deleteLDAPGroupMapping: (id) => request('DELETE', `/api/settings/ldap/mappings/${id}`),
    getSMTPSettings: () => request('GET', '/api/settings/smtp'),
    setSMTPSettings: (data) => request('PUT', '/api/settings/smtp', data),
    getPermissionCatalog: () => request('GET', '/api/permissions/catalog'),

    exportCSV: (servers = '') => {
      window.open(`/api/reports/export?format=csv&servers=${servers}&token=${accessToken}`, '_blank');
    }
  };
})();
