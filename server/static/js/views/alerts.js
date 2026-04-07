'use strict';

Views.Alerts = (() => {
  async function render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2>Alerts</h2>
        <div class="page-actions">
          <button class="btn btn-sm" onclick="Views.Alerts.reload()">&#8635; Refresh</button>
        </div>
      </div>
      <div class="filters">
        <select id="alert-filter">
          <option value="active">Active Alerts</option>
          <option value="all">All Alerts</option>
        </select>
      </div>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Server</th><th>Type</th><th>Severity</th><th>Title</th><th>Created</th><th>Status</th><th>Actions</th>
            </tr></thead>
            <tbody id="alerts-tbody">
              <tr><td colspan="7" class="text-center"><span class="spinner"></span></td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
    document.getElementById('alert-filter').addEventListener('change', () => Views.Alerts.reload());
    await reload();
  }

  async function reload() {
    const filterEl = document.getElementById('alert-filter');
    const active = !filterEl || filterEl.value !== 'all';
    try {
      const resp = await API.listAlerts(active);
      const alerts = (resp && resp.data) ? resp.data : [];
      renderTable(alerts);
    } catch (err) {
      document.getElementById('alerts-tbody').innerHTML =
        `<tr><td colspan="7" class="error-msg">${App.escHtml(err.message)}</td></tr>`;
    }
  }

  const severityColors = { critical: '#ef4444', high: '#f59e0b', medium: '#06b6d4', low: '#94a3b8' };

  function renderTable(alerts) {
    const tbody = document.getElementById('alerts-tbody');
    if (!tbody) return;
    if (!alerts || alerts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted" style="padding:2rem">No alerts found</td></tr>';
      return;
    }
    tbody.innerHTML = alerts.map(a => `
      <tr>
        <td>${App.escHtml(a.hostname || '-')}</td>
        <td class="monospace">${App.escHtml(a.type)}</td>
        <td><span style="color:${severityColors[a.severity] || '#fff'}">${a.severity}</span></td>
        <td>${App.escHtml(a.title)}</td>
        <td>${App.timeAgo(a.created_at)}</td>
        <td>${a.acknowledged ? '<span class="text-muted">Acknowledged</span>' :
          a.resolved ? '<span style="color:#22c55e">Resolved</span>' : '<span style="color:#f59e0b">Active</span>'}</td>
        <td>
          ${!a.acknowledged && !a.resolved ?
            `<button class="btn btn-sm" onclick="Views.Alerts.acknowledge('${a.id}')">Acknowledge</button>` : ''}
          <button class="btn btn-sm" onclick="Views.Alerts.showDetail('${a.id}', ${JSON.stringify(a).replace(/"/g,'&quot;')})">Detail</button>
        </td>
      </tr>
    `).join('');
  }

  async function acknowledge(id) {
    try {
      await API.acknowledgeAlert(id);
      await reload();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  function showDetail(id, alert) {
    App.showModal('Alert Detail', `
      <p><strong>ID:</strong> <span class="monospace">${App.escHtml(id)}</span></p>
      <p><strong>Server:</strong> ${App.escHtml(alert.hostname || '-')}</p>
      <p><strong>Type:</strong> ${App.escHtml(alert.type)}</p>
      <p><strong>Severity:</strong> ${App.escHtml(alert.severity)}</p>
      <p><strong>Title:</strong> ${App.escHtml(alert.title)}</p>
      <p><strong>Message:</strong> ${App.escHtml(alert.message)}</p>
      <p><strong>Created:</strong> ${App.formatDate(alert.created_at)}</p>
      ${alert.acknowledged ? `<p><strong>Acknowledged:</strong> ${App.formatDate(alert.acknowledged_at)}</p>` : ''}
    `);
  }

  return { render, reload, acknowledge, showDetail };
})();
