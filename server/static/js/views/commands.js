'use strict';

Views.Commands = (() => {
  let servers = [];
  let groups = [];
  let packages = [];
  let templates = [];
  let scheduledCommands = [];
  let maintenanceWindows = [];
  const servicesByAgent = {};

  let history = [], historyReady = false;
  let referencesReady = false;
  let referenceError = '';
  let loadSequence = 0, historySequence = 0, scheduleSequence = 0, referenceSequence = 0, detailSequence = 0, composerSequence = 0;
  const pendingActions = new Set();
  const esc = value => App.escHtml(String(value ?? '')).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const workspace = () => document.getElementById('commands-workspace');
  const current = host => !!host && host === document.getElementById(host.id) && host.isConnected;
  const statuses = ['awaiting_approval', 'pending', 'sent', 'running', 'success', 'error', 'timeout', 'cancelled', 'unknown'];
  const label = value => toTitle(value || 'unknown');
  const data = response => Array.isArray(response?.data) ? response.data : [];
  const loading = text => `<div class="security-summary-note" role="status"><span class="spinner"></span> ${text}</div>`;
  const emptyRow = (columns, title, description, action = '') => `<tr><td colspan="${columns}">${UI.empty(title, description, 'terminal')}${action ? `<div class="security-empty-action">${action}</div>` : ''}</td></tr>`;
  const retry = '<button class="btn" onclick="Views.Commands.reload()">Retry loading</button>';

  async function render(container) {
    history = []; historyReady = false; referencesReady = false; referenceError = '';
    servers = []; groups = []; packages = []; templates = []; maintenanceWindows = []; scheduledCommands = [];
    Object.keys(servicesByAgent).forEach(key => delete servicesByAgent[key]);
    container.innerHTML = `
      <section id="commands-workspace" class="commands-workspace">
        <header class="page-header security-header">
          <div><span class="eyebrow">OPERATIONS / EXECUTION</span><h2>Commands</h2><p class="page-subtitle">From intent to result. Queue work, review execution and plan maintenance.</p></div>
          <div class="page-actions"><button id="commands-refresh" class="btn" onclick="Views.Commands.reload()">${UI.icon('refresh')} Refresh</button><button id="commands-create" class="btn btn-primary" onclick="Views.Commands.showCreateModal()">${UI.icon('terminal')} New command</button></div>
        </header>
        <div id="commands-feedback" class="security-feedback" role="status" hidden></div>
        <div id="commands-summary" class="security-summary" aria-label="Loaded command summary">${loading('Loading command history...')}</div>
        <div class="commands-layout">
          <section class="card security-results commands-history">
            <div class="section-heading"><div><span class="eyebrow">EXECUTION LEDGER</span><h3 class="section-title">Command history</h3></div><span id="commands-count" role="status"></span></div>
            <div class="security-filters commands-filters">
              <label>Search history<input id="cmd-search" type="search" placeholder="Target, type, ID or output" oninput="Views.Commands.applyFilters()"></label>
              <label>Status<select id="cmd-filter-status" onchange="Views.Commands.applyFilters()"><option value="">All statuses</option>${statuses.map(status => `<option value="${status}">${label(status)}</option>`).join('')}</select></label>
              <label>Order<select id="cmd-sort" onchange="Views.Commands.applyFilters()"><option value="newest">Newest first</option><option value="attention">Needs attention first</option><option value="oldest">Oldest first</option></select></label>
            </div>
            <div class="security-filter-footer"><p class="text-muted">Latest 100 commands returned by the API. Summary covers this loaded history, before filters.</p><button class="btn btn-sm" onclick="Views.Commands.clearFilters()">Reset filters</button></div>
            <div class="table-wrap" tabindex="0" role="region" aria-label="Command history; scroll for all columns"><table><thead><tr><th>Command / target</th><th>Priority</th><th>Status</th><th>Result</th><th>Created</th><th>Actions</th></tr></thead><tbody id="commands-tbody"><tr><td colspan="6">${loading('Loading commands...')}</td></tr></tbody></table></div>
          </section>
          <aside class="card commands-library" aria-labelledby="templates-title">
            <span class="eyebrow">REUSABLE OPERATIONS</span><h3 id="templates-title" class="section-title">Saved templates</h3><p class="page-subtitle">Start with a known configuration, then choose your target.</p>
            <div id="templates-list">${loading('Loading templates...')}</div>
            <button class="btn commands-library-action" onclick="Views.Commands.showCreateModal()">Create from scratch ${UI.icon('arrow')}</button>
          </aside>
        </div>
        <section class="card security-results commands-planning">
          <div class="section-heading"><div><span class="eyebrow">PLAN AHEAD</span><h3 class="section-title">Scheduled commands</h3><p class="page-subtitle">Recurring work for a server or group. Up to 100 saved schedules.</p></div><button class="btn" onclick="Views.Commands.showCreateModal('', '', true)">${UI.icon('history')} New schedule</button></div>
          <div class="table-wrap" tabindex="0" role="region" aria-label="Scheduled commands; scroll for all columns"><table><thead><tr><th>Name</th><th>Target</th><th>Type</th><th>Cron</th><th>Window</th><th>Last run</th><th>Actions</th></tr></thead><tbody id="scheduled-tbody"></tbody></table></div>
        </section>
        <section class="card security-results commands-planning">
          <div class="section-heading"><div><span class="eyebrow">EXECUTION BOUNDARIES</span><h3 class="section-title">Maintenance windows</h3><p class="page-subtitle">Attach a window to a schedule to restrict when it can run.</p></div><button class="btn" onclick="Views.Commands.showMaintenanceWindowModal()">New window</button></div>
          <div class="table-wrap" tabindex="0" role="region" aria-label="Maintenance windows; scroll for all columns"><table><thead><tr><th>Name</th><th>Target</th><th>Days</th><th>Hours</th><th>Timezone</th><th>Actions</th></tr></thead><tbody id="maintenance-windows-tbody"></tbody></table></div>
        </section>
      </section>`;
    workspace().addEventListener('click', event => {
      const button = event.target.closest('[data-command-action]');
      if (!button || button.disabled) return;
      const actions = {log: showLog, cancel, approve, template: showCreateFromTemplate, deleteTemplate, deleteScheduled, deleteWindow: deleteMaintenanceWindow};
      actions[button.dataset.commandAction]?.(button.dataset.id);
    });
    await reload();
  }

  function feedback(message) {
    const el = document.getElementById('commands-feedback');
    if (el) { el.hidden = !message; el.textContent = message; }
  }

  async function loadReferenceData(host = workspace() || document.getElementById('content')) {
    const sequence = ++referenceSequence;
    const anchor = host?.firstElementChild;
    referencesReady = false;
    const results = await Promise.allSettled([API.getServers(), API.listGroups(), API.listPackages(), API.listCommandTemplates(), API.listMaintenanceWindows()]);
    if (sequence !== referenceSequence || !current(host) || host.firstElementChild !== anchor) return false;
    const values = results.map(result => result.status === 'fulfilled' ? data(result.value) : []);
    [servers, groups, packages, templates, maintenanceWindows] = values;
    const names = ['servers', 'groups', 'packages', 'templates', 'maintenance windows'];
    referenceError = results.flatMap((result, index) => result.status === 'rejected' ? [names[index]] : []).join(', ');
    referencesReady = !referenceError;
    if (workspace()) {
      renderTemplates(); renderMaintenanceWindows();
      if (results[3].status === 'rejected') document.getElementById('templates-list').innerHTML = UI.empty('Templates unavailable', 'Refresh to load saved configurations.', 'terminal');
      if (results[4].status === 'rejected') document.getElementById('maintenance-windows-tbody').innerHTML = emptyRow(6, 'Windows unavailable', 'Refresh to load maintenance windows.');
      if (referenceError) feedback('Some resources could not be loaded: ' + referenceError + '. Refresh before creating work.');
      applyFilters(); renderScheduledTable();
    }
    return referencesReady;
  }

  async function reload() {
    const host = workspace(); if (!host) return;
    const sequence = ++loadSequence;
    const button = document.getElementById('commands-refresh');
    button.disabled = true; button.setAttribute('aria-busy', 'true');
    feedback('');
    await Promise.all([loadReferenceData(host), reloadCommandsOnly(), reloadScheduledOnly()]);
    if (!current(host) || sequence !== loadSequence) return;
    button.disabled = false; button.setAttribute('aria-busy', 'false');
  }

  async function reloadCommandsOnly() {
    const host = workspace(); if (!host) return;
    const sequence = ++historySequence;
    historyReady = false;
    document.getElementById('commands-summary').innerHTML = loading('Loading command history...');
    document.getElementById('commands-count').textContent = '';
    document.getElementById('commands-tbody').innerHTML = `<tr><td colspan="6">${loading('Loading commands...')}</td></tr>`;
    try {
      const response = await API.listCommands();
      if (!current(host) || sequence !== historySequence) return;
      history = data(response); historyReady = true;
      renderSummary(); applyFilters();
    } catch (err) {
      if (!current(host) || sequence !== historySequence) return;
      history = [];
      document.getElementById('commands-summary').innerHTML = '<p class="security-summary-note">Command summary unavailable</p>';
      document.getElementById('commands-tbody').innerHTML = emptyRow(6, 'History unavailable', esc(err.message), retry);
    }
  }

  let scheduleError = '';
  async function reloadScheduledOnly() {
    const host = workspace(); if (!host) return;
    const sequence = ++scheduleSequence;
    scheduleError = '';
    document.getElementById('scheduled-tbody').innerHTML = `<tr><td colspan="7">${loading('Loading schedules...')}</td></tr>`;
    try {
      const response = await API.listScheduledCommands();
      if (!current(host) || sequence !== scheduleSequence) return;
      scheduledCommands = data(response); renderScheduledTable();
    } catch (err) {
      if (!current(host) || sequence !== scheduleSequence) return;
      scheduledCommands = []; scheduleError = err.message; renderScheduledTable();
    }
  }

  function renderSummary() {
    const count = values => history.filter(cmd => values.includes(getDisplayStatus(cmd))).length;
    document.getElementById('commands-summary').innerHTML =
      UI.securityMetric('Awaiting approval', count(['awaiting_approval']), 'Scripts waiting for review', 'caution', 'shield') +
      UI.securityMetric('In progress', count(['pending', 'sent', 'running']), 'Queued, sent or running', '', 'pulse') +
      UI.securityMetric('Needs attention', count(['error', 'timeout']), 'Errors and timeouts', 'risk', 'bell') +
      UI.securityMetric('Completed', count(['success']), 'Successful results in loaded history', '', 'terminal');
  }

  function applyFilters() {
    if (!workspace() || !historyReady) return;
    const search = document.getElementById('cmd-search').value.trim().toLowerCase();
    const status = document.getElementById('cmd-filter-status').value;
    const sort = document.getElementById('cmd-sort').value;
    const rank = cmd => ({awaiting_approval: 0, error: 1, timeout: 1, running: 2, pending: 3, sent: 3})[getDisplayStatus(cmd)] ?? 4;
    const time = cmd => Date.parse(cmd.created_at) || 0;
    const rows = history.filter(cmd => (!status || getDisplayStatus(cmd) === status) && (!search || [cmd.id, getTargetName(cmd), cmd.type, cmd.output, cmd.error].some(value => String(value || '').toLowerCase().includes(search))));
    rows.sort((a, b) => (sort === 'attention' ? rank(a) - rank(b) : 0) || (sort === 'oldest' ? time(a) - time(b) : time(b) - time(a)) || String(a.id).localeCompare(String(b.id)));
    document.getElementById('commands-count').textContent = `${rows.length} of ${history.length} commands`;
    renderTable(rows);
  }

  function clearFilters() {
    if (!workspace()) return;
    document.getElementById('cmd-search').value = ''; document.getElementById('cmd-filter-status').value = ''; document.getElementById('cmd-sort').value = 'newest'; applyFilters();
  }

  function actionButton(action, id, text, style = '') {
    return `<button class="btn btn-sm ${style}" data-command-action="${action}" data-id="${esc(id)}" ${pendingActions.has(action + ':' + id) ? 'disabled aria-busy="true"' : ''}>${text}</button>`;
  }

  function getServerName(id) {
    const server = servers.find(item => item.id === id);
    return server ? server.hostname : (id || 'group command');
  }

  function getGroupName(id) {
    const group = groups.find(item => item.id === id);
    return group ? group.name : (id || 'group');
  }

  function getTargetName(cmd) {
    if (cmd.agent_id) return getServerName(cmd.agent_id);
    if (cmd.group_id) return getGroupName(cmd.group_id);
    return 'group command';
  }

  function renderTable(cmds) {
    const tbody = document.getElementById('commands-tbody');
    if (!tbody) return;
    if (!cmds.length) {
      tbody.innerHTML = history.length
        ? emptyRow(6, 'No matching commands', 'Try another target, status or search phrase.', '<button class="btn" onclick="Views.Commands.clearFilters()">Reset filters</button>')
        : emptyRow(6, 'Your execution history starts here', 'Choose a server and queue a command. Results appear when the agent reports back.', '<button class="btn btn-primary" onclick="Views.Commands.showCreateModal()">Create a command</button><a class="btn" href="#packages">Set up an agent</a>');
      return;
    }
    tbody.innerHTML = cmds.map(cmd => `<tr>
      <td><strong>${esc(label(cmd.type))}</strong><span class="security-row-meta">${UI.icon('server')} ${esc(getTargetName(cmd))}</span><span class="security-row-meta monospace">${esc(String(cmd.id).slice(0, 8))}${cmd.dry_run ? ' / Dry run' : ''}</span></td>
      <td><span class="${App.priorityClass(cmd.priority)}">${esc(cmd.priority)}</span></td>
      <td>${renderCommandStatus(getDisplayStatus(cmd))}</td><td class="commands-result-preview">${renderCommandResultSummary(cmd)}</td>
      <td><time datetime="${esc(cmd.created_at)}" title="${esc(App.formatDate(cmd.created_at))}">${App.timeAgo(cmd.created_at)}</time></td>
      <td><div class="security-row-actions">${actionButton('log', cmd.id, 'View result')}${getDisplayStatus(cmd) === 'awaiting_approval' && canApprove() ? actionButton('approve', cmd.id, 'Approve', 'btn-primary') : ''}${['pending', 'sent'].includes(cmd.status) ? actionButton('cancel', cmd.id, 'Cancel', 'btn-danger') : ''}</div></td>
    </tr>`).join('');
  }

  function renderScheduledTable() {
    const tbody = document.getElementById('scheduled-tbody');
    if (!tbody) return;
    if (scheduleError) { tbody.innerHTML = emptyRow(7, 'Schedules unavailable', esc(scheduleError), retry); return; }
    if (!scheduledCommands.length) {
      tbody.innerHTML = emptyRow(7, 'Plan your next operation', 'Create a recurring command and optionally attach a maintenance window.');
      return;
    }
    tbody.innerHTML = scheduledCommands.map(item => `
      <tr>
        <td>
          <strong>${App.escHtml(item.name)}</strong>
          <div class="text-muted">${item.enabled ? 'Enabled' : 'Disabled'}</div>
        </td>
        <td>${App.escHtml(item.agent_id ? getServerName(item.agent_id) : getGroupName(item.group_id))}</td>
        <td class="monospace">${App.escHtml(item.type)}</td>
        <td class="monospace">${App.escHtml(item.cron_expr)}</td>
        <td>${App.escHtml(item.maintenance_window_name || '-')}</td>
        <td>
          ${item.last_run ? App.formatDate(item.last_run) : '-'}
          ${item.last_skipped_at ? `<div class="text-muted">Skipped ${App.formatDate(item.last_skipped_at)}</div><div class="text-muted">${App.escHtml(item.last_skip_reason || '')}</div>` : ''}
        </td>
        <td><button class="btn btn-sm btn-danger" data-command-action="deleteScheduled" data-id="${esc(item.id)}">Delete</button></td>
      </tr>
    `).join('');
  }

  function renderMaintenanceWindows() {
    const tbody = document.getElementById('maintenance-windows-tbody');
    if (!tbody) return;
    if (!maintenanceWindows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted" style="padding:2rem">No maintenance windows defined</td></tr>';
      return;
    }
    tbody.innerHTML = maintenanceWindows.map(item => `
      <tr>
        <td>
          <strong>${App.escHtml(item.name)}</strong>
          <div class="text-muted">${item.enabled ? 'Enabled' : 'Disabled'}</div>
        </td>
        <td>${App.escHtml(item.agent_id ? getServerName(item.agent_id) : getGroupName(item.group_id))}</td>
        <td>${App.escHtml(formatMaintenanceDays(item.days_of_week))}</td>
        <td class="monospace">${App.escHtml(`${item.start_time} - ${item.end_time}`)}</td>
        <td>${App.escHtml(item.timezone || 'UTC')}</td>
        <td><button class="btn btn-sm btn-danger" data-command-action="deleteWindow" data-id="${esc(item.id)}">Delete</button></td>
      </tr>
    `).join('');
  }

  function renderTemplates() {
    const container = document.getElementById('templates-list');
    if (!container) return;
    if (!templates.length) {
      container.innerHTML = UI.empty('Repeat good configurations', 'Save a template from the command composer to reuse its settings.', 'terminal');
      return;
    }
    container.innerHTML = templates.map(item => `
      <div class="commands-template">
        <div>
          <div><strong>${App.escHtml(item.name)}</strong></div>
          <div class="text-muted mt-1">${App.escHtml(item.description || item.type)}</div>
          <div class="text-muted mt-1 monospace">${App.escHtml(item.type)} | ${App.escHtml(item.priority)} | timeout ${item.timeout_seconds || 1800}s</div>
        </div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:flex-start">
          <button class="btn btn-sm" data-command-action="template" data-id="${esc(item.id)}">Use</button>
          <button class="btn btn-sm btn-danger" data-command-action="deleteTemplate" data-id="${esc(item.id)}">Delete</button>
        </div>
      </div>
    `).join('');
  }

  function dialogHost() { return workspace() || document.getElementById('server-detail') || document.getElementById('content'); }

  function openDialog(title, content) {
    const dialog = UI.dialog(dialogHost(), title, content, 'OPERATIONS / COMMANDS');
    dialog.classList.add('commands-dialog');
    return dialog;
  }

  function formError(dialog, message) {
    const status = dialog.querySelector('[data-form-status]');
    if (status) { status.hidden = !message; status.textContent = message; }
  }

  function openForm(title, content, submit, submitLabel) {
    const host = dialogHost();
    const dialog = openDialog(title, `<form class="commands-form" novalidate>${content}<div class="security-dialog-footer"><p class="text-muted">Review the target and settings before submitting.</p><button class="btn btn-primary" type="submit" data-submit>${submitLabel}</button></div><div class="error-msg" role="alert" data-form-status hidden></div></form>`);
    dialog.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault();
      const button = dialog.querySelector('[data-submit]');
      if (button.disabled) return;
      button.disabled = true; button.setAttribute('aria-busy', 'true'); formError(dialog, '');
      try {
        const result = await submit(dialog);
        const message = typeof result === 'string' ? result : result.message;
        if (!dialog.isConnected) return;
        dialog.close(); feedback(message);
        if (workspace()) await reload();
        if (current(host)) feedback(message);
        if (result?.receipt && current(host) && !host.querySelector('.commands-dialog[open]')) showSubmissionReceipt(result.receipt);
      } catch (err) {
        if (dialog.isConnected) formError(dialog, err.message);
      } finally {
        button.disabled = false; button.setAttribute('aria-busy', 'false');
      }
    });
    return dialog;
  }

  async function showLog(id) {
    const sequence = ++detailSequence;
    const dialog = openDialog('Command result', loading('Loading execution details...'));
    const body = dialog.querySelector('.security-dialog-body');
    try {
      const response = await API.getCommandLog(id);
      if (!dialog.isConnected || sequence !== detailSequence) return;
      const cmd = response?.data;
      if (!cmd) throw new Error('No command details returned.');
      body.innerHTML = `<div class="commands-result-heading">${UI.icon('terminal')}<div><span class="eyebrow">${esc(getTargetName(cmd))}</span><h4>${esc(label(cmd.type))}</h4></div>${renderCommandStatus(getDisplayStatus(cmd))}</div>${renderCommandDetail(cmd)}<div class="security-dialog-footer"><p class="text-muted">Results update when the agent reports back.</p><button class="btn" data-refresh-result>Refresh result</button></div><div role="status" class="security-feedback" data-result-feedback hidden></div>`;
      body.querySelector('[data-refresh-result]').addEventListener('click', () => showLog(id));
      body.querySelector('[data-approve]')?.addEventListener('click', () => approve(id, true));
    } catch (err) {
      if (!dialog.isConnected || sequence !== detailSequence) return;
      body.innerHTML = `${UI.empty('Result unavailable', esc(err.message), 'terminal')}<button class="btn" data-retry-result>Retry result</button>`;
      body.querySelector('[data-retry-result]').addEventListener('click', () => showLog(id));
    }
  }

  function renderCommandDetail(cmd) {
    const payload = cmd.payload || {};
    const displayStatus = getDisplayStatus(cmd);
    return `
      <div class="grid-2">
        <div class="card">
          <div class="section-title">Summary</div>
          <div class="report-kv">
            ${renderKV('Command ID', cmd.id)}
            ${renderKV('Target', getTargetName(cmd))}
            ${renderKV('Type', cmd.type)}
            ${renderKV('Priority', cmd.priority)}
            ${renderKV('Status', displayStatus)}
            ${renderKV('Dry Run', cmd.dry_run ? 'yes' : 'no')}
            ${renderKV('Exit Code', cmd.exit_code != null ? String(cmd.exit_code) : '-')}
            ${renderKV('Duration', cmd.duration_ms != null ? `${cmd.duration_ms} ms` : '-')}
            ${renderKV('Requires Approval', cmd.requires_approval ? 'yes' : 'no')}
            ${renderKV('Approved At', cmd.approved_at ? App.formatDate(cmd.approved_at) : '-')}
          </div>
        </div>
        <div class="card">
          <div class="section-title">Timeline</div>
          <div class="report-kv">
            ${renderKV('Created', cmd.created_at ? App.formatDate(cmd.created_at) : '-')}
            ${renderKV('Sent', cmd.sent_at ? App.formatDate(cmd.sent_at) : '-')}
            ${renderKV('Completed', cmd.completed_at ? App.formatDate(cmd.completed_at) : '-')}
          </div>
          ${displayStatus === 'awaiting_approval' && canApprove() ? `
            <div class="mt-2">
              <div class="form-group">
                <label for="approval-note">Approval note</label>
                <textarea id="approval-note" rows="4" placeholder="Optional note"></textarea>
              </div>
              <button class="btn btn-primary" data-approve>Approve Script</button>
            </div>
          ` : ''}
        </div>
      </div>
      <div class="card mt-2">
        <div class="section-title">Payload</div>
        ${renderPayload(payload)}
      </div>
      <div class="grid-2 mt-2">
        <div class="card">
          <div class="section-title">Output</div>
          <pre class="output" tabindex="0" aria-label="Command output">${App.escHtml(cmd.output || (['pending', 'sent', 'running', 'awaiting_approval'].includes(displayStatus) ? 'Waiting for execution output.' : 'No output returned.'))}</pre>
        </div>
        <div class="card">
          <div class="section-title">Error</div>
          <pre class="output ${cmd.error ? 'commands-error-output' : ''}" tabindex="0" aria-label="Command error">${App.escHtml(cmd.error || 'No error')}</pre>
        </div>
      </div>
    `;
  }

  function renderPayload(payload) {
    const entries = Object.entries(payload || {}).filter(([, value]) => value !== '' && value != null);
    if (!entries.length) return '<div class="text-muted">No payload fields for this command.</div>';
    return `
      <div class="report-kv">
        ${entries.map(([key, value]) => renderKV(toTitle(key), Array.isArray(value) ? value.join(', ') : String(value))).join('')}
      </div>
    `;
  }

  async function runAction(action, id, operation, message, detail = false) {
    const host = dialogHost();
    const dialog = host?.querySelector('.commands-dialog');
    const key = action + ':' + id;
    if (pendingActions.has(key)) return;
    pendingActions.add(key); applyFilters();
    const buttons = [...(host?.querySelectorAll('[data-command-action], [data-approve]') || [])].filter(button => button.dataset.id === id || (detail && button.hasAttribute('data-approve')));
    buttons.forEach(button => { button.disabled = true; });
    try {
      await operation();
      if (!current(host)) return;
      if (detail && dialog?.isConnected) { dialog.close(); await showLog(id); }
      await reload();
      if (current(host)) feedback(message);
    } catch (err) {
      if (!current(host)) return;
      const status = detail && dialog?.isConnected ? dialog.querySelector('[data-result-feedback]') : null;
      if (status) { status.hidden = false; status.textContent = err.message; }
      else feedback(err.message);
    } finally {
      pendingActions.delete(key);
      if (current(host)) { buttons.forEach(button => { button.disabled = false; }); applyFilters(); }
    }
  }

  async function cancel(id) {
    if (pendingActions.has('cancel:' + id) || !confirm('Cancel this command?')) return;
    await runAction('cancel', id, () => API.cancelCommand(id), 'Command cancelled.');
  }

  async function approve(id, detail = false) {
    const note = document.getElementById('approval-note')?.value.trim() || '';
    await runAction('approve', id, () => API.approveCommand(id, note), 'Command approved. Waiting for the agent.', detail);
  }

  async function deleteScheduled(id) {
    if (!confirm('Delete this scheduled command?')) return;
    await runAction('deleteScheduled', id, () => API.deleteScheduledCommand(id), 'Schedule deleted.');
  }

  async function showMaintenanceWindowModal() {
    const host = dialogHost();
    if (!referencesReady && !await loadReferenceData(host)) { if (current(host)) feedback('Cannot create a window until resources load. Refresh and try again.'); return; }
    if (!current(host)) return;
    const serverOptions = servers.map(server =>
      `<option value="${esc(server.id)}">${App.escHtml(server.hostname)}</option>`
    ).join('');
    const groupOptions = groups.map(group =>
      `<option value="${esc(group.id)}">${App.escHtml(group.name)}</option>`
    ).join('');
    const dayOptions = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      .map((label, index) => `<label><input type="checkbox" class="mw-day" value="${index}" ${index >= 1 && index <= 5 ? 'checked' : ''}> ${label}</label>`)
      .join(' ');

    openForm('Create maintenance window', `
      <div class="form-row">
        <div class="form-group">
          <label for="mw-name">Name</label>
          <input type="text" id="mw-name" placeholder="Weekend patch window">
        </div>
        <div class="form-group">
          <label for="mw-timezone">Timezone</label>
          <input type="text" id="mw-timezone" value="Europe/Warsaw" placeholder="Europe/Warsaw">
        </div>
      </div>
      <div class="form-group">
        <label for="mw-target-type">Target</label>
        <select id="mw-target-type" onchange="Views.Commands.onMaintenanceTargetChange()">
          <option value="group">Group</option>
          <option value="server">Server</option>
        </select>
      </div>
      <div class="form-group" id="mw-group-wrap">
        <label for="mw-group-id">Group</label>
        <select id="mw-group-id"><option value="">Choose a group</option>${groupOptions}</select>
      </div>
      <div class="form-group hidden" id="mw-server-wrap">
        <label for="mw-agent-id">Server</label>
        <select id="mw-agent-id"><option value="">Choose a server</option>${serverOptions}</select>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="mw-start">Start</label>
          <input type="time" id="mw-start" value="22:00">
        </div>
        <div class="form-group">
          <label for="mw-end">End</label>
          <input type="time" id="mw-end" value="04:00">
        </div>
      </div>
      <div class="form-group">
        <label>Days</label>
        <div class="filters">${dayOptions}</div>
      </div>
    `, submitMaintenanceWindow, 'Save window');
  }

  function onMaintenanceTargetChange() {
    const type = document.getElementById('mw-target-type').value;
    document.getElementById('mw-group-wrap').classList.toggle('hidden', type !== 'group');
    document.getElementById('mw-server-wrap').classList.toggle('hidden', type !== 'server');
  }

  async function submitMaintenanceWindow() {
    const name = document.getElementById('mw-name').value.trim();
    const timezone = document.getElementById('mw-timezone').value.trim() || 'UTC';
    const targetType = document.getElementById('mw-target-type').value;
    const startTime = document.getElementById('mw-start').value;
    const endTime = document.getElementById('mw-end').value;
    const days = Array.from(document.querySelectorAll('.mw-day:checked')).map(item => Number(item.value));
    if (!name || !startTime || !endTime || !days.length) throw new Error('Name, start, end and at least one day are required.');
    const payload = {name, timezone, days_of_week: days, start_time: startTime, end_time: endTime};
    if (targetType === 'server') payload.agent_id = document.getElementById('mw-agent-id').value;
    else payload.group_id = document.getElementById('mw-group-id').value;
    if (!payload.agent_id && !payload.group_id) throw new Error('Select a target for this window.');
    await API.createMaintenanceWindow(payload);
    return 'Maintenance window saved.';
  }

  async function deleteMaintenanceWindow(id) {
    if (!confirm('Delete this maintenance window?')) return;
    await runAction('deleteWindow', id, () => API.deleteMaintenanceWindow(id), 'Maintenance window deleted.');
  }

  async function showCreateFor(agentId) {
    await showCreateModal(agentId, '');
  }

  async function showCreateFromTemplate(templateId) {
    await showCreateModal('', templateId);
  }

  async function showCreateModal(preselectedAgentId = '', templateId = '', scheduled = false) {
    const host = dialogHost(), sequence = ++composerSequence;
    const anchor = host?.firstElementChild;
    // Refresh references when invoked from inventory; its cached targets may be stale.
    if ((!workspace() || !referencesReady) && !await loadReferenceData(host)) {
      if (current(host) && host.firstElementChild === anchor && sequence === composerSequence) openDialog('Resources unavailable', UI.empty('Cannot load command resources', 'Close this dialog and try again. No command has been created.', 'terminal'));
      return;
    }
    if (!current(host) || host.firstElementChild !== anchor || sequence !== composerSequence) return;
    const serverOptions = servers.map(server =>
      `<option value="${esc(server.id)}" ${server.id === preselectedAgentId ? 'selected' : ''}>${App.escHtml(server.hostname)}</option>`
    ).join('');
    const groupOptions = groups.map(group =>
      `<option value="${esc(group.id)}">${App.escHtml(group.name)}</option>`
    ).join('');

    const content = `
      <div class="commands-compose-intro">${UI.icon('terminal')}<div><strong>Prepare an operation</strong><p>Choose a configuration, select its destination, then review execution settings.</p></div></div>
      <fieldset class="commands-step"><legend>01 / Configuration</legend><div class="card mb-2">
        <div class="form-row" style="margin-bottom:0">
          <div class="form-group">
            <label for="cmd-template-id">Template</label>
            <select id="cmd-template-id">
              <option value="">No template</option>
              ${templates.map(item => `<option value="${esc(item.id)}" ${item.id === templateId ? 'selected' : ''}>${App.escHtml(item.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="align-self:flex-end;flex:0 0 auto">
            <button type="button" class="btn btn-sm" onclick="Views.Commands.applySelectedTemplate()">Load Template</button>
          </div>
          <div class="form-group" style="align-self:flex-end;flex:0 0 auto">
            <button type="button" class="btn btn-sm btn-primary" onclick="Views.Commands.toggleTemplateSave()">Save as template</button>
          </div>
        </div>
      </div>
      <div id="cmd-template-save" class="commands-template-save" hidden><label for="cmd-template-name">Template name</label><input id="cmd-template-name" placeholder="Name this configuration"><label for="cmd-template-description">Description (optional)</label><input id="cmd-template-description"><button type="button" class="btn" id="cmd-template-save-button" onclick="Views.Commands.saveCurrentAsTemplate()">Save configuration</button><p id="cmd-template-feedback" role="status"></p></div></fieldset>
      <fieldset class="commands-step"><legend>02 / Destination &amp; timing</legend><div class="form-row mb-1">
        <div class="form-group">
          <label for="cmd-execution-mode">Execution Mode</label>
          <select id="cmd-execution-mode" onchange="Views.Commands.onExecutionModeChange()">
            <option value="immediate">Queue now</option>
            <option value="scheduled">Schedule with cron</option>
          </select>
        </div>
        <div class="form-group hidden" id="schedule-name-wrap">
          <label for="schedule-name">Schedule Name</label>
          <input type="text" id="schedule-name" placeholder="Nightly package refresh">
        </div>
        <div class="form-group hidden" id="schedule-cron-wrap">
          <label for="schedule-cron">Cron Expression</label>
          <input type="text" id="schedule-cron" placeholder="0 */6 * * *">
        </div>
        <div class="form-group hidden" id="schedule-window-wrap">
          <label for="schedule-maintenance-window-id">Maintenance Window</label>
          <select id="schedule-maintenance-window-id"></select>
        </div>
      </div>
      <div class="form-group mb-1">
        <label for="cmd-target-type">Target</label>
        <select id="cmd-target-type" onchange="Views.Commands.onTargetTypeChange()">
          <option value="server">Server</option>
          <option value="group">Group</option>
        </select>
      </div>
      <div class="form-group mb-1" id="cmd-server-sel">
        <label for="cmd-agent-id">Server</label>
        <select id="cmd-agent-id" onchange="Views.Commands.onAgentSelectionChange()"><option value="">Choose a server</option>${serverOptions}</select>
      </div>
      <div class="form-group mb-1 hidden" id="cmd-group-sel">
        <label for="cmd-group-id">Group</label>
        <select id="cmd-group-id" onchange="Views.Commands.refreshTarget()"><option value="">Choose a group</option>${groupOptions}</select>
      </div>
      <div id="cmd-agent-context" class="commands-target-context" role="status"></div></fieldset>
      <fieldset class="commands-step"><legend>03 / Execution settings</legend><div class="form-group mb-1">
        <label for="cmd-type">Command Type</label>
        <select id="cmd-type" onchange="Views.Commands.onCmdTypeChange()">
          <option value="system_update">System Update</option>
          <option value="install_package">Install Package</option>
          <option value="install_agent">Upgrade Agent</option>
          <option value="run_script">Run Script</option>
          <option value="service_control">Service Control</option>
          <option value="force_report">Force Report</option>
        </select>
      </div>
      <div class="form-row mb-1">
        <div class="form-group">
          <label for="cmd-priority">Priority</label>
          <select id="cmd-priority">
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
            <option value="low">Low</option>
          </select>
        </div>
        <div class="form-group">
          <label for="cmd-timeout">Timeout (sec)</label>
          <input type="number" id="cmd-timeout" value="1800" min="30" max="86400">
        </div>
        <div class="form-group" style="flex:0;align-self:flex-end;padding-bottom:.1rem">
          <label><input type="checkbox" id="cmd-dry-run"> Dry-run</label>
        </div>
      </div>
      <div id="cmd-extra"></div></fieldset>
      <section class="commands-review" aria-labelledby="cmd-review-title"><span class="eyebrow">04 / BEFORE YOU QUEUE</span><h4 id="cmd-review-title">Operation review</h4><div id="cmd-review" aria-live="polite"></div></section>
    `;

    const dialog = openForm(scheduled ? 'Schedule a command' : 'Create command', content, submitCommand, scheduled ? 'Create schedule' : 'Queue command');
    dialog.querySelector('form').addEventListener('input', renderOperationReview);
    dialog.querySelector('form').addEventListener('change', renderOperationReview);
    if (scheduled) setValue('cmd-execution-mode', 'scheduled');
    if (preselectedAgentId) setValue('cmd-agent-id', preselectedAgentId);
    onExecutionModeChange(); onTargetTypeChange(); onCmdTypeChange();
    await onAgentSelectionChange();
    if (dialog.isConnected && sequence === composerSequence && templateId) applyTemplateToModal(templateId);
    if (dialog.isConnected) renderOperationReview();
  }

  function renderOperationReview() {
    const review = document.getElementById('cmd-review');
    if (!review) return;
    const value = id => document.getElementById(id)?.value || '';
    const group = value('cmd-target-type') === 'group';
    const id = value(group ? 'cmd-group-id' : 'cmd-agent-id');
    const target = id ? (group ? getGroupName(id) : getServerName(id)) : 'Choose a target';
    const type = value('cmd-type');
    const dryRun = !!document.getElementById('cmd-dry-run')?.checked;
    const scheduled = value('cmd-execution-mode') === 'scheduled';
    const effects = {
      system_update: 'Updates system packages. Services may restart during installation.',
      install_package: 'Installs software on the selected target. Installation may change services and dependencies.',
      install_agent: 'Upgrades the management agent. Reporting may pause during restart.',
      run_script: 'Executes the supplied script with the agent process privileges.',
      service_control: 'Changes the selected service state. Stopping or restarting it may interrupt availability.',
      force_report: 'Requests a fresh inventory report from the agent.'
    };
    const blueprint = collectCommandBlueprint();
    review.innerHTML = `<div class="commands-review-target">${UI.icon('server')}<strong>${esc(target)}</strong><span>${group ? 'Group operation' : 'Single server'}</span></div>
      <p>${esc(effects[type] || 'Choose an operation to review its effects.')}</p>
      ${group ? '<p>Targets are resolved by the server when work is queued. Review the returned count; group membership may change.</p>' : ''}
      <div class="report-kv">${renderKV('Execution', dryRun ? 'Dry run — simulate the operation' : 'Live execution')}${renderKV('Timeout', value('cmd-timeout') + ' seconds')}${renderKV('Priority', value('cmd-priority'))}${renderKV('Timing', scheduled ? (value('schedule-cron') || 'Enter a cron expression') : 'Queue now')}</div>
      <p class="commands-review-approval">${type === 'run_script' && !dryRun ? (scheduled ? 'Each scheduled script requires approval before an agent can receive it.' : 'This script will wait for approval before an agent can receive it.') : 'No separate approval is required. Queued work can be collected by the agent.'}</p>
      ${blueprint.error ? `<p class="text-muted">${esc(blueprint.error)}</p>` : `<details><summary>Review operation parameters</summary>${renderPayload(blueprint.payload)}</details>`}`;
  }

  function onExecutionModeChange() {
    const mode = document.getElementById('cmd-execution-mode').value;
    document.getElementById('schedule-name-wrap').classList.toggle('hidden', mode !== 'scheduled');
    document.getElementById('schedule-cron-wrap').classList.toggle('hidden', mode !== 'scheduled');
    document.getElementById('schedule-window-wrap').classList.toggle('hidden', mode !== 'scheduled');
    refreshMaintenanceWindowOptions();
    const button = document.querySelector('.commands-dialog [data-submit]');
    if (button) button.textContent = mode === 'scheduled' ? 'Create schedule' : 'Queue command';
  }

  function onTargetTypeChange() {
    const type = document.getElementById('cmd-target-type').value;
    document.getElementById('cmd-server-sel').classList.toggle('hidden', type !== 'server');
    document.getElementById('cmd-group-sel').classList.toggle('hidden', type !== 'group');
    updateAgentContext();
    refreshPackageSelectors();
    refreshServiceOptions();
    refreshMaintenanceWindowOptions();
  }

  async function onAgentSelectionChange() {
    updateAgentContext();
    refreshPackageSelectors();
    await refreshServiceOptions();
    refreshMaintenanceWindowOptions();
  }

  function onCmdTypeChange() {
    const type = document.getElementById('cmd-type') ? document.getElementById('cmd-type').value : '';
    const extra = document.getElementById('cmd-extra');
    if (!extra) return;

    const extraFields = {
      system_update: `
        <div class="form-group mb-1">
          <label for="system-update-mode">Update Mode</label>
          <select id="system-update-mode" onchange="Views.Commands.onCommandOptionsChange()">
            <option value="system">Use OS package manager</option>
            <option value="uploaded">Install uploaded update file</option>
          </select>
        </div>
        <div id="system-package-wrap" class="form-group hidden">
          <label for="system-package-file">Uploaded Package</label>
          <select id="system-package-file"></select>
          <div class="text-muted mt-1">If you choose an uploaded file, it will be queued as an install command using the package file from the server.</div>
        </div>`,
      install_package: `
        <div class="form-group mb-1">
          <label for="package-source">Package Source</label>
          <select id="package-source" onchange="Views.Commands.onCommandOptionsChange()">
            <option value="uploaded">Uploaded package file</option>
            <option value="manual">Package manager name</option>
          </select>
        </div>
        <div id="package-uploaded-wrap" class="form-group">
          <label for="cmd-package-file">Uploaded Package</label>
          <select id="cmd-package-file"></select>
        </div>
        <div id="package-manual-wrap" class="hidden">
          <div class="form-row">
            <div class="form-group"><label for="pkg-name">Package Name</label><input type="text" id="pkg-name" placeholder="nginx"></div>
            <div class="form-group"><label for="pkg-version">Version (optional)</label><input type="text" id="pkg-version"></div>
          </div>
        </div>`,
      install_agent: `
        <div class="text-muted mb-1">Queues a self-update on the target agent. Latest from server uses the bundled binary for the agent OS/architecture.</div>
        <div class="form-group mb-1">
          <label for="agent-source">Agent Source</label>
          <select id="agent-source" onchange="Views.Commands.onCommandOptionsChange()">
            <option value="latest">Latest compatible binary from server bundle</option>
            <option value="uploaded">Uploaded package file</option>
          </select>
        </div>
        <div id="agent-uploaded-wrap" class="form-group hidden">
          <label for="cmd-agent-package-file">Uploaded Agent Package</label>
          <select id="cmd-agent-package-file"></select>
        </div>`,
      run_script: `
        <div class="text-muted mb-1">Scripts require manual approval before delivery. Dry runs do not require approval.</div>
        <div class="form-group mb-1">
          <label for="script-type">Script Type</label>
          <select id="script-type">
            <option value="bash">Bash</option>
            <option value="powershell">PowerShell</option>
          </select>
        </div>
        <div class="form-group">
          <label for="script-content">Script Content</label>
          <textarea id="script-content" rows="12" placeholder="#!/bin/bash&#10;echo hello"></textarea>
        </div>`,
      service_control: `
        <div class="form-group mb-1">
          <label for="svc-select">Known Service</label>
          <select id="svc-select" onchange="Views.Commands.onCommandOptionsChange()"></select>
        </div>
        <div id="svc-status" class="text-muted mb-1"></div>
        <div class="form-row">
          <div class="form-group">
            <label for="svc-name">Service Name</label>
            <input type="text" id="svc-name" placeholder="nginx">
          </div>
          <div class="form-group">
            <label for="svc-action">Action</label>
            <select id="svc-action">
              <option value="start">Start</option>
              <option value="stop">Stop</option>
              <option value="restart">Restart</option>
            </select>
          </div>
        </div>`
    };

    extra.innerHTML = extraFields[type] || '';
    onCommandOptionsChange();
    if (type === 'service_control') refreshServiceOptions();
  }

  function onCommandOptionsChange() {
    const packageSource = document.getElementById('package-source');
    const packageUploaded = document.getElementById('package-uploaded-wrap');
    const packageManual = document.getElementById('package-manual-wrap');
    if (packageSource && packageUploaded && packageManual) {
      const manual = packageSource.value === 'manual';
      packageUploaded.classList.toggle('hidden', manual);
      packageManual.classList.toggle('hidden', !manual);
    }

    const updateMode = document.getElementById('system-update-mode');
    const systemPackageWrap = document.getElementById('system-package-wrap');
    if (updateMode && systemPackageWrap) {
      systemPackageWrap.classList.toggle('hidden', updateMode.value !== 'uploaded');
    }

    const agentSource = document.getElementById('agent-source');
    const agentUploaded = document.getElementById('agent-uploaded-wrap');
    if (agentSource && agentUploaded) {
      agentUploaded.classList.toggle('hidden', agentSource.value !== 'uploaded');
    }

    refreshPackageSelectors();
    updateServiceSelection();
  }

  let serviceSequence = 0;
  async function refreshServiceOptions() {
    const sequence = ++serviceSequence;
    const select = document.getElementById('svc-select');
    if (!select) return;

    const agent = getSelectedAgent();
    if (!agent) {
      select.innerHTML = '<option value="">Select a server to load services</option>';
      updateServiceSelection();
      return;
    }

    select.innerHTML = '<option value="">Loading services...</option>';
    let services;
    try { services = await getAgentServices(agent.id); } catch {
      if (sequence === serviceSequence && document.getElementById('svc-select') === select) {
        select.innerHTML = '<option value="">Service report unavailable</option>';
        document.getElementById('svc-status').textContent = 'Could not load the latest report. Enter a service name or select the target again to retry.';
      }
      return;
    }
    if (sequence !== serviceSequence || document.getElementById('svc-select') !== select || getSelectedAgent()?.id !== agent.id) return;
    if (!services.length) {
      select.innerHTML = '<option value="">No services in latest report</option>';
      updateServiceSelection();
      return;
    }

    select.innerHTML = `
      <option value="">Select service from latest report</option>
      ${services.map(service => `
        <option value="${esc(service.name)}">
          ${App.escHtml(service.display_name || service.name)} (${App.escHtml(service.status || 'unknown')}${service.start_mode ? `, ${App.escHtml(service.start_mode)}` : ''})
        </option>
      `).join('')}
    `;
    updateServiceSelection();
  }

  function refreshPackageSelectors() {
    const compatible = getCompatiblePackages();
    const html = buildPackageOptions(compatible);
    const agentHtml = buildPackageOptions(compatible.filter(pkg => (pkg.name || '').toLowerCase() === 'sms-agent'));
    ['cmd-package-file', 'system-package-file'].forEach(id => {
      const select = document.getElementById(id);
      if (select) { const previous = select.value; select.innerHTML = html; if (compatible.some(pkg => pkg.id === previous)) select.value = previous; }
    });
    const agentSelect = document.getElementById('cmd-agent-package-file');
    if (agentSelect) { const previous = agentSelect.value; agentSelect.innerHTML = agentHtml; if (compatible.some(pkg => pkg.id === previous && (pkg.name || '').toLowerCase() === 'sms-agent')) agentSelect.value = previous; }
  }

  function buildPackageOptions(items) {
    if (!items.length) {
      return '<option value="">No uploaded packages match this target</option>';
    }
    return `
      <option value="">Select uploaded package</option>
      ${items.map(pkg => `
        <option value="${esc(pkg.id)}">
          ${App.escHtml(formatPackageLabel(pkg))}
        </option>
      `).join('')}
    `;
  }

  function getCompatiblePackages() {
    const agent = getSelectedAgent();
    if (!agent) return [...packages].sort(sortPackages);

    const os = normalizeOSTarget(agent.os);
    const arch = (agent.architecture || '').toLowerCase();
    return packages
      .filter(pkg => {
        const osMatch = !pkg.os_target || !os || pkg.os_target.toLowerCase() === os;
        const archMatch = !pkg.arch_target || !arch || pkg.arch_target.toLowerCase() === arch;
        return osMatch && archMatch;
      })
      .sort(sortPackages);
  }

  function getSelectedAgent() {
    if (document.getElementById('cmd-target-type') && document.getElementById('cmd-target-type').value !== 'server') {
      return null;
    }
    const id = document.getElementById('cmd-agent-id') ? document.getElementById('cmd-agent-id').value : '';
    return servers.find(server => server.id === id) || null;
  }

  function updateAgentContext() {
    const el = document.getElementById('cmd-agent-context');
    if (!el) return;
    const agent = getSelectedAgent();
    if (!agent) {
      const type = document.getElementById('cmd-target-type')?.value;
      const id = document.getElementById('cmd-group-id')?.value;
      el.textContent = type === 'group' && id ? `Group: ${getGroupName(id)}. A command will be created for each agent in this group. Package compatibility must be checked for all members.` : 'Choose a target. No command is sent until you submit.';
      return;
    }
    el.textContent = `Target OS: ${agent.os || '-'} ${agent.os_version || ''} | Arch: ${agent.architecture || '-'} | Last seen: ${agent.last_seen ? App.timeAgo(agent.last_seen) : 'never'}`;
  }

  function refreshMaintenanceWindowOptions() {
    const select = document.getElementById('schedule-maintenance-window-id');
    if (!select) return;
    const windows = getApplicableMaintenanceWindows();
    const previous = select.value;
    select.innerHTML = `
      <option value="">No maintenance window</option>
      ${windows.map(item => `
        <option value="${esc(item.id)}">
          ${App.escHtml(`${item.name} (${formatMaintenanceDays(item.days_of_week)}, ${item.start_time}-${item.end_time} ${item.timezone || 'UTC'})`)}
        </option>
      `).join('')}
    `;
    if (windows.some(item => item.id === previous)) select.value = previous;
  }

  function getApplicableMaintenanceWindows() {
    const targetType = document.getElementById('cmd-target-type') ? document.getElementById('cmd-target-type').value : 'server';
    if (targetType === 'group') {
      const groupId = document.getElementById('cmd-group-id') ? document.getElementById('cmd-group-id').value : '';
      return maintenanceWindows.filter(item => item.group_id === groupId);
    }
    const agentId = document.getElementById('cmd-agent-id') ? document.getElementById('cmd-agent-id').value : '';
    return maintenanceWindows.filter(item => item.agent_id === agentId);
  }

  function updateServiceSelection() {
    const select = document.getElementById('svc-select');
    const input = document.getElementById('svc-name');
    const statusEl = document.getElementById('svc-status');
    if (!statusEl || !input) return;
    if (!select || !select.value) {
      statusEl.textContent = 'Type a custom service name or choose one from the latest report.';
      return;
    }

    const agent = getSelectedAgent();
    const services = agent ? (servicesByAgent[agent.id] || []) : [];
    const service = services.find(item => item.name === select.value);
    input.value = select.value;
    if (!service) {
      statusEl.textContent = 'Service status unavailable.';
      return;
    }
    statusEl.innerHTML = `Current status: ${renderServiceStatus(service.status)} | Start mode: ${App.escHtml(service.start_mode || '-')}`;
  }

  async function getAgentServices(agentID) {
    if (servicesByAgent[agentID]) return servicesByAgent[agentID];
    try {
      const resp = await API.getServerHistory(agentID, 1);
      const latest = resp && resp.data && resp.data.length ? resp.data[0] : null;
      const services = latest && Array.isArray(latest.services) ? latest.services : [];
      servicesByAgent[agentID] = services
        .slice()
        .sort((a, b) => {
          const aRank = serviceOrder(a.status);
          const bRank = serviceOrder(b.status);
          if (aRank !== bRank) return aRank - bRank;
          return (a.display_name || a.name || '').localeCompare(b.display_name || b.name || '');
        });
    } catch (err) { throw err; }
    return servicesByAgent[agentID];
  }

  function collectCommandBlueprint() {
    const requestedType = document.getElementById('cmd-type').value;
    const priority = document.getElementById('cmd-priority').value;
    const timeout = Number(document.getElementById('cmd-timeout').value);
    if (!Number.isInteger(timeout) || timeout < 30 || timeout > 86400) return {error: 'Timeout must be a whole number, at least 30 seconds and at most 86400 seconds.'};
    const dryRun = document.getElementById('cmd-dry-run').checked;

    let type = requestedType;
    const payload = {};

    if (requestedType === 'system_update') {
      const mode = document.getElementById('system-update-mode') ? document.getElementById('system-update-mode').value : 'system';
      if (mode === 'uploaded') {
        const pkg = getSelectedUploadedPackage('system-package-file');
        if (!pkg) return { error: 'Select an uploaded update package.' };
        type = 'install_package';
        payload.package_name = pkg.name;
        payload.package_version = pkg.version;
        payload.package_url = buildPublicPackageURL(pkg);
      }
    } else if (requestedType === 'install_package') {
      const source = document.getElementById('package-source') ? document.getElementById('package-source').value : 'uploaded';
      if (source === 'uploaded') {
        const pkg = getSelectedUploadedPackage('cmd-package-file');
        if (!pkg) return { error: 'Select an uploaded package.' };
        payload.package_name = pkg.name;
        payload.package_version = pkg.version;
        payload.package_url = buildPublicPackageURL(pkg);
      } else {
        payload.package_name = document.getElementById('pkg-name') ? document.getElementById('pkg-name').value.trim() : '';
        payload.package_version = document.getElementById('pkg-version') ? document.getElementById('pkg-version').value.trim() : '';
        if (!payload.package_name) return { error: 'Package name is required.' };
      }
    } else if (requestedType === 'install_agent') {
      const source = document.getElementById('agent-source') ? document.getElementById('agent-source').value : 'latest';
      if (source === 'uploaded') {
        const pkg = getSelectedUploadedPackage('cmd-agent-package-file');
        if (!pkg) return { error: 'Select an uploaded agent package.' };
        payload.package_name = pkg.name;
        payload.package_version = pkg.version;
        payload.package_url = buildPublicPackageURL(pkg);
      }
    } else if (requestedType === 'run_script') {
      payload.script_type = document.getElementById('script-type') ? document.getElementById('script-type').value : 'bash';
      payload.script_content = document.getElementById('script-content') ? document.getElementById('script-content').value : '';
      if (!payload.script_content.trim()) return { error: 'Script content is required.' };
    } else if (requestedType === 'service_control') {
      payload.service_name = document.getElementById('svc-name') ? document.getElementById('svc-name').value.trim() : '';
      payload.service_action = document.getElementById('svc-action') ? document.getElementById('svc-action').value : 'restart';
      if (!payload.service_name) return { error: 'Service name is required.' };
    }

    return { requestedType, type, priority, timeout, dryRun, payload };
  }

  function toggleTemplateSave() {
    const panel = document.getElementById('cmd-template-save');
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) document.getElementById('cmd-template-name').focus();
  }

  async function saveCurrentAsTemplate() {
    const dialog = dialogHost()?.querySelector('.commands-dialog');
    const button = document.getElementById('cmd-template-save-button');
    const status = document.getElementById('cmd-template-feedback');
    if (!dialog || !button || button.disabled) return;
    const blueprint = collectCommandBlueprint();
    const name = document.getElementById('cmd-template-name').value.trim();
    if (blueprint.error || !name) { status.textContent = blueprint.error || 'Enter a template name.'; return; }
    const description = document.getElementById('cmd-template-description').value.trim();
    button.disabled = true; status.textContent = 'Saving template...';
    try {
      await API.createCommandTemplate({name, description, type: blueprint.type, priority: blueprint.priority, timeout_seconds: blueprint.timeout, dry_run: blueprint.dryRun, payload: blueprint.payload});
      if (!dialog.isConnected) return;
      status.textContent = 'Template saved. Your command has not been queued.';
      await loadReferenceData(dialogHost());
    } catch (err) {
      if (dialog.isConnected) status.textContent = err.message;
    } finally { button.disabled = false; }
  }

  function applySelectedTemplate() {
    const select = document.getElementById('cmd-template-id');
    if (!select || !select.value) return;
    applyTemplateToModal(select.value);
  }

  function applyTemplateToModal(templateId) {
    const template = templates.find(item => item.id === templateId);
    if (!template) return;

    setValue('cmd-priority', template.priority || 'normal');
    setValue('cmd-timeout', template.timeout_seconds || 1800);
    const dryRun = document.getElementById('cmd-dry-run');
    if (dryRun) dryRun.checked = !!template.dry_run;

    const type = template.type || 'force_report';
    setValue('cmd-type', type);
    onCmdTypeChange();

    const payload = template.payload || {};
    if (type === 'run_script') {
      setValue('script-type', payload.script_type || 'bash');
      setValue('script-content', payload.script_content || '');
    } else if (type === 'service_control') {
      setValue('svc-name', payload.service_name || '');
      setValue('svc-action', payload.service_action || 'restart');
      const svcSelect = document.getElementById('svc-select');
      if (svcSelect && payload.service_name) svcSelect.value = payload.service_name;
      updateServiceSelection();
    } else if (type === 'install_package') {
      const matchingPackage = packages.find(pkg =>
        pkg.name === payload.package_name &&
        (!payload.package_version || pkg.version === payload.package_version));
      if (matchingPackage) {
        setValue('package-source', 'uploaded');
        onCommandOptionsChange();
        setValue('cmd-package-file', matchingPackage.id);
      } else {
        setValue('package-source', 'manual');
        onCommandOptionsChange();
        setValue('pkg-name', payload.package_name || '');
        setValue('pkg-version', payload.package_version || '');
      }
    } else if (type === 'install_agent') {
      const matchingPackage = packages.find(pkg =>
        pkg.name === payload.package_name &&
        (!payload.package_version || pkg.version === payload.package_version));
      if (matchingPackage && payload.package_url) {
        setValue('agent-source', 'uploaded');
        onCommandOptionsChange();
        setValue('cmd-agent-package-file', matchingPackage.id);
      } else {
        setValue('agent-source', 'latest');
        onCommandOptionsChange();
      }
    } else if (type === 'system_update') {
      setValue('cmd-type', 'system_update');
      onCmdTypeChange();
    }
    renderOperationReview();
  }

  function showSubmissionReceipt(receipt) {
    const count = receipt.commands_created;
    const dialog = openDialog('Submission receipt', `<section class="command-receipt">
      <div class="commands-compose-intro">${UI.icon('shield')}<div><span class="eyebrow">${receipt.replayed ? 'RECOVERED RECEIPT' : 'SAVED TO QUEUE'}</span><h3>${count} ${count === 1 ? 'command' : 'commands'} queued</h3><p>${receipt.replayed ? 'The original submission was recovered. No additional commands were created.' : 'All targets were saved together.'} This confirms queueing, not execution.</p></div></div>
      <dl class="command-receipt-meta"><dt>Request key</dt><dd><code>${esc(receipt.request_key)}</code></dd><dt>Submitted</dt><dd>${esc(App.formatDate(receipt.created_at))}</dd></dl>
      ${count ? `<div class="table-wrap" tabindex="0" role="region" aria-label="Submission targets; scroll for all columns"><table><thead><tr><th>Target</th><th>Queue state at submission</th><th>Command / result</th></tr></thead><tbody>${receipt.targets.map((target, index) => `<tr><td><strong>${esc(target.hostname)}</strong><small class="text-muted">${esc(target.agent_id)}</small></td><td>${renderCommandStatus(target.status)}</td><td><button class="btn btn-sm" data-receipt-target="${index}">View result</button><code>${esc(target.command_id)}</code></td></tr>`).join('')}</tbody></table></div>` : UI.empty('No targets in this group', 'No commands were created. The target list is fixed for this request key. Select a populated group in a new command.', 'server')}
      <p class="text-muted">Scripts awaiting approval cannot be collected by agents. Open a result to check the current execution state. Closing this receipt keeps the commands in history.</p>
    </section>`);
    dialog.querySelectorAll('[data-receipt-target]').forEach(button => button.addEventListener('click', () => {
      const target = receipt.targets[Number(button.dataset.receiptTarget)];
      if (target) { dialog.close(); showLog(target.command_id); }
    }));
  }

  async function sendSubmission(dialog) {
    const pending = dialog.commandSubmission;
    if (pending.owner !== API.getUser()?.id) throw new Error('Account changed. The original submission cannot be retried from this account.');
    try {
      const response = await API.createCommand(pending.command, pending.key);
      if (pending.owner !== API.getUser()?.id) throw new Error('Account changed while confirming the submission.');
      const receipt = response?.data;
      if (!Array.isArray(receipt?.targets) || receipt.request_key !== pending.key || receipt.commands_created !== receipt.targets.length ||
          receipt.targets.some(target => !target || typeof target.agent_id !== 'string' || !target.agent_id || typeof target.command_id !== 'string' || !target.command_id || !['pending','awaiting_approval'].includes(target.status))) {
        throw new Error('Invalid submission receipt.');
      }
      const approval = receipt.targets.some(target => target.status === 'awaiting_approval');
      let message = receipt.commands_created === 0 ? 'No commands created. The group had no targets.' : pending.command.group_id ? `${receipt.commands_created} commands created.` : 'Command queued.';
      if (receipt.commands_created) message += approval ? ' Scripts are awaiting approval.' : ' Waiting for agent results.';
      if (receipt.replayed) message += ' Original receipt recovered; no duplicates created.';
      return {message, receipt};
    } catch (err) {
      throw new Error(`${err.message} The outcome is unconfirmed. Retry sends the original unchanged operation with the same key. Keep this dialog open; starting a new command uses a new key.`);
    }
  }

  async function submitCommand(dialog) {
    if (dialog.commandSubmission) return sendSubmission(dialog);
    const executionMode = document.getElementById('cmd-execution-mode').value;
    const targetType = document.getElementById('cmd-target-type').value;
    const agentId = targetType === 'server' ? document.getElementById('cmd-agent-id').value : null;
    const groupId = targetType === 'group' ? document.getElementById('cmd-group-id').value : null;
    if (!agentId && !groupId) throw new Error('Choose a server or group before submitting.');
    const blueprint = collectCommandBlueprint();
    if (blueprint.error) throw new Error(blueprint.error);
    const {type, priority, timeout, dryRun, payload} = blueprint;
    const command = {agent_id: agentId, group_id: groupId, type, priority, timeout_seconds: timeout, dry_run: dryRun, payload};
    if (executionMode === 'scheduled') {
      const name = document.getElementById('schedule-name').value.trim();
      const cron = document.getElementById('schedule-cron').value.trim();
      if (!name || !cron) throw new Error('Schedule name and cron expression are required.');
      await API.createScheduledCommand({...command, name, cron_expr: cron, maintenance_window_id: document.getElementById('schedule-maintenance-window-id').value});
      return 'Schedule created. Execution history appears after the scheduler queues work.';
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    const key = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    dialog.commandSubmission = {key, command, owner: API.getUser()?.id};
    dialog.querySelectorAll('input, select, textarea, button[type="button"]').forEach(field => { field.disabled = true; });
    dialog.querySelector('[data-submit]').textContent = 'Retry original submission';
    return sendSubmission(dialog);
  }

  function getSelectedUploadedPackage(selectID) {
    const select = document.getElementById(selectID);
    if (!select || !select.value) return null;
    return packages.find(pkg => pkg.id === select.value) || null;
  }

  function buildPublicPackageURL(pkg) {
    const filename = pkg.filename || extractFileName(pkg.file_path || '') || `${pkg.name}-${pkg.version}`;
    return `${window.location.origin}/api/packages/public/${encodeURIComponent(pkg.id)}/${encodeURIComponent(filename)}`;
  }

  function extractFileName(path) {
    if (!path) return '';
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || '';
  }

  function normalizeOSTarget(os) {
    const value = (os || '').toLowerCase();
    if (value.includes('win')) return 'windows';
    if (value.includes('linux')) return 'linux';
    return value;
  }

  function sortPackages(a, b) {
    return formatPackageLabel(a).localeCompare(formatPackageLabel(b));
  }

  function formatMaintenanceDays(days) {
    const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return (Array.isArray(days) ? days : [])
      .map(day => labels[Number(day)] || String(day))
      .join(', ');
  }

  function formatPackageLabel(pkg) {
    const scopes = [pkg.os_target || 'all OS', pkg.arch_target || 'all arch'].join(' / ');
    return `${pkg.name} ${pkg.version} [${scopes}]`;
  }

  function renderCommandStatus(status) {
    const normalized = (status || 'unknown').toLowerCase();
    if (normalized === 'success') return renderStatusPill(normalized, 'status-online');
    if (normalized === 'running' || normalized === 'awaiting_approval') return renderStatusPill(normalized, 'status-warning');
    if (normalized === 'error' || normalized === 'timeout') return renderStatusPill(normalized, 'status-offline');
    return renderStatusPill(normalized, 'status-unknown');
  }

  function renderServiceStatus(status) {
    const normalized = (status || 'unknown').toLowerCase();
    if (normalized === 'running' || normalized === 'active' || normalized === 'started') return renderStatusPill(normalized, 'status-online');
    if (normalized === 'stopped' || normalized === 'failed' || normalized === 'inactive') return renderStatusPill(normalized, 'status-offline');
    return renderStatusPill(normalized, 'status-unknown');
  }

  function renderCommandResultSummary(cmd) {
    if (getDisplayStatus(cmd) === 'awaiting_approval') {
      return '<span class="text-muted">Waiting for manual approval</span>';
    }
    const text = cmd.error || cmd.output || (cmd.status === 'pending' ? 'Waiting for agent' : 'No result');
    return `<span class="text-muted">${App.escHtml(shorten(text, 80))}</span>`;
  }

  function serviceOrder(status) {
    const normalized = (status || '').toLowerCase();
    if (normalized === 'stopped' || normalized === 'failed' || normalized === 'inactive') return 0;
    if (normalized === 'running' || normalized === 'active') return 1;
    return 2;
  }

  function renderKV(label, value) {
    return `
      <div class="report-kv-row">
        <span class="report-kv-label">${App.escHtml(toTitle(label))}</span>
        <span class="report-kv-value">${App.escHtml(value || '-')}</span>
      </div>
    `;
  }

  function toTitle(key) {
    return key.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
  }

  function shorten(value, limit) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= limit) return text || '-';
    return text.slice(0, limit - 1) + '…';
  }

  function stripHtml(value) {
    return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function getDisplayStatus(cmd) {
    if (cmd && cmd.requires_approval && !cmd.approved_at && cmd.status === 'pending') {
      return 'awaiting_approval';
    }
    return cmd && cmd.status ? cmd.status : 'unknown';
  }

  async function deleteTemplate(id) {
    if (!confirm('Delete this template?')) return;
    await runAction('deleteTemplate', id, () => API.deleteCommandTemplate(id), 'Template deleted.');
  }

  function setValue(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = value;
  }

  function canApprove() {
    const user = API.getUser();
    return !!user && (user.role === 'admin' || (Array.isArray(user.permissions) && user.permissions.includes('commands.approve')));
  }

  function renderStatusPill(label, className) {
    return `<span class="status ${className}">${App.escHtml(toTitle(label))}</span>`;
  }

  return {
    render,
    reload,
    applyFilters,
    clearFilters,
    showLog,
    cancel,
    approve,
    deleteScheduled,
    showCreateModal,
    showCreateFor,
    showCreateFromTemplate,
    onExecutionModeChange,
    onTargetTypeChange,
    onCmdTypeChange,
    onAgentSelectionChange,
    onCommandOptionsChange,
    toggleTemplateSave,
    refreshTarget() { updateAgentContext(); refreshMaintenanceWindowOptions(); },
    applySelectedTemplate,
    saveCurrentAsTemplate,
    deleteTemplate,
    showMaintenanceWindowModal,
    onMaintenanceTargetChange,
    deleteMaintenanceWindow
  };
})();
