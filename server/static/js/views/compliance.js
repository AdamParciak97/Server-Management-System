'use strict';

Views.Compliance = (() => {
  let allData = [], allPolicies = [], allGroups = [], allExceptions = [];
  let version = 0, ready = false;
  let pending = new Set();
  const el = id => document.getElementById(id);
  const esc = value => App.escHtml(value);
  const attr = value => esc(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const states = {failed: 'Needs attention', compliant: 'Compliant', awaiting: 'Awaiting report', unconfigured: 'No checks assigned', unknown: 'Unknown result'};
  const types = [
    ['service_status', 'Service status'], ['package_installed', 'Package installed'],
    ['security_agent', 'Security agent'], ['firewall_enabled', 'Firewall enabled'],
    ['defender_status', 'Defender healthy'], ['patch_compliance', 'Patch compliance'],
    ['bitlocker_enabled', 'BitLocker enabled'], ['remote_access_disabled', 'Remote access disabled'],
    ['local_admin_count', 'Local admin count'], ['certificate_expiry', 'Certificate expiry']
  ];
  // Descriptions mirror evaluatePolicy in handlers_server.go; no example values
  // are submitted automatically as operational configuration.
  const guidance = {
    service_status: ['Service name or display name from the report.', 'Expected status; blank uses running.'],
    package_installed: ['Exact package name from the report.', 'Not used; this check verifies package presence.', true],
    security_agent: ['Security agent name from the report.', 'Not used; requires running or healthy status.', true],
    firewall_enabled: ['Windows firewall profile name, or All for every profile.', 'true or false; blank requires enabled profiles.'],
    defender_status: ['Use All as the subject for this system-wide check.', 'Not used; Defender and real-time protection must be enabled.', true],
    patch_compliance: ['Use All as the subject for this system-wide check.', 'Maximum pending updates; blank uses 0. A pending reboot also fails.'],
    bitlocker_enabled: ['Volume mount point from the report, or All.', 'Not used; checks the reported protection status.', true],
    remote_access_disabled: ['Use RDP, WinRM or SSH.', 'true requires disabled access; false requires enabled access. Blank uses true.'],
    local_admin_count: ['Use All as the subject for this system-wide check.', 'Maximum local administrators; blank uses 0.'],
    certificate_expiry: ['Part of a certificate subject, or All.', 'Minimum remaining days; blank uses 30. At or below this threshold fails.']
  };

  function resultState(entry) {
    if (!entry.last_report_at) return 'awaiting';
    if (!(entry.policy_results || []).length && !(entry.required_agents || []).length) return 'unconfigured';
    if (entry.compliant === false) return 'failed';
    return entry.compliant === true ? 'compliant' : 'unknown';
  }

  function badge(entry) {
    const state = resultState(entry);
    return `<span class="security-badge state-${state}">${states[state]}</span>`;
  }

  async function render(container) {
    allData = []; allPolicies = []; allGroups = []; allExceptions = []; ready = false; pending = new Set();
    container.innerHTML = `<div id="compliance-workspace" class="security-workspace">
      ${UI.securityNav('compliance')}
      <div class="page-header security-header"><div><span class="eyebrow">ASSESS / PRIORITIZE / GOVERN</span><h2>Compliance posture</h2><p class="page-subtitle">Turn inventory reports into clear, actionable policy results.</p></div><div class="page-actions"><button class="btn" onclick="API.exportCSV()">Export inventory CSV</button><button id="compliance-refresh" class="btn" onclick="Views.Compliance.reload()">${UI.icon('refresh')} Refresh</button><button id="policy-create" class="btn btn-primary" onclick="Views.Compliance.openPolicy()" disabled>${UI.icon('shield')} Add policy</button></div></div>
      <div id="compliance-summary" class="security-summary" aria-label="Compliance summary"></div>
      <section class="card security-results"><div class="section-heading"><div><h3 class="section-title">Host assessment</h3><p class="page-subtitle">Based on each host's latest report. Summary covers all returned hosts, before filters.</p></div><span id="compliance-count" class="text-muted" role="status"></span></div>
        <div class="security-filters compliance-filters">
          <label for="comp-search">Search hosts<input id="comp-search" type="search" placeholder="Hostname or group"></label>
          <label for="comp-group-filter">Group<select id="comp-group-filter"><option value="">All groups</option></select></label>
          <label for="comp-status-filter">Assessment<select id="comp-status-filter"><option value="">All assessments</option><option value="failed">Needs attention</option><option value="compliant">Compliant</option><option value="awaiting">Awaiting report</option><option value="unconfigured">No checks assigned</option><option value="unknown">Unknown result</option></select></label>
        </div>
        <div class="security-filter-footer"><span class="text-muted">Needs attention first. An exception waives a check; it does not fix the host.</span><button class="btn btn-sm" onclick="Views.Compliance.clearFilters()">Reset filters</button></div>
        <p id="compliance-action-status" role="status" class="security-feedback" hidden></p>
        <div class="table-wrap" tabindex="0" role="region" aria-label="Host compliance results"><table><thead><tr><th>Host / group</th><th>Assessment</th><th>Findings</th><th>Last report</th><th>Review</th></tr></thead><tbody id="compliance-tbody"></tbody></table></div>
      </section>
      <div class="security-governance">
        <section class="card"><div class="section-heading"><div><span class="eyebrow">CONFIGURATION</span><h3 class="section-title">Policy library</h3></div><span id="policy-count" class="text-muted"></span></div><p class="page-subtitle">Rules evaluated against inventory reports and assigned groups.</p><div id="compliance-policies-list"></div></section>
        <section class="card"><div class="section-heading"><div><span class="eyebrow">GOVERNANCE</span><h3 class="section-title">Policy exceptions</h3></div><span id="exception-count" class="text-muted"></span></div><p class="page-subtitle">Document accepted risks with a reason and optional expiry.</p><div id="compliance-exceptions-list"></div></section>
      </div></div>`;
    el('comp-search').addEventListener('input', applyFilters);
    ['comp-group-filter', 'comp-status-filter'].forEach(id => el(id).addEventListener('change', applyFilters));
    el('compliance-tbody').addEventListener('click', event => {
      const button = event.target.closest('button[data-host]');
      if (button && allData[Number(button.dataset.host)]) showDetail(allData[Number(button.dataset.host)].agent_id);
    });
    el('compliance-policies-list').addEventListener('click', event => {
      const button = event.target.closest('button[data-policy]');
      if (button && allPolicies[Number(button.dataset.policy)]) deletePolicy(allPolicies[Number(button.dataset.policy)].id);
    });
    el('compliance-exceptions-list').addEventListener('click', event => {
      const button = event.target.closest('button[data-exception]');
      if (button && allExceptions[Number(button.dataset.exception)]) deleteException(allExceptions[Number(button.dataset.exception)].id);
    });
    await reload();
  }

  async function reload() {
    const host = el('compliance-workspace');
    if (!host) return;
    const request = ++version;
    const current = () => request === version && el('compliance-workspace') === host;
    ready = false;
    el('compliance-refresh').disabled = true; el('policy-create').disabled = true;
    el('compliance-tbody').setAttribute('aria-busy', 'true');
    el('compliance-tbody').innerHTML = `<tr><td colspan="5">${UI.empty('Loading assessments', 'Fetching host results, policies and exceptions…', 'refresh')}</td></tr>`;
    el('compliance-summary').innerHTML = '<p class="security-summary-note" role="status">Loading compliance snapshot…</p>';
    ['compliance-count', 'policy-count', 'exception-count'].forEach(id => { el(id).textContent = ''; });
    ['compliance-policies-list', 'compliance-exceptions-list'].forEach(id => { el(id).innerHTML = '<p class="security-summary-note">Loading…</p>'; });
    try {
      const [c, g, p, e] = await Promise.all([API.getCompliance(), API.listGroups(), API.listCompliancePolicies(), API.listComplianceExceptions()]);
      if (!current()) return;
      allData = c?.data || []; allGroups = g?.data || []; allPolicies = p?.data || []; allExceptions = e?.data || [];
      ready = true;
      const filter = el('comp-group-filter');
      const selected = filter.value;
      filter.innerHTML = '<option value="">All groups</option><option value="__ungrouped__">No group</option>' + groupOptions();
      filter.value = selected === '__ungrouped__' || allGroups.some(g => g.id === selected) ? selected : '';
      const counts = allData.reduce((acc, entry) => { const key = resultState(entry); acc[key] = (acc[key] || 0) + 1; return acc; }, {});
      el('compliance-summary').innerHTML = UI.securityMetric('Hosts in scope', allData.length, 'Returned by the compliance API', '', 'server') +
        UI.securityMetric('Needs attention', counts.failed || 0, 'Hosts with reported failures', 'risk', 'pulse') +
        UI.securityMetric('Compliant', counts.compliant || 0, 'Report and assigned checks present') +
        UI.securityMetric('Not assessed', (counts.awaiting || 0) + (counts.unconfigured || 0) + (counts.unknown || 0), 'Missing reports, checks or results', 'caution', 'history');
      renderPolicies(); renderExceptions(); applyFilters();
    } catch (err) {
      if (!current()) return;
      allData = []; allPolicies = []; allExceptions = []; allGroups = [];
      el('compliance-summary').innerHTML = '<p class="security-summary-note">Snapshot unavailable — compliance is not known.</p>';
      el('compliance-tbody').innerHTML = `<tr><td colspan="5"><div role="alert">${UI.empty('Unable to load compliance', esc(err.message), 'shield')}<div class="security-empty-action"><button class="btn" onclick="Views.Compliance.reload()">Try again</button></div></div></td></tr>`;
      ['compliance-policies-list', 'compliance-exceptions-list'].forEach(id => { el(id).innerHTML = '<p class="security-summary-note">Unavailable. Retry the snapshot to load this section.</p>'; });
    } finally {
      if (current()) { el('compliance-refresh').disabled = false; el('policy-create').disabled = !ready; el('compliance-tbody').setAttribute('aria-busy', 'false'); }
    }
  }

  function groupOptions() { return allGroups.map(g => `<option value="${attr(g.id)}">${esc(g.name)}</option>`).join(''); }

  function applyFilters() {
    if (!ready || !el('compliance-tbody')) return;
    const query = el('comp-search').value.trim().toLowerCase(), group = el('comp-group-filter').value, status = el('comp-status-filter').value;
    const filtered = allData.filter(entry => (!query || [entry.hostname, entry.group_name].some(v => String(v || '').toLowerCase().includes(query))) &&
      (!group || (group === '__ungrouped__' ? !entry.group_id : entry.group_id === group)) && (!status || resultState(entry) === status));
    const order = {failed: 0, awaiting: 1, unknown: 2, unconfigured: 3, compliant: 4};
    filtered.sort((a, b) => order[resultState(a)] - order[resultState(b)] || String(a.hostname).localeCompare(String(b.hostname), undefined, {numeric: true}));
    el('compliance-count').textContent = `${filtered.length} of ${allData.length} hosts`;
    if (!filtered.length) {
      el('compliance-tbody').innerHTML = `<tr><td colspan="5">${UI.empty(allData.length ? 'No matching hosts' : 'Your assessment starts with inventory', allData.length ? 'Adjust the group, assessment or search to find a host.' : 'Connect an agent and receive its first inventory report, then assign policies to assess it.', 'shield')}<div class="security-empty-action">${allData.length ? '<button class="btn" onclick="Views.Compliance.clearFilters()">Reset filters</button>' : '<a class="btn btn-primary" href="#packages">Get agent</a><a class="btn" href="#servers">Open inventory</a>'}</div></td></tr>`;
      return;
    }
    el('compliance-tbody').innerHTML = filtered.map(entry => {
      const index = allData.indexOf(entry);
      const failed = (entry.failed_policies || []).filter(p => !p.excepted).length;
      const missing = (entry.missing_agents || []).length;
      const exceptions = (entry.exceptions || []).length;
      const assessed = ['compliant', 'failed'].includes(resultState(entry));
      return `<tr><td><button class="security-title-link" data-host="${index}">${esc(entry.hostname)}</button><span class="security-row-meta">${esc(entry.group_name || 'No group')} / ${esc(entry.status || 'Unknown connection')}</span></td><td>${badge(entry)}</td><td>${assessed ? `<strong>${failed}</strong> failed policies · <strong>${missing}</strong> missing agents${exceptions ? `<span class="security-row-meta">${exceptions} exceptions applied</span>` : ''}` : '<span class="text-muted">Assessment unavailable</span>'}</td><td>${entry.last_report_at ? esc(App.timeAgo(entry.last_report_at)) : 'No report received'}</td><td><button class="btn btn-sm" data-host="${index}">Review host</button></td></tr>`;
    }).join('');
  }

  function clearFilters() {
    ['comp-search', 'comp-group-filter', 'comp-status-filter'].forEach(id => { el(id).value = ''; });
    applyFilters();
  }

  function renderPolicies() {
    el('policy-count').textContent = `${allPolicies.length} policies`;
    el('compliance-policies-list').innerHTML = allPolicies.length ? allPolicies.map((p, index) => `<article class="security-list-item"><div><strong>${esc(p.name)}</strong><p class="security-row-meta">${esc(p.policy_type)} · ${esc(p.group_name || 'All groups')}</p><p class="security-rule">${esc(p.subject)}${p.expected_value ? ` → ${esc(p.expected_value)}` : ''}</p><div class="security-detail-badges">${UI.severity(p.severity)}<span class="text-muted">${p.enabled ? 'Enabled' : 'Disabled'}</span></div></div><button class="btn btn-sm btn-danger" data-policy="${index}" ${pending.has('policy:' + p.id) ? 'disabled' : ''} aria-label="Delete policy: ${attr(p.name)}">Delete</button></article>`).join('') : `${UI.empty('Define what good looks like', 'Add a policy for services, security agents, packages or system settings. It will be evaluated against inventory reports.', 'shield')}<div class="security-empty-action"><button class="btn" onclick="Views.Compliance.openPolicy()">Add your first policy</button></div>`;
  }

  function renderExceptions() {
    el('exception-count').textContent = `${allExceptions.length} exceptions`;
    el('compliance-exceptions-list').innerHTML = allExceptions.length ? allExceptions.map((item, index) => {
      const expired = item.expires_at && Date.parse(item.expires_at) <= Date.now();
      return `<article class="security-list-item"><div><strong>${esc(allPolicies.find(p => p.id === item.policy_id)?.name || item.policy_id)}</strong><p class="security-row-meta">${esc(allData.find(h => h.agent_id === item.agent_id)?.hostname || item.agent_id)}</p><p class="security-rule">${esc(item.reason)}</p><span class="security-badge ${expired ? 'state-awaiting' : 'state-acknowledged'}">${expired ? 'Expired' : item.expires_at ? 'Time limited' : 'No expiry'}</span><p class="security-row-meta">${item.expires_at ? esc(App.formatDate(item.expires_at)) : 'Review this accepted risk regularly.'}</p></div><button class="btn btn-sm btn-danger" data-exception="${index}" ${pending.has('exception:' + item.id) ? 'disabled' : ''} aria-label="Delete exception for ${attr(allData.find(h => h.agent_id === item.agent_id)?.hostname || item.agent_id)}">Delete</button></article>`;
    }).join('') : UI.empty('No policy exceptions', 'Review a host with a failed policy to document an exception and its reason.', 'history');
  }

  function showDetail(id) {
    const entry = allData.find(h => h.agent_id === id);
    if (!ready || !entry) return;
    const results = entry.policy_results || [];
    const assessed = ['failed', 'compliant'].includes(resultState(entry));
    const dialog = UI.dialog(el('compliance-workspace'), entry.hostname || 'Host assessment', `
      <div class="security-detail-badges">${badge(entry)}<span class="text-muted">${esc(entry.group_name || 'No group')}</span></div>
      <dl class="security-facts"><div><dt>Last report</dt><dd>${entry.last_report_at ? esc(App.formatDate(entry.last_report_at)) : 'No report received'}</dd></div><div><dt>Connection</dt><dd>${esc(entry.status || 'Unknown')}</dd></div></dl>
      ${!assessed ? `<div class="security-notice">${esc(states[resultState(entry)])}. ${resultState(entry) === 'awaiting' ? 'Receive an inventory report before interpreting policy results.' : 'Assign checks and receive a report to establish compliance.'}</div>` : ''}
      <h4 class="section-title">Required security agents</h4><p class="security-message">${!assessed ? 'Not assessed.' : (entry.missing_agents || []).length ? `Missing: ${entry.missing_agents.map(esc).join(', ')}` : (entry.required_agents || []).length ? `Present: ${entry.required_agents.map(esc).join(', ')}` : 'No required security agents configured for this group.'}</p>
      <h4 class="section-title">Policy evidence</h4>${assessed && results.length ? results.map((result, index) => `<article class="security-list-item"><div><strong>${esc(result.name)}</strong><div class="security-detail-badges">${UI.severity(result.severity)}<span class="security-badge state-${result.excepted ? 'acknowledged' : result.compliant ? 'compliant' : 'failed'}">${result.excepted ? 'Excepted' : result.compliant ? 'Passed' : 'Failed'}</span></div><p class="security-rule">${esc(result.message)}</p>${result.excepted ? `<p class="security-row-meta">Reason: ${esc(result.exception_reason || 'Not supplied')}${result.exception_expires_at ? ` · Expires ${esc(App.formatDate(result.exception_expires_at))}` : ' · No expiry'}</p>` : ''}</div>${!result.compliant && !result.excepted ? `<button class="btn btn-sm" data-add-exception="${index}">Add exception</button>` : ''}</article>`).join('') : UI.empty('No evaluated policy evidence', 'Policies need an applicable scope and an inventory report.', 'shield')}`);
    dialog.querySelectorAll('[data-add-exception]').forEach(button => button.addEventListener('click', () => {
      const result = results[Number(button.dataset.addException)];
      addException(entry.agent_id, result.policy_id, result.name);
    }));
  }

  function openPolicy() {
    if (!ready) return;
    const dialog = UI.dialog(el('compliance-workspace'), 'Create compliance policy', `<p class="page-subtitle">Define a check for all hosts or one group. New policies are enabled immediately.</p>
      <form id="policy-form" class="security-form">
        <label for="policy-name">Policy name<input id="policy-name" required maxlength="200" placeholder="A recognizable rule name"></label>
        <div class="security-form-grid"><label for="policy-group-id">Scope<select id="policy-group-id"><option value="">All groups</option>${groupOptions()}</select></label><label for="policy-type">Check type<select id="policy-type">${types.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label></div>
        <label for="policy-subject">Subject<input id="policy-subject" required aria-describedby="policy-subject-help" placeholder="Service, package, security agent or system subject"></label><p id="policy-subject-help" class="text-muted">The subject identifies what to check, such as a service name or package name.</p>
        <div class="security-form-grid"><label for="policy-expected">Expected value<input id="policy-expected" aria-describedby="policy-expected-help" placeholder="Value required by this check"></label><label for="policy-severity">Severity<select id="policy-severity"><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option><option value="low">Low</option></select></label></div><p id="policy-expected-help" class="text-muted"></p>
        <p data-action-status class="security-feedback" role="status" hidden></p><button type="submit" class="btn btn-primary" data-save>Create policy</button>
      </form>`);
    dialog.querySelector('form').addEventListener('submit', event => { event.preventDefault(); createPolicy(dialog); });
    dialog.querySelector('#policy-type').addEventListener('change', () => updatePolicyHelp(dialog));
    updatePolicyHelp(dialog);
  }

  function updatePolicyHelp(dialog) {
    const [subject, expected, unused] = guidance[dialog.querySelector('#policy-type').value];
    dialog.querySelector('#policy-subject-help').textContent = subject;
    dialog.querySelector('#policy-expected-help').textContent = expected;
    dialog.querySelector('#policy-expected').disabled = !!unused;
  }

  async function createPolicy(dialog = el('compliance-workspace')?.querySelector('.security-dialog')) {
    if (!dialog?.isConnected) return;
    const value = id => dialog.querySelector('#' + id).value.trim();
    const name = value('policy-name'), subject = value('policy-subject');
    if (!name || !subject) { formError(dialog, 'Name and subject are required.'); return; }
    const data = {name, subject, group_id: value('policy-group-id'), policy_type: value('policy-type'), expected_value: value('policy-expected'), severity: value('policy-severity'), enabled: true};
    if (guidance[data.policy_type]?.[2]) data.expected_value = '';
    if (data.expected_value && ['patch_compliance', 'local_admin_count', 'certificate_expiry'].includes(data.policy_type) && !/^\d+$/.test(data.expected_value)) {
      formError(dialog, 'Expected value must be a non-negative whole number, or blank for the default.'); return;
    }
    if (data.expected_value && ['firewall_enabled', 'remote_access_disabled'].includes(data.policy_type) && !/^(true|false)$/i.test(data.expected_value)) {
      formError(dialog, 'Expected value must be true, false, or blank for the default.'); return;
    }
    if (data.policy_type === 'remote_access_disabled' && !/^(rdp|winrm|ssh)$/i.test(subject)) {
      formError(dialog, 'Remote access subject must be RDP, WinRM or SSH.'); return;
    }
    await saveForm(dialog, () => API.createCompliancePolicy(data), 'Policy created.');
  }

  function addException(agentId, policyId, policyName) {
    if (!ready) return;
    const host = allData.find(h => h.agent_id === agentId);
    const result = host?.policy_results?.find(p => p.policy_id === policyId && !p.compliant && !p.excepted);
    if (!host || !result || resultState(host) !== 'failed') return;
    const dialog = UI.dialog(el('compliance-workspace'), 'Document a policy exception', `<div class="security-notice">This waives one policy for one host. It does not remediate the finding.</div><dl class="security-facts"><div><dt>Host</dt><dd>${esc(host.hostname)}</dd></div><div><dt>Policy</dt><dd>${esc(policyName)}</dd></div></dl>
      <form id="exception-form" class="security-form"><label for="exception-reason">Reason<textarea id="exception-reason" rows="4" required placeholder="Explain why this risk is accepted"></textarea></label><label for="exception-expiry">Expires at (optional, your local time)<input id="exception-expiry" type="datetime-local" aria-describedby="exception-expiry-help"></label><p id="exception-expiry-help" class="text-muted">Leave empty for no expiry. A selected time is sent to the server in UTC.</p><p data-action-status role="status" class="security-feedback" hidden></p><button type="submit" class="btn btn-primary" data-save>Save exception</button></form>`);
    dialog.querySelector('form').addEventListener('submit', event => { event.preventDefault(); saveException(dialog, agentId, policyId); });
  }

  async function saveException(dialog, agentId, policyId) {
    if (!dialog?.isConnected) return;
    const reason = dialog.querySelector('#exception-reason').value.trim();
    const raw = dialog.querySelector('#exception-expiry').value;
    if (!reason) { formError(dialog, 'An exception reason is required.'); return; }
    const date = raw ? new Date(raw) : null;
    if (date && (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now())) { formError(dialog, 'Choose a valid expiry in the future.'); return; }
    await saveForm(dialog, () => API.createComplianceException({agent_id: agentId, policy_id: policyId, reason, expires_at: date ? date.toISOString() : ''}), 'Exception saved.');
  }

  function formError(dialog, message) {
    const status = dialog.querySelector('[data-action-status]');
    status.hidden = false; status.textContent = message;
  }

  async function saveForm(dialog, operation, message) {
    const button = dialog.querySelector('[data-save]');
    if (button.disabled) return;
    const host = el('compliance-workspace');
    button.disabled = true; formError(dialog, 'Saving…');
    try {
      await operation();
      if (el('compliance-workspace') !== host) return;
      dialog.close();
      announce(message);
      await reload();
    } catch (err) {
      if (el('compliance-workspace') === host) {
        if (dialog.isConnected) formError(dialog, `Unable to save: ${err.message}`);
        else announce(`Unable to save: ${err.message}`);
      }
    } finally { button.disabled = false; }
  }

  function announce(message) { el('compliance-action-status').hidden = false; el('compliance-action-status').textContent = message; }

  async function remove(kind, id) {
    const host = el('compliance-workspace');
    const items = kind === 'policy' ? allPolicies : allExceptions;
    const item = items.find(i => i.id === id), key = kind + ':' + id;
    if (!ready || !host || !item || pending.has(key)) return;
    if (!confirm(kind === 'policy' ? `Delete policy "${item.name}"? Its check will no longer apply.` : 'Delete this exception? The policy will apply to the host again.')) return;
    const operations = pending;
    operations.add(key); renderPolicies(); renderExceptions();
    announce('Deleting…');
    try {
      await (kind === 'policy' ? API.deleteCompliancePolicy(id) : API.deleteComplianceException(id));
      if (el('compliance-workspace') !== host) return;
      announce(kind === 'policy' ? 'Policy deleted.' : 'Exception deleted.');
      await reload();
    } catch (err) { if (el('compliance-workspace') === host) announce(`Unable to delete: ${err.message}`); }
    finally { operations.delete(key); if (el('compliance-workspace') === host && ready) { renderPolicies(); renderExceptions(); } }
  }

  return {render, reload, applyFilters, clearFilters, resultState, showDetail, openPolicy, createPolicy, addException, saveException,
    deletePolicy: id => remove('policy', id), deleteException: id => remove('exception', id)};
})();
