'use strict';

Views.Audit = (() => {
  async function render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2>Audit Log</h2>
        <div class="page-actions">
          <button class="btn btn-sm" onclick="Views.Audit.reload()">&#8635; Refresh</button>
        </div>
      </div>
      <div class="card mb-2">
        <div class="filters">
          <input type="text" id="audit-user" placeholder="Username filter" style="width:150px">
          <input type="text" id="audit-action" placeholder="Action filter" style="width:200px">
          <input type="datetime-local" id="audit-from" style="width:190px">
          <input type="datetime-local" id="audit-to" style="width:190px">
          <button class="btn btn-sm" onclick="Views.Audit.reload()">Filter</button>
        </div>
      </div>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Time</th><th>User</th><th>IP</th><th>Action</th><th>Resource</th><th>Result</th>
            </tr></thead>
            <tbody id="audit-tbody">
              <tr><td colspan="6" class="text-center"><span class="spinner"></span></td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
    await reload();
  }

  async function reload() {
    const params = {};
    const user = document.getElementById('audit-user') ? document.getElementById('audit-user').value : '';
    const action = document.getElementById('audit-action') ? document.getElementById('audit-action').value : '';
    const from = document.getElementById('audit-from') ? document.getElementById('audit-from').value : '';
    const to = document.getElementById('audit-to') ? document.getElementById('audit-to').value : '';
    if (user) params.user_id = user;
    if (action) params.action = action;
    if (from) params.from = new Date(from).toISOString();
    if (to) params.to = new Date(to).toISOString();

    try {
      const resp = await API.listAudit(params);
      const entries = (resp && resp.data) ? resp.data : [];
      const tbody = document.getElementById('audit-tbody');
      if (!tbody) return;
      if (!entries.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted" style="padding:2rem">No audit entries</td></tr>';
        return;
      }
      tbody.innerHTML = entries.map(e => `
        <tr>
          <td>${App.formatDate(e.created_at)}</td>
          <td>${App.escHtml(e.username || '-')}</td>
          <td class="monospace text-muted">${App.escHtml(e.ip || '-')}</td>
          <td class="monospace">${App.escHtml(e.action)}</td>
          <td>${App.escHtml(e.resource || '-')}</td>
          <td><span style="color:${e.result === 'success' ? '#22c55e' : '#ef4444'}">${e.result}</span></td>
        </tr>
      `).join('');
    } catch (err) {
      const tbody = document.getElementById('audit-tbody');
      if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="error-msg">${App.escHtml(err.message)}</td></tr>`;
    }
  }

  return { render, reload };
})();
