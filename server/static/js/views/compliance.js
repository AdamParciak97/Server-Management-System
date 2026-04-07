'use strict';

Views.Compliance = (() => {
  let allData = [];
  let allPolicies = [];
  let allGroups = [];
  let allExceptions = [];

  async function render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2>Compliance</h2>
        <div class="page-actions">
          <button class="btn btn-sm btn-primary" onclick="API.exportCSV()">&#8659; Export CSV</button>
          <button class="btn btn-sm" onclick="Views.Compliance.reload()">&#8635; Refresh</button>
        </div>
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="section-title">Policy Results by Server</div>
          <div class="filters">
            <select id="comp-group-filter"><option value="">All Groups</option></select>
            <select id="comp-status-filter">
              <option value="">All</option>
              <option value="compliant">Compliant</option>
              <option value="non-compliant">Non-Compliant</option>
            </select>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr>
                <th>Hostname</th><th>Group</th><th>Status</th><th>Missing Agents</th><th>Failed Policies</th><th>Compliance</th><th>Actions</th>
              </tr></thead>
              <tbody id="compliance-tbody">
                <tr><td colspan="7" class="text-center"><span class="spinner"></span></td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <div class="section-title">Compliance Policies</div>
          <div id="compliance-policies-list" class="mb-2"><span class="spinner"></span></div>
          <div class="form-row">
            <div class="form-group">
              <label>Name</label>
              <input type="text" id="policy-name" placeholder="Windows Defender must run">
            </div>
            <div class="form-group">
              <label>Group</label>
              <select id="policy-group-id"><option value="">All Groups</option></select>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Type</label>
              <select id="policy-type">
                <option value="service_status">Service Status</option>
                <option value="package_installed">Package Installed</option>
                <option value="security_agent">Security Agent</option>
                <option value="firewall_enabled">Firewall Enabled</option>
                <option value="defender_status">Defender Healthy</option>
                <option value="patch_compliance">Patch Compliance</option>
                <option value="bitlocker_enabled">BitLocker Enabled</option>
                <option value="remote_access_disabled">Remote Access Disabled</option>
                <option value="local_admin_count">Local Admin Count</option>
                <option value="certificate_expiry">Certificate Expiry</option>
              </select>
            </div>
            <div class="form-group">
              <label>Subject</label>
              <input type="text" id="policy-subject" placeholder="wuauserv / RDP / C:\ / CN=example / All">
            </div>
            <div class="form-group">
              <label>Expected Value</label>
              <input type="text" id="policy-expected" placeholder="running / true / 0 / 30">
            </div>
            <div class="form-group">
              <label>Severity</label>
              <select id="policy-severity">
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="Views.Compliance.createPolicy()">Add Policy</button>
          <div class="section-title mt-2">Exceptions</div>
          <div id="compliance-exceptions-list"><span class="spinner"></span></div>
        </div>
      </div>
    `;
    await reload();
  }

  async function reload() {
    try {
      const [cResp, gResp, pResp, eResp] = await Promise.all([
        API.getCompliance(),
        API.listGroups(),
        API.listCompliancePolicies(),
        API.listComplianceExceptions()
      ]);
      allData = (cResp && cResp.data) ? cResp.data : [];
      allGroups = (gResp && gResp.data) ? gResp.data : [];
      allPolicies = (pResp && pResp.data) ? pResp.data : [];
      allExceptions = (eResp && eResp.data) ? eResp.data : [];
      bindFilters();
      renderPolicies();
      renderExceptions();
      applyFilters();
    } catch (err) {
      document.getElementById('compliance-tbody').innerHTML =
        `<tr><td colspan="7" class="error-msg">${App.escHtml(err.message)}</td></tr>`;
    }
  }

  function bindFilters() {
    const groupFilter = document.getElementById('comp-group-filter');
    const policyGroup = document.getElementById('policy-group-id');
    if (groupFilter) {
      groupFilter.innerHTML = '<option value="">All Groups</option>' + allGroups.map(g =>
        `<option value="${g.id}">${App.escHtml(g.name)}</option>`).join('');
      groupFilter.onchange = applyFilters;
    }
    if (policyGroup) {
      policyGroup.innerHTML = '<option value="">All Groups</option>' + allGroups.map(g =>
        `<option value="${g.id}">${App.escHtml(g.name)}</option>`).join('');
    }
    const statusFilter = document.getElementById('comp-status-filter');
    if (statusFilter) statusFilter.onchange = applyFilters;
  }

  function applyFilters() {
    const group = document.getElementById('comp-group-filter') ? document.getElementById('comp-group-filter').value : '';
    const status = document.getElementById('comp-status-filter') ? document.getElementById('comp-status-filter').value : '';

    let filtered = allData;
    if (group) filtered = filtered.filter(entry => entry.group_id === group);
    if (status === 'compliant') filtered = filtered.filter(entry => entry.compliant);
    if (status === 'non-compliant') filtered = filtered.filter(entry => !entry.compliant);

    renderTable(filtered);
  }

  function renderTable(data) {
    const tbody = document.getElementById('compliance-tbody');
    if (!tbody) return;
    if (!data || !data.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted" style="padding:2rem">No data</td></tr>';
      return;
    }
    tbody.innerHTML = data.map(entry => `
      <tr>
        <td>${App.escHtml(entry.hostname)}</td>
        <td>${App.escHtml(entry.group_name || '-')}</td>
        <td>${App.statusBadge(entry.status)}</td>
        <td>${entry.missing_agents && entry.missing_agents.length ? `<span style="color:#ef4444">${entry.missing_agents.map(App.escHtml).join(', ')}</span>` : '-'}</td>
        <td>${renderFailedPolicies(entry.failed_policies || [])}</td>
        <td>${entry.compliant ?
          '<span style="color:#22c55e;font-weight:600">&#10003; Compliant</span>' :
          '<span style="color:#ef4444;font-weight:600">&#10007; Non-Compliant</span>'}</td>
        <td>${renderActions(entry)}</td>
      </tr>
    `).join('');
  }

  function renderFailedPolicies(items) {
    if (!items.length) return '-';
    return items.map(item =>
      `<div><strong>${App.escHtml(item.name)}</strong>${item.excepted ? ' <span class="text-muted">(excepted)</span>' : ''}<div class="text-muted">${App.escHtml(item.message)}</div></div>`
    ).join('');
  }

  function renderActions(entry) {
    const failed = (entry.failed_policies || []).filter(item => !item.excepted);
    if (!failed.length) return '-';
    return failed.map(item =>
      `<button class="btn btn-sm" onclick="Views.Compliance.addException('${entry.agent_id}','${item.policy_id}','${escapeJs(item.name)}')">Except</button>`
    ).join(' ');
  }

  function renderPolicies() {
    const el = document.getElementById('compliance-policies-list');
    if (!el) return;
    if (!allPolicies.length) {
      el.innerHTML = '<p class="text-muted">No policies defined</p>';
      return;
    }
    el.innerHTML = allPolicies.map(policy => `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;padding:.55rem 0;border-bottom:1px solid #2e3347;gap:1rem">
        <div>
          <strong>${App.escHtml(policy.name)}</strong>
          <div class="text-muted">${App.escHtml(policy.policy_type)}: ${App.escHtml(policy.subject)}${policy.expected_value ? ` -> ${App.escHtml(policy.expected_value)}` : ''}</div>
          <div class="text-muted">${App.escHtml(policy.group_name || 'All Groups')} | severity: ${App.escHtml(policy.severity)}</div>
        </div>
        <button class="btn btn-sm btn-danger" onclick="Views.Compliance.deletePolicy('${policy.id}')">Delete</button>
      </div>
    `).join('');
  }

  function renderExceptions() {
    const el = document.getElementById('compliance-exceptions-list');
    if (!el) return;
    if (!allExceptions.length) {
      el.innerHTML = '<p class="text-muted">No compliance exceptions defined</p>';
      return;
    }
    el.innerHTML = allExceptions.map(item => `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;padding:.55rem 0;border-bottom:1px solid #2e3347;gap:1rem">
        <div>
          <strong>${App.escHtml(resolvePolicyName(item.policy_id))}</strong>
          <div class="text-muted">${App.escHtml(resolveHostName(item.agent_id))}</div>
          <div class="text-muted">${App.escHtml(item.reason)}${item.expires_at ? ` | expires ${App.escHtml(App.formatDate(item.expires_at))}` : ''}</div>
        </div>
        <button class="btn btn-sm btn-danger" onclick="Views.Compliance.deleteException('${item.id}')">Delete</button>
      </div>
    `).join('');
  }

  async function createPolicy() {
    const name = document.getElementById('policy-name').value.trim();
    const groupId = document.getElementById('policy-group-id').value;
    const policyType = document.getElementById('policy-type').value;
    const subject = document.getElementById('policy-subject').value.trim();
    const expectedValue = document.getElementById('policy-expected').value.trim();
    const severity = document.getElementById('policy-severity').value;

    if (!name || !subject) {
      alert('Name and subject are required.');
      return;
    }
    try {
      await API.createCompliancePolicy({
        name,
        group_id: groupId,
        policy_type: policyType,
        subject,
        expected_value: expectedValue,
        severity,
        enabled: true
      });
      document.getElementById('policy-name').value = '';
      document.getElementById('policy-subject').value = '';
      document.getElementById('policy-expected').value = '';
      await reload();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function deletePolicy(id) {
    if (!confirm('Delete this policy?')) return;
    try {
      await API.deleteCompliancePolicy(id);
      await reload();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function addException(agentId, policyId, policyName) {
    const reason = window.prompt(`Exception reason for ${policyName}`);
    if (!reason || !reason.trim()) return;
    const expiresAt = window.prompt('Expiry date/time RFC3339 (optional), e.g. 2026-05-01T00:00:00Z') || '';
    try {
      await API.createComplianceException({
        agent_id: agentId,
        policy_id: policyId,
        reason: reason.trim(),
        expires_at: expiresAt.trim()
      });
      await reload();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function deleteException(id) {
    if (!confirm('Delete this exception?')) return;
    try {
      await API.deleteComplianceException(id);
      await reload();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  function resolvePolicyName(id) {
    const policy = allPolicies.find(item => item.id === id);
    return policy ? policy.name : id;
  }

  function resolveHostName(id) {
    const entry = allData.find(item => item.agent_id === id);
    return entry ? entry.hostname : id;
  }

  function escapeJs(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  return { render, reload, createPolicy, deletePolicy, addException, deleteException };
})();
