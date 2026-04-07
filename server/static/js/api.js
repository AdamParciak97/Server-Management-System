'use strict';

window.API = (() => {
  let accessToken = null;
  let refreshToken = null;
  let refreshTimer = null;

  const BASE = '';

  function saveTokens(at, rt) {
    accessToken = at;
    refreshToken = rt;
    if (at) sessionStorage.setItem('sms_at', at);
    if (rt) localStorage.setItem('sms_rt', rt);
  }

  function loadTokens() {
    accessToken = sessionStorage.getItem('sms_at');
    refreshToken = localStorage.getItem('sms_rt');
  }

  function clearTokens() {
    accessToken = null;
    refreshToken = null;
    sessionStorage.removeItem('sms_at');
    localStorage.removeItem('sms_rt');
    if (refreshTimer) clearTimeout(refreshTimer);
  }

  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    // Refresh 2 minutes before expiry (15min tokens)
    refreshTimer = setTimeout(() => doRefresh(), (15 * 60 - 120) * 1000);
  }

  async function doRefresh() {
    if (!refreshToken) return;
    try {
      const resp = await fetch(BASE + '/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken })
      });
      if (!resp.ok) throw new Error('refresh failed');
      const data = await resp.json();
      if (data.data) {
        saveTokens(data.data.access_token, data.data.refresh_token);
        scheduleRefresh();
      }
    } catch (e) {
      console.warn('Token refresh failed, redirecting to login');
      clearTokens();
      App.showLogin();
    }
  }

  async function request(method, path, body, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (accessToken) headers['Authorization'] = 'Bearer ' + accessToken;

    const fetchOpts = { method, headers };
    if (body != null) fetchOpts.body = JSON.stringify(body);

    const resp = await fetch(BASE + path, fetchOpts);

    if (resp.status === 401) {
      // Try to refresh
      await doRefresh();
      if (!accessToken) {
        App.showLogin();
        throw new Error('Unauthenticated');
      }
      headers['Authorization'] = 'Bearer ' + accessToken;
      const retry = await fetch(BASE + path, { method, headers, body: fetchOpts.body });
      if (!retry.ok) {
        const err = await retry.json().catch(() => ({}));
        throw new Error(err.error || 'Request failed');
      }
      return retry.json();
    }

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${resp.status}`);
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
        const payload = JSON.parse(atob(parts[1]));
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
      saveTokens(data.data.access_token, data.data.refresh_token);
      scheduleRefresh();
      return data.data;
    },

    async logout() {
      try {
        await request('POST', '/api/auth/logout', { refresh_token: refreshToken });
      } catch {}
      clearTokens();
    },

    // Servers
    getServers: () => request('GET', '/api/servers'),
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
    createCommand: (data) => request('POST', '/api/commands', data),
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
    uploadPackage: async (formData) => {
      const resp = await fetch(BASE + '/api/packages/upload', {
        method: 'POST',
        headers: accessToken ? { 'Authorization': 'Bearer ' + accessToken } : {},
        body: formData
      });
      if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error || 'Upload failed'); }
      return resp.json();
    },

    // Groups
    listGroups: () => request('GET', '/api/groups'),
    createGroup: (data) => request('POST', '/api/groups', data),
    deleteGroup: (id) => request('DELETE', `/api/groups/${id}`),
    setRequiredAgents: (id, agents) => request('PUT', `/api/groups/${id}/required-agents`, { agents }),

    // Users
    listUsers: () => request('GET', '/api/users'),
    createUser: (data) => request('POST', '/api/users', data),
    deleteUser: (id) => request('DELETE', `/api/users/${id}`),
    getUserPermissions: (id) => request('GET', `/api/users/${id}/permissions`),
    setUserPermissions: (id, permissions) => request('PUT', `/api/users/${id}/permissions`, { permissions }),
    getUserScopes: (id) => request('GET', `/api/users/${id}/scopes`),
    setUserScopes: (id, group_ids) => request('PUT', `/api/users/${id}/scopes`, { group_ids }),
    changePassword: (data) => request('POST', '/api/account/password', data),

    // Tokens
    listTokens: () => request('GET', '/api/tokens'),
    createToken: (data) => request('POST', '/api/tokens', data),

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
