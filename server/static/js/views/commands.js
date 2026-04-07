'use strict';

Views.Commands = (() => {
  let servers = [];
  let groups = [];
  let packages = [];
  let templates = [];
  let scheduledCommands = [];
  let maintenanceWindows = [];
  const servicesByAgent = {};

  async function render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2>Commands</h2>
        <div class="page-actions">
          <button class="btn btn-primary" onclick="Views.Commands.showCreateModal()">+ New Command</button>
          <button class="btn btn-sm" onclick="Views.Commands.reload()">&#8635; Refresh</button>
        </div>
      </div>
      <div class="card mb-2">
        <div class="report-card-header">
          <div class="section-title" style="margin-bottom:0">Saved Templates</div>
          <button class="btn btn-sm btn-primary" onclick="Views.Commands.showCreateModal()">Create From Scratch</button>
        </div>
        <div id="templates-list" class="report-summary">
          <div class="text-center"><span class="spinner"></span></div>
        </div>
      </div>
      <div class="grid-2">
        <div class="card mb-2" id="commands-list">
          <div class="section-title">Command History</div>
          <div class="filters">
            <select id="cmd-filter-status">
              <option value="">All statuses</option>
              <option value="awaiting_approval">Awaiting Approval</option>
              <option value="pending">Pending</option>
              <option value="sent">Sent</option>
              <option value="running">Running</option>
              <option value="success">Success</option>
              <option value="error">Error</option>
              <option value="timeout">Timeout</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr>
                <th>ID</th><th>Server</th><th>Type</th><th>Priority</th>
                <th>Status</th><th>Result</th><th>Created</th><th>Actions</th>
              </tr></thead>
              <tbody id="commands-tbody">
                <tr><td colspan="8" class="text-center"><span class="spinner"></span></td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="card mb-2">
          <div class="section-title">Scheduled Checks & Commands</div>
          <div class="text-muted mb-1">Use cron to queue checks or maintenance for a single server or an entire group.</div>
          <div class="table-wrap">
            <table>
              <thead><tr>
                <th>Name</th><th>Target</th><th>Type</th><th>Cron</th><th>Window</th><th>Last Run</th><th>Actions</th>
              </tr></thead>
              <tbody id="scheduled-tbody">
                <tr><td colspan="7" class="text-center"><span class="spinner"></span></td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="card mb-2">
        <div class="report-card-header">
          <div class="section-title" style="margin-bottom:0">Maintenance Windows</div>
          <button class="btn btn-sm btn-primary" onclick="Views.Commands.showMaintenanceWindowModal()">+ New Window</button>
        </div>
        <div class="text-muted mb-1">Windows restrict scheduled execution to approved hours for a server or an entire group.</div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Name</th><th>Target</th><th>Days</th><th>Hours</th><th>Timezone</th><th>Actions</th>
            </tr></thead>
            <tbody id="maintenance-windows-tbody">
              <tr><td colspan="6" class="text-center"><span class="spinner"></span></td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    await reload();

    document.getElementById('cmd-filter-status').addEventListener('change', () => reloadCommandsOnly());
  }

  async function loadReferenceData() {
    try {
      const [serverResp, groupResp, packageResp, templateResp, maintenanceResp] = await Promise.all([
        API.getServers(),
        API.listGroups(),
        API.listPackages(),
        API.listCommandTemplates(),
        API.listMaintenanceWindows()
      ]);
      servers = serverResp && serverResp.data ? serverResp.data : [];
      groups = groupResp && groupResp.data ? groupResp.data : [];
      packages = packageResp && packageResp.data ? packageResp.data : [];
      templates = templateResp && templateResp.data ? templateResp.data : [];
      maintenanceWindows = maintenanceResp && maintenanceResp.data ? maintenanceResp.data : [];
    } catch {
      servers = [];
      groups = [];
      packages = [];
      templates = [];
      maintenanceWindows = [];
    }
  }

  async function reload() {
    await loadReferenceData();
    renderTemplates();
    renderMaintenanceWindows();
    await Promise.all([reloadCommandsOnly(), reloadScheduledOnly()]);
  }

  async function reloadCommandsOnly() {
    const status = document.getElementById('cmd-filter-status') ?
      document.getElementById('cmd-filter-status').value : '';
    try {
      const resp = await API.listCommands();
      let cmds = (resp && resp.data) ? resp.data : [];
      if (status) cmds = cmds.filter(c => getDisplayStatus(c) === status);
      renderTable(cmds);
    } catch (err) {
      document.getElementById('commands-tbody').innerHTML =
        `<tr><td colspan="8" class="error-msg">${App.escHtml(err.message)}</td></tr>`;
    }
  }

  async function reloadScheduledOnly() {
    try {
      const resp = await API.listScheduledCommands();
      scheduledCommands = (resp && resp.data) ? resp.data : [];
      renderScheduledTable();
    } catch (err) {
      document.getElementById('scheduled-tbody').innerHTML =
        `<tr><td colspan="6" class="error-msg">${App.escHtml(err.message)}</td></tr>`;
    }
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
    if (!cmds || cmds.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted" style="padding:2rem">No commands found</td></tr>';
      return;
    }

    tbody.innerHTML = cmds.map(cmd => `
      <tr>
        <td class="monospace text-muted" style="font-size:.75rem">${cmd.id.slice(0, 8)}</td>
        <td>${App.escHtml(getTargetName(cmd))}</td>
        <td class="monospace">${App.escHtml(cmd.type)}</td>
        <td><span class="${App.priorityClass(cmd.priority)}">${App.escHtml(cmd.priority)}</span></td>
        <td>${renderCommandStatus(getDisplayStatus(cmd))}</td>
        <td>${renderCommandResultSummary(cmd)}</td>
        <td>${App.timeAgo(cmd.created_at)}</td>
        <td>
          <button class="btn btn-sm" onclick="Views.Commands.showLog('${cmd.id}')">View</button>
          ${getDisplayStatus(cmd) === 'awaiting_approval' && canApprove() ?
            `<button class="btn btn-sm btn-primary" onclick="Views.Commands.approve('${cmd.id}')">Approve</button>` : ''}
          ${(cmd.status === 'pending' || cmd.status === 'sent') ?
            `<button class="btn btn-sm btn-danger" onclick="Views.Commands.cancel('${cmd.id}')">Cancel</button>` : ''}
        </td>
      </tr>
    `).join('');
  }

  function renderScheduledTable() {
    const tbody = document.getElementById('scheduled-tbody');
    if (!tbody) return;
    if (!scheduledCommands.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted" style="padding:2rem">No scheduled commands</td></tr>';
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
        <td><button class="btn btn-sm btn-danger" onclick="Views.Commands.deleteScheduled('${item.id}')">Delete</button></td>
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
        <td><button class="btn btn-sm btn-danger" onclick="Views.Commands.deleteMaintenanceWindow('${item.id}')">Delete</button></td>
      </tr>
    `).join('');
  }

  function renderTemplates() {
    const container = document.getElementById('templates-list');
    if (!container) return;
    if (!templates.length) {
      container.innerHTML = '<div class="text-muted">No saved templates yet. Open a command modal and save one after filling the fields you reuse most often.</div>';
      return;
    }
    container.innerHTML = templates.map(item => `
      <div class="report-summary-item">
        <div>
          <div><strong>${App.escHtml(item.name)}</strong></div>
          <div class="text-muted mt-1">${App.escHtml(item.description || item.type)}</div>
          <div class="text-muted mt-1 monospace">${App.escHtml(item.type)} | ${App.escHtml(item.priority)} | timeout ${item.timeout_seconds || 1800}s</div>
        </div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:flex-start">
          <button class="btn btn-sm" onclick="Views.Commands.showCreateFromTemplate('${item.id}')">Use</button>
          <button class="btn btn-sm btn-danger" onclick="Views.Commands.deleteTemplate('${item.id}')">Delete</button>
        </div>
      </div>
    `).join('');
  }

  async function showLog(id) {
    if (!servers.length && !groups.length) {
      await loadReferenceData();
    }
    try {
      const resp = await API.getCommandLog(id);
      const cmd = resp && resp.data ? resp.data : {};
      App.showModal('Command Result', renderCommandDetail(cmd), null, {
        size: 'wide',
        cancelLabel: 'Close'
      });
    } catch (err) {
      alert('Error: ' + err.message);
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
            ${renderKV('Duration', cmd.duration_ms ? `${cmd.duration_ms} ms` : '-')}
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
                <label>Approval Note</label>
                <textarea id="approval-note" rows="4" placeholder="Optional note"></textarea>
              </div>
              <button class="btn btn-primary" onclick="Views.Commands.approve('${cmd.id}', true)">Approve Script</button>
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
          <pre class="output">${App.escHtml(cmd.output || 'No output')}</pre>
        </div>
        <div class="card">
          <div class="section-title">Error</div>
          <pre class="output" style="color:${cmd.error ? '#ef4444' : 'inherit'}">${App.escHtml(cmd.error || 'No error')}</pre>
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

  async function cancel(id) {
    if (!confirm('Cancel this command?')) return;
    try {
      await API.cancelCommand(id);
      await reloadCommandsOnly();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function approve(id, closeModal) {
    const noteEl = document.getElementById('approval-note');
    const note = noteEl ? noteEl.value.trim() : '';
    try {
      await API.approveCommand(id, note);
      if (closeModal) {
        const overlay = document.getElementById('modal-overlay');
        if (overlay) overlay.remove();
      }
      await reloadCommandsOnly();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function deleteScheduled(id) {
    if (!confirm('Delete this scheduled command?')) return;
    try {
      await API.deleteScheduledCommand(id);
      await reloadScheduledOnly();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  function showMaintenanceWindowModal() {
    const serverOptions = servers.map(server =>
      `<option value="${server.id}">${App.escHtml(server.hostname)}</option>`
    ).join('');
    const groupOptions = groups.map(group =>
      `<option value="${group.id}">${App.escHtml(group.name)}</option>`
    ).join('');
    const dayOptions = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      .map((label, index) => `<label><input type="checkbox" class="mw-day" value="${index}" ${index >= 1 && index <= 5 ? 'checked' : ''}> ${label}</label>`)
      .join(' ');

    App.showModal('Create Maintenance Window', `
      <div class="form-row">
        <div class="form-group">
          <label>Name</label>
          <input type="text" id="mw-name" placeholder="Weekend patch window">
        </div>
        <div class="form-group">
          <label>Timezone</label>
          <input type="text" id="mw-timezone" value="Europe/Warsaw" placeholder="Europe/Warsaw">
        </div>
      </div>
      <div class="form-group">
        <label>Target</label>
        <select id="mw-target-type" onchange="Views.Commands.onMaintenanceTargetChange()">
          <option value="group">Group</option>
          <option value="server">Server</option>
        </select>
      </div>
      <div class="form-group" id="mw-group-wrap">
        <label>Group</label>
        <select id="mw-group-id">${groupOptions}</select>
      </div>
      <div class="form-group hidden" id="mw-server-wrap">
        <label>Server</label>
        <select id="mw-agent-id">${serverOptions}</select>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Start</label>
          <input type="time" id="mw-start" value="22:00">
        </div>
        <div class="form-group">
          <label>End</label>
          <input type="time" id="mw-end" value="04:00">
        </div>
      </div>
      <div class="form-group">
        <label>Days</label>
        <div class="filters">${dayOptions}</div>
      </div>
    `, async () => {
      await submitMaintenanceWindow();
    }, {
      size: 'wide',
      cancelLabel: 'Close'
    });
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
    if (!name || !startTime || !endTime || !days.length) {
      alert('Name, start, end and at least one day are required.');
      return;
    }
    const payload = {
      name,
      timezone,
      days_of_week: days,
      start_time: startTime,
      end_time: endTime
    };
    if (targetType === 'server') payload.agent_id = document.getElementById('mw-agent-id').value;
    else payload.group_id = document.getElementById('mw-group-id').value;

    try {
      await API.createMaintenanceWindow(payload);
      await reload();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function deleteMaintenanceWindow(id) {
    if (!confirm('Delete this maintenance window?')) return;
    try {
      await API.deleteMaintenanceWindow(id);
      await reload();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function showCreateFor(agentId) {
    await showCreateModal(agentId, '');
  }

  async function showCreateFromTemplate(templateId) {
    await showCreateModal('', templateId);
  }

  async function showCreateModal(preselectedAgentId, templateId) {
    if (!servers.length && !groups.length && !packages.length) {
      await loadReferenceData();
    }
    const serverOptions = servers.map(server =>
      `<option value="${server.id}" ${server.id === preselectedAgentId ? 'selected' : ''}>${App.escHtml(server.hostname)}</option>`
    ).join('');
    const groupOptions = groups.map(group =>
      `<option value="${group.id}">${App.escHtml(group.name)}</option>`
    ).join('');

    const content = `
      <div class="card mb-2">
        <div class="form-row" style="margin-bottom:0">
          <div class="form-group">
            <label>Template</label>
            <select id="cmd-template-id">
              <option value="">No template</option>
              ${templates.map(item => `<option value="${item.id}" ${item.id === templateId ? 'selected' : ''}>${App.escHtml(item.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="align-self:flex-end;flex:0 0 auto">
            <button type="button" class="btn btn-sm" onclick="Views.Commands.applySelectedTemplate()">Load Template</button>
          </div>
          <div class="form-group" style="align-self:flex-end;flex:0 0 auto">
            <button type="button" class="btn btn-sm btn-primary" onclick="Views.Commands.saveCurrentAsTemplate()">Save As Template</button>
          </div>
        </div>
      </div>
      <div class="form-row mb-1">
        <div class="form-group">
          <label>Execution Mode</label>
          <select id="cmd-execution-mode" onchange="Views.Commands.onExecutionModeChange()">
            <option value="immediate">Run now</option>
            <option value="scheduled">Schedule with cron</option>
          </select>
        </div>
        <div class="form-group hidden" id="schedule-name-wrap">
          <label>Schedule Name</label>
          <input type="text" id="schedule-name" placeholder="Nightly package refresh">
        </div>
        <div class="form-group hidden" id="schedule-cron-wrap">
          <label>Cron Expression</label>
          <input type="text" id="schedule-cron" placeholder="0 */6 * * *">
        </div>
        <div class="form-group hidden" id="schedule-window-wrap">
          <label>Maintenance Window</label>
          <select id="schedule-maintenance-window-id"></select>
        </div>
      </div>
      <div class="form-group mb-1">
        <label>Target</label>
        <select id="cmd-target-type" onchange="Views.Commands.onTargetTypeChange()">
          <option value="server">Server</option>
          <option value="group">Group</option>
        </select>
      </div>
      <div class="form-group mb-1" id="cmd-server-sel">
        <label>Server</label>
        <select id="cmd-agent-id" onchange="Views.Commands.onAgentSelectionChange()">${serverOptions}</select>
      </div>
      <div class="form-group mb-1 hidden" id="cmd-group-sel">
        <label>Group</label>
        <select id="cmd-group-id">${groupOptions}</select>
      </div>
      <div class="form-group mb-1">
        <label>Command Type</label>
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
          <label>Priority</label>
          <select id="cmd-priority">
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
            <option value="low">Low</option>
          </select>
        </div>
        <div class="form-group">
          <label>Timeout (sec)</label>
          <input type="number" id="cmd-timeout" value="1800" min="30">
        </div>
        <div class="form-group" style="flex:0;align-self:flex-end;padding-bottom:.1rem">
          <label><input type="checkbox" id="cmd-dry-run"> Dry-run</label>
        </div>
      </div>
      <div id="cmd-agent-context" class="text-muted mb-1"></div>
      <div id="cmd-extra"></div>
    `;

    App.showModal('Create Command', content, async () => {
      await submitCommand();
    }, {
      size: 'wide',
      cancelLabel: 'Close'
    });

    setTimeout(async () => {
      onExecutionModeChange();
      onTargetTypeChange();
      onCmdTypeChange();
      if (preselectedAgentId) {
        document.getElementById('cmd-agent-id').value = preselectedAgentId;
      }
      await onAgentSelectionChange();
      if (templateId) {
        applyTemplateToModal(templateId);
      }
    }, 50);
  }

  function onExecutionModeChange() {
    const mode = document.getElementById('cmd-execution-mode').value;
    document.getElementById('schedule-name-wrap').classList.toggle('hidden', mode !== 'scheduled');
    document.getElementById('schedule-cron-wrap').classList.toggle('hidden', mode !== 'scheduled');
    document.getElementById('schedule-window-wrap').classList.toggle('hidden', mode !== 'scheduled');
    refreshMaintenanceWindowOptions();
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
          <label>Update Mode</label>
          <select id="system-update-mode" onchange="Views.Commands.onCommandOptionsChange()">
            <option value="system">Use OS package manager</option>
            <option value="uploaded">Install uploaded update file</option>
          </select>
        </div>
        <div id="system-package-wrap" class="form-group hidden">
          <label>Uploaded Package</label>
          <select id="system-package-file"></select>
          <div class="text-muted mt-1">If you choose an uploaded file, it will be queued as an install command using the package file from the server.</div>
        </div>`,
      install_package: `
        <div class="form-group mb-1">
          <label>Package Source</label>
          <select id="package-source" onchange="Views.Commands.onCommandOptionsChange()">
            <option value="uploaded">Uploaded package file</option>
            <option value="manual">Package manager name</option>
          </select>
        </div>
        <div id="package-uploaded-wrap" class="form-group">
          <label>Uploaded Package</label>
          <select id="cmd-package-file"></select>
        </div>
        <div id="package-manual-wrap" class="hidden">
          <div class="form-row">
            <div class="form-group"><label>Package Name</label><input type="text" id="pkg-name" placeholder="nginx"></div>
            <div class="form-group"><label>Version (optional)</label><input type="text" id="pkg-version"></div>
          </div>
        </div>`,
      install_agent: `
        <div class="text-muted mb-1">Queues a self-update on the target agent. Latest from server uses the bundled binary for the agent OS/architecture.</div>
        <div class="form-group mb-1">
          <label>Agent Source</label>
          <select id="agent-source" onchange="Views.Commands.onCommandOptionsChange()">
            <option value="latest">Latest compatible binary from server bundle</option>
            <option value="uploaded">Uploaded package file</option>
          </select>
        </div>
        <div id="agent-uploaded-wrap" class="form-group hidden">
          <label>Uploaded Agent Package</label>
          <select id="cmd-agent-package-file"></select>
        </div>`,
      run_script: `
        <div class="text-muted mb-1">Scripts are queued for review first and delivered to the agent only after manual approval.</div>
        <div class="form-group mb-1">
          <label>Script Type</label>
          <select id="script-type">
            <option value="bash">Bash</option>
            <option value="powershell">PowerShell</option>
          </select>
        </div>
        <div class="form-group">
          <label>Script Content</label>
          <textarea id="script-content" rows="12" placeholder="#!/bin/bash&#10;echo hello"></textarea>
        </div>`,
      service_control: `
        <div class="form-group mb-1">
          <label>Known Service</label>
          <select id="svc-select" onchange="Views.Commands.onCommandOptionsChange()"></select>
        </div>
        <div id="svc-status" class="text-muted mb-1"></div>
        <div class="form-row">
          <div class="form-group">
            <label>Service Name</label>
            <input type="text" id="svc-name" placeholder="nginx">
          </div>
          <div class="form-group">
            <label>Action</label>
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

  async function refreshServiceOptions() {
    const select = document.getElementById('svc-select');
    if (!select) return;

    const agent = getSelectedAgent();
    if (!agent) {
      select.innerHTML = '<option value="">Select a server to load services</option>';
      updateServiceSelection();
      return;
    }

    const services = await getAgentServices(agent.id);
    if (!services.length) {
      select.innerHTML = '<option value="">No services in latest report</option>';
      updateServiceSelection();
      return;
    }

    select.innerHTML = `
      <option value="">Select service from latest report</option>
      ${services.map(service => `
        <option value="${App.escHtml(service.name)}">
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
      if (select) select.innerHTML = html;
    });
    const agentSelect = document.getElementById('cmd-agent-package-file');
    if (agentSelect) agentSelect.innerHTML = agentHtml;
  }

  function buildPackageOptions(items) {
    if (!items.length) {
      return '<option value="">No uploaded packages match this target</option>';
    }
    return `
      <option value="">Select uploaded package</option>
      ${items.map(pkg => `
        <option value="${pkg.id}">
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
      el.textContent = 'Group target selected. Compatibility filters and service status are not available.';
      return;
    }
    el.textContent = `Target OS: ${agent.os || '-'} ${agent.os_version || ''} | Arch: ${agent.architecture || '-'} | Last seen: ${agent.last_seen ? App.timeAgo(agent.last_seen) : 'never'}`;
  }

  function refreshMaintenanceWindowOptions() {
    const select = document.getElementById('schedule-maintenance-window-id');
    if (!select) return;
    const windows = getApplicableMaintenanceWindows();
    select.innerHTML = `
      <option value="">No maintenance window</option>
      ${windows.map(item => `
        <option value="${item.id}">
          ${App.escHtml(`${item.name} (${formatMaintenanceDays(item.days_of_week)}, ${item.start_time}-${item.end_time} ${item.timezone || 'UTC'})`)}
        </option>
      `).join('')}
    `;
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
    } catch {
      servicesByAgent[agentID] = [];
    }
    return servicesByAgent[agentID];
  }

  function collectCommandBlueprint() {
    const requestedType = document.getElementById('cmd-type').value;
    const priority = document.getElementById('cmd-priority').value;
    const timeout = parseInt(document.getElementById('cmd-timeout').value, 10) || 1800;
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

  async function saveCurrentAsTemplate() {
    const blueprint = collectCommandBlueprint();
    if (blueprint.error) {
      alert(blueprint.error);
      return;
    }
    const name = window.prompt('Template name');
    if (!name || !name.trim()) return;
    const description = window.prompt('Template description (optional)') || '';
    try {
      await API.createCommandTemplate({
        name: name.trim(),
        description: description.trim(),
        type: blueprint.type,
        priority: blueprint.priority,
        timeout_seconds: blueprint.timeout,
        dry_run: blueprint.dryRun,
        payload: blueprint.payload
      });
      await reload();
      alert('Template saved');
    } catch (err) {
      alert('Error: ' + err.message);
    }
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
  }

  async function submitCommand() {
    const executionMode = document.getElementById('cmd-execution-mode').value;
    const targetType = document.getElementById('cmd-target-type').value;
    const agentId = targetType === 'server' ? document.getElementById('cmd-agent-id').value : null;
    const groupId = targetType === 'group' ? document.getElementById('cmd-group-id').value : null;
    const blueprint = collectCommandBlueprint();
    if (blueprint.error) {
      alert(blueprint.error);
      return;
    }
    const { type, priority, timeout, dryRun, payload } = blueprint;

    try {
      if (executionMode === 'scheduled') {
        const scheduleName = document.getElementById('schedule-name').value.trim();
        const scheduleCron = document.getElementById('schedule-cron').value.trim();
        if (!scheduleName || !scheduleCron) {
          alert('Schedule name and cron expression are required.');
          return;
        }
        await API.createScheduledCommand({
          name: scheduleName,
          cron_expr: scheduleCron,
          agent_id: agentId,
          group_id: groupId,
          maintenance_window_id: document.getElementById('schedule-maintenance-window-id') ? document.getElementById('schedule-maintenance-window-id').value : '',
          type,
          priority,
          timeout_seconds: timeout,
          dry_run: dryRun,
          payload
        });
        await reloadScheduledOnly();
      } else {
        await API.createCommand({
          agent_id: agentId,
          group_id: groupId,
          type,
          priority,
          timeout_seconds: timeout,
          dry_run: dryRun,
          payload
        });
        await reloadCommandsOnly();
      }
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  function getSelectedUploadedPackage(selectID) {
    const select = document.getElementById(selectID);
    if (!select || !select.value) return null;
    return packages.find(pkg => pkg.id === select.value) || null;
  }

  function buildPublicPackageURL(pkg) {
    const filename = extractFileName(pkg.file_path || '') || `${pkg.name}-${pkg.version}`;
    return `${window.location.origin}/api/packages/public/${pkg.id}/${encodeURIComponent(filename)}`;
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
    if (normalized === 'error' || normalized === 'timeout' || normalized === 'cancelled') return renderStatusPill(normalized, 'status-offline');
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
        <span class="report-kv-label">${App.escHtml(label)}</span>
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
    try {
      await API.deleteCommandTemplate(id);
      await reload();
    } catch (err) {
      alert('Error: ' + err.message);
    }
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
    return `<span class="status ${className}">${App.escHtml(label)}</span>`;
  }

  return {
    render,
    reload,
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
    applySelectedTemplate,
    saveCurrentAsTemplate,
    deleteTemplate,
    showMaintenanceWindowModal,
    onMaintenanceTargetChange,
    deleteMaintenanceWindow
  };
})();
