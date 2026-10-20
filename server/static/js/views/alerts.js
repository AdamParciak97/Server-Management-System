'use strict';

Views.Alerts = (() => {
  let alerts = [];
  let version = 0;
  let ready = false;
  let pending = new Set();
  const el = id => document.getElementById(id);
  const state = item => item.resolved ? 'resolved' : item.acknowledged ? 'acknowledged' : 'active';
  const priority = {critical: 0, high: 1, medium: 2, low: 3};

  async function render(container) {
    alerts = []; ready = false; pending = new Set();
    container.innerHTML = `<div id="alerts-workspace" class="security-workspace">
      ${UI.securityNav('alerts')}
      <div class="page-header security-header"><div><span class="eyebrow">DETECT / REVIEW / RESPOND</span><h2>Alert inbox</h2><p class="page-subtitle">See what needs attention. Keep the context behind every signal.</p></div><button id="alerts-refresh" class="btn" onclick="Views.Alerts.reload()">${UI.icon('refresh')} Refresh</button></div>
      <div id="alerts-summary" class="security-summary" aria-label="Alert summary"></div>
      <section class="card security-results"><div class="section-heading"><div><h3 class="section-title">Signals to investigate</h3><p id="alerts-scope" class="page-subtitle"></p></div><span id="alerts-count" class="text-muted" role="status"></span></div>
        <div class="security-filters">
          <label for="alert-search">Search signals<input id="alert-search" type="search" placeholder="Host, title, type or message"></label>
          <label for="alert-filter">Inbox<select id="alert-filter"><option value="active">Active alerts</option><option value="all">All alerts / history</option></select></label>
          <label for="alert-severity">Severity<select id="alert-severity"><option value="">All severities</option><option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
          <label for="alert-sort">Sort by<select id="alert-sort"><option value="priority">Highest severity</option><option value="newest">Newest first</option></select></label>
        </div>
        <div class="security-filter-footer"><span class="text-muted">Acknowledging records a review; it does not resolve the cause.</span><button class="btn btn-sm" onclick="Views.Alerts.clearFilters()">Reset filters</button></div>
        <p id="alerts-action-status" role="status" class="security-feedback" hidden></p>
        <div class="table-wrap" tabindex="0" role="region" aria-label="Alerts table"><table><thead><tr><th>Signal / host</th><th>Severity</th><th>Created</th><th>Status</th><th>Review</th></tr></thead><tbody id="alerts-tbody"></tbody></table></div>
      </section></div>`;
    el('alert-filter').addEventListener('change', reload);
    el('alert-search').addEventListener('input', applyFilters);
    ['alert-severity', 'alert-sort'].forEach(id => el(id).addEventListener('change', applyFilters));
    el('alerts-tbody').addEventListener('click', event => {
      const button = event.target.closest('button[data-alert]');
      if (!button) return;
      const item = alerts[Number(button.dataset.alert)];
      if (!item) return;
      if (button.dataset.action === 'ack') acknowledge(item.id);
      else showDetail(item.id);
    });
    await reload();
  }

  async function reload() {
    const host = el('alerts-workspace');
    if (!host) return;
    const request = ++version;
    const current = () => request === version && el('alerts-workspace') === host;
    ready = false;
    el('alerts-refresh').disabled = true;
    el('alerts-tbody').setAttribute('aria-busy', 'true');
    el('alerts-tbody').innerHTML = `<tr><td colspan="5">${UI.empty('Loading signals', 'Fetching the selected inbox…', 'refresh')}</td></tr>`;
    el('alerts-summary').innerHTML = '<p class="security-summary-note" role="status">Loading alert snapshot…</p>';
    el('alerts-count').textContent = '';
    const active = el('alert-filter').value !== 'all';
    el('alerts-scope').textContent = `Latest 500 ${active ? 'active alerts' : 'alerts across all states'} at most. Summary uses this snapshot, before local filters.`;
    try {
      const response = await API.listAlerts(active);
      if (!current()) return;
      alerts = response?.data || [];
      ready = true;
      const activeItems = alerts.filter(a => state(a) === 'active');
      el('alerts-summary').innerHTML =
        UI.securityMetric('Active in snapshot', activeItems.length, 'Awaiting review', '', 'bell') +
        UI.securityMetric('Critical / high', activeItems.filter(a => ['critical', 'high'].includes(a.severity)).length, 'Active priority signals', 'risk', 'pulse') +
        UI.securityMetric('Affected hosts', new Set(activeItems.map(a => a.agent_id).filter(Boolean)).size, 'Unique hosts with active alerts', '', 'server') +
        UI.securityMetric('In this snapshot', alerts.length, active ? 'Active inbox selected' : 'Includes acknowledged and resolved', '', 'history');
      applyFilters();
    } catch (err) {
      if (!current()) return;
      alerts = [];
      el('alerts-summary').innerHTML = '<p class="security-summary-note">Snapshot unavailable — counts are not known.</p>';
      el('alerts-tbody').innerHTML = `<tr><td colspan="5"><div role="alert">${UI.empty('Unable to load alerts', App.escHtml(err.message), 'bell')}<div class="security-empty-action"><button class="btn" onclick="Views.Alerts.reload()">Try again</button></div></div></td></tr>`;
    } finally {
      if (current()) { el('alerts-refresh').disabled = false; el('alerts-tbody').setAttribute('aria-busy', 'false'); }
    }
  }

  function applyFilters() {
    if (!ready || !el('alerts-tbody')) return;
    const query = el('alert-search').value.trim().toLowerCase();
    const severity = el('alert-severity').value;
    const filtered = alerts.filter(a => (!severity || a.severity === severity) &&
      [a.hostname, a.title, a.type, a.message].some(v => String(v || '').toLowerCase().includes(query)));
    filtered.sort((a, b) => (el('alert-sort').value === 'priority' ? (priority[a.severity] ?? 4) - (priority[b.severity] ?? 4) : 0) || (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0));
    el('alerts-count').textContent = `${filtered.length} of ${alerts.length} signals`;
    if (!filtered.length) {
      const isFiltered = alerts.length > 0;
      el('alerts-tbody').innerHTML = `<tr><td colspan="5">${UI.empty(isFiltered ? 'No matching signals' : 'No alerts in this inbox', isFiltered ? 'Try another phrase or clear the severity filter.' : 'Alerts appear when the server detects events from your infrastructure. An empty inbox does not confirm fleet health.', 'bell')}<div class="security-empty-action">${isFiltered ? '<button class="btn" onclick="Views.Alerts.clearFilters()">Reset filters</button>' : '<a class="btn" href="#servers">Inspect inventory</a><a class="btn" href="#compliance">Review compliance</a>'}</div></td></tr>`;
      return;
    }
    el('alerts-tbody').innerHTML = filtered.map(a => {
      const index = alerts.indexOf(a);
      return `<tr><td><button class="security-title-link" data-alert="${index}" data-action="detail">${App.escHtml(a.title || 'Untitled alert')}</button><span class="security-row-meta">${App.escHtml(a.hostname || 'System event')} <span aria-hidden="true">/</span> ${App.escHtml(a.type)}</span></td><td>${UI.severity(a.severity)}</td><td>${App.escHtml(App.timeAgo(a.created_at))}</td><td>${statusBadge(a)}</td><td><div class="security-row-actions"><button class="btn btn-sm" data-alert="${index}" data-action="detail">Details</button>${state(a) === 'active' ? `<button class="btn btn-sm" data-alert="${index}" data-action="ack" ${pending.has(a.id) ? 'disabled' : ''}>${pending.has(a.id) ? 'Saving…' : 'Acknowledge'}</button>` : ''}</div></td></tr>`;
    }).join('');
  }

  function statusBadge(item) {
    const value = state(item);
    return `<span class="security-badge state-${value}">${value === 'active' ? 'Active' : value === 'resolved' ? 'Resolved' : 'Acknowledged'}</span>`;
  }

  function clearFilters() {
    el('alert-search').value = ''; el('alert-severity').value = ''; el('alert-sort').value = 'priority';
    applyFilters();
  }

  async function acknowledge(id, dialog) {
    const host = el('alerts-workspace');
    const item = alerts.find(a => a.id === id);
    if (!host || !ready || !item || state(item) !== 'active' || pending.has(id)) return;
    const operations = pending;
    operations.add(id);
    applyFilters();
    const feedback = dialog ? dialog.querySelector('[data-action-status]') : el('alerts-action-status');
    const button = dialog?.querySelector('[data-acknowledge]');
    if (button) button.disabled = true;
    feedback.hidden = false; feedback.textContent = 'Saving acknowledgement…';
    try {
      await API.acknowledgeAlert(id);
      if (el('alerts-workspace') !== host) return;
      dialog?.close();
      el('alerts-action-status').hidden = false;
      el('alerts-action-status').textContent = 'Alert acknowledged. The underlying cause remains unchanged.';
      await reload();
    } catch (err) {
      if (el('alerts-workspace') === host) {
        const target = dialog?.isConnected ? feedback : el('alerts-action-status');
        target.hidden = false; target.textContent = `Unable to acknowledge: ${err.message}`;
      }
    } finally {
      operations.delete(id);
      if (el('alerts-workspace') === host) { if (button) button.disabled = false; applyFilters(); }
    }
  }

  function showDetail(id) {
    const item = alerts.find(a => a.id === id);
    if (!ready || !item) return;
    const dialog = UI.dialog(el('alerts-workspace'), item.title || 'Alert details', `
      <div class="security-detail-badges">${UI.severity(item.severity)}${statusBadge(item)}</div>
      <dl class="security-facts"><div><dt>Host</dt><dd>${App.escHtml(item.hostname || 'System event')}</dd></div><div><dt>Type</dt><dd>${App.escHtml(item.type)}</dd></div><div><dt>Created</dt><dd>${App.escHtml(App.formatDate(item.created_at))}</dd></div><div><dt>Alert ID</dt><dd class="monospace">${App.escHtml(item.id)}</dd></div>${item.acknowledged ? `<div><dt>Acknowledged</dt><dd>${App.escHtml(App.formatDate(item.acknowledged_at))}</dd></div>` : ''}${item.resolved ? `<div><dt>Resolved</dt><dd>${App.escHtml(App.formatDate(item.resolved_at))}</dd></div>` : ''}</dl>
      <h4 class="section-title">Event message</h4><p class="security-message">${App.escHtml(item.message || 'No additional message was provided.')}</p>
      <p data-action-status role="status" class="security-feedback" hidden></p>
      ${state(item) === 'active' ? `<div class="security-dialog-footer"><p class="text-muted">Record that this alert has been reviewed. This does not resolve it.</p><button class="btn btn-primary" data-acknowledge ${pending.has(id) ? 'disabled' : ''}>Acknowledge alert</button></div>` : ''}`);
    dialog.querySelector('[data-acknowledge]')?.addEventListener('click', () => acknowledge(id, dialog));
  }

  return {render, reload, applyFilters, clearFilters, acknowledge, showDetail};
})();
