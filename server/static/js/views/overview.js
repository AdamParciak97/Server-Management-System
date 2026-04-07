'use strict';

Views.Overview = (() => {
  async function render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2>Overview</h2>
        <div class="page-actions">
          <button class="btn btn-sm" onclick="Views.Overview.refresh()">&#8635; Refresh</button>
        </div>
      </div>
      <div class="grid-4 mb-2" id="stats-grid">
        <div class="card stat-card info"><div class="stat-value" id="st-total">-</div><div class="stat-label">Total Servers</div></div>
        <div class="card stat-card online"><div class="stat-value" id="st-online">-</div><div class="stat-label">Online</div></div>
        <div class="card stat-card offline"><div class="stat-value" id="st-offline">-</div><div class="stat-label">Offline</div></div>
        <div class="card stat-card warning"><div class="stat-value" id="st-alerts">-</div><div class="stat-label">Active Alerts</div></div>
      </div>
      <div class="grid-4 mb-2">
        <div class="card stat-card info"><div class="stat-value" id="st-baselines">-</div><div class="stat-label">Baselines</div></div>
        <div class="card stat-card online"><div class="stat-value" id="st-licensed-windows">-</div><div class="stat-label">Licensed Windows</div></div>
        <div class="card stat-card warning"><div class="stat-value" id="st-scheduled-tasks">-</div><div class="stat-label">Scheduled Tasks</div></div>
        <div class="card stat-card info"><div class="stat-value" id="st-windows-assets">-</div><div class="stat-label">Windows Assets</div></div>
      </div>
      <div class="grid-4 mb-2">
        <div class="card stat-card warning"><div class="stat-value" id="st-pending-updates">-</div><div class="stat-label">Hosts With Pending Updates</div></div>
        <div class="card stat-card offline"><div class="stat-value" id="st-pending-reboot">-</div><div class="stat-label">Hosts Pending Reboot</div></div>
        <div class="card stat-card info"><div class="stat-value" id="st-service-roles">-</div><div class="stat-label">Service Roles</div></div>
        <div class="card stat-card info"><div class="stat-value" id="st-dependencies">-</div><div class="stat-label">Dependency Edges</div></div>
      </div>
      <div class="grid-4 mb-2">
        <div class="card stat-card offline"><div class="stat-value" id="st-bitlocker-risk">-</div><div class="stat-label">BitLocker Risk Hosts</div></div>
        <div class="card stat-card warning"><div class="stat-value" id="st-rdp-enabled">-</div><div class="stat-label">RDP Enabled Hosts</div></div>
        <div class="card stat-card warning"><div class="stat-value" id="st-winrm-enabled">-</div><div class="stat-label">WinRM Enabled Hosts</div></div>
        <div class="card stat-card warning"><div class="stat-value" id="st-expiring-certs">-</div><div class="stat-label">Expiring Certificates</div></div>
      </div>
      <div class="grid-2 mb-2">
        <div class="card">
          <div class="section-title">Server Status Distribution</div>
          <div id="status-distribution"></div>
        </div>
        <div class="card">
          <div class="section-title">OS Distribution</div>
          <div id="os-distribution"></div>
        </div>
      </div>
      <div class="grid-2 mb-2">
        <div class="card">
          <div class="section-title">License Channel Distribution</div>
          <div id="license-channel-distribution"></div>
        </div>
        <div class="card">
          <div class="section-title">License Status Distribution</div>
          <div id="license-status-distribution"></div>
        </div>
      </div>
      <div class="grid-2 mb-2">
        <div class="card">
          <div class="section-title">Service Role Distribution</div>
          <div id="service-role-distribution"></div>
        </div>
        <div class="card">
          <div class="section-title">Dependency Map</div>
          <div id="dependency-map-distribution"></div>
        </div>
      </div>
      <div class="grid-2 mb-2">
        <div class="card">
          <div class="section-title">Remote Access Exposure</div>
          <div id="remote-access-distribution"></div>
        </div>
        <div class="card">
          <div class="section-title">Security Posture Summary</div>
          <div id="security-posture-distribution"></div>
        </div>
      </div>
      <div class="card mb-2">
        <div class="section-title">Windows Asset & Licensing Dashboard</div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Hostname</th><th>Status</th><th>Channel</th><th>Product</th><th>KMS</th><th>Key</th><th>Tasks</th>
            </tr></thead>
            <tbody id="asset-licenses"></tbody>
          </table>
        </div>
      </div>
      <div class="card mb-2">
        <div class="section-title">Service Map</div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Hostname</th><th>Group</th><th>Roles</th>
            </tr></thead>
            <tbody id="service-map"></tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="section-title">Recent Servers</div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Hostname</th><th>IP</th><th>OS</th><th>Group</th><th>Last Seen</th><th>Status</th>
            </tr></thead>
            <tbody id="recent-servers"></tbody>
          </table>
        </div>
      </div>
    `;

    await loadData();
  }

  async function refresh() {
    await loadData();
  }

  async function loadData() {
    try {
      const [statsResp, serversResp] = await Promise.all([
        API.getStats(),
        API.getServers()
      ]);

      const stats = statsResp && statsResp.data ? statsResp.data : {};
      const servers = serversResp && serversResp.data ? serversResp.data : [];

      document.getElementById('st-total').textContent = stats.total_servers || 0;
      document.getElementById('st-online').textContent = stats.online_servers || 0;
      document.getElementById('st-offline').textContent = stats.offline_servers || 0;
      document.getElementById('st-alerts').textContent = stats.active_alerts || 0;
      document.getElementById('st-baselines').textContent = stats.baseline_count || 0;
      document.getElementById('st-licensed-windows').textContent = stats.licensed_windows || 0;
      document.getElementById('st-scheduled-tasks').textContent = stats.scheduled_tasks_total || 0;
      document.getElementById('st-pending-updates').textContent = stats.pending_updates_servers || 0;
      document.getElementById('st-pending-reboot').textContent = stats.pending_reboot_servers || 0;
      document.getElementById('st-service-roles').textContent = Object.keys(stats.service_roles || {}).length;
      document.getElementById('st-dependencies').textContent = Object.values(stats.dependency_edges || {}).reduce((sum, value) => sum + Number(value || 0), 0);
      document.getElementById('st-bitlocker-risk').textContent = stats.bitlocker_risk_servers || 0;
      document.getElementById('st-rdp-enabled').textContent = stats.rdp_enabled_servers || 0;
      document.getElementById('st-winrm-enabled').textContent = stats.winrm_enabled_servers || 0;
      document.getElementById('st-expiring-certs').textContent = stats.expiring_certificates || 0;

      const online = Number(stats.online_servers || 0);
      const offline = Number(stats.offline_servers || 0);
      const unknown = Math.max(0, Number(stats.total_servers || 0) - online - offline);
      renderDistribution('status-distribution', [
        { label: 'Online', value: online, color: '#22c55e' },
        { label: 'Offline', value: offline, color: '#ef4444' },
        { label: 'Unknown', value: unknown, color: '#64748b' }
      ]);

      const osCounts = {};
      servers.forEach(server => {
        const key = normalizeOS(server.os);
        osCounts[key] = (osCounts[key] || 0) + 1;
      });
      const osItems = Object.entries(osCounts)
        .map(([label, value], index) => ({
          label,
          value,
          color: ['#4f8ef7', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7'][index % 6]
        }))
        .sort((a, b) => b.value - a.value);
      renderDistribution('os-distribution', osItems);

      const windowsAssets = stats.windows_assets || [];
      document.getElementById('st-windows-assets').textContent = windowsAssets.length;
      renderDistribution('license-channel-distribution', mapDistribution(stats.license_channels, ['#4f8ef7', '#22c55e', '#f59e0b', '#ef4444']));
      renderDistribution('license-status-distribution', mapDistribution(stats.license_statuses, ['#22c55e', '#f59e0b', '#ef4444', '#64748b']));
      renderDistribution('service-role-distribution', mapDistribution(stats.service_roles, ['#06b6d4', '#4f8ef7', '#22c55e', '#f59e0b', '#ef4444', '#a855f7']));
      renderDistribution('dependency-map-distribution', mapDistribution(stats.dependency_edges, ['#4f8ef7', '#22c55e', '#f59e0b', '#ef4444']));
      renderDistribution('remote-access-distribution', [
        { label: 'RDP Enabled', value: Number(stats.rdp_enabled_servers || 0), color: '#ef4444' },
        { label: 'WinRM Enabled', value: Number(stats.winrm_enabled_servers || 0), color: '#f59e0b' },
        { label: 'SSH Enabled', value: Number(stats.ssh_enabled_servers || 0), color: '#06b6d4' }
      ]);
      renderDistribution('security-posture-distribution', [
        { label: 'BitLocker Risk', value: Number(stats.bitlocker_risk_servers || 0), color: '#ef4444' },
        { label: 'Expiring Certificates', value: Number(stats.expiring_certificates || 0), color: '#f59e0b' },
        { label: 'Pending Updates', value: Number(stats.pending_updates_servers || 0), color: '#4f8ef7' }
      ]);
      renderAssetLicensing(windowsAssets);
      renderServiceMap(stats.service_map || []);

      const tbody = document.getElementById('recent-servers');
      if (!tbody) return;
      const recent = [...servers].sort((a, b) => new Date(b.last_seen || 0) - new Date(a.last_seen || 0)).slice(0, 10);
      if (recent.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-muted text-center" style="padding:2rem">No servers registered yet</td></tr>';
        return;
      }
      tbody.innerHTML = recent.map(server => `
        <tr class="clickable" onclick="App.navigate('servers'); Views.Servers.showDetail('${App.escHtml(server.id)}')">
          <td>${App.escHtml(server.hostname)}</td>
          <td>${App.escHtml((server.ip_addresses || []).join(', '))}</td>
          <td>${App.escHtml(server.os || '-')}</td>
          <td>${App.escHtml(server.group_name || '-')}</td>
          <td>${App.timeAgo(server.last_seen)}</td>
          <td>${App.statusBadge(server.status)}</td>
        </tr>
      `).join('');
    } catch (err) {
      console.error('Overview load error:', err);
    }
  }

  function renderDistribution(targetID, items) {
    const el = document.getElementById(targetID);
    if (!el) return;
    const total = items.reduce((sum, item) => sum + Number(item.value || 0), 0);
    if (!items.length || total === 0) {
      el.innerHTML = '<div class="text-muted">No data yet.</div>';
      return;
    }
    el.innerHTML = `
      <div class="distribution-list">
        ${items.map(item => {
          const percent = total ? ((item.value / total) * 100) : 0;
          return `
            <div class="distribution-row">
              <div class="distribution-meta">
                <span>${App.escHtml(item.label)}</span>
                <strong>${item.value} (${percent.toFixed(0)}%)</strong>
              </div>
              <div class="distribution-track">
                <div class="distribution-fill" style="width:${percent}%;background:${item.color}"></div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  function renderAssetLicensing(items) {
    const tbody = document.getElementById('asset-licenses');
    if (!tbody) return;
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-muted text-center" style="padding:2rem">No Windows licensing data yet</td></tr>';
      return;
    }
    tbody.innerHTML = items
      .slice()
      .sort((a, b) => String(a.hostname || '').localeCompare(String(b.hostname || '')))
      .map(item => `
        <tr class="clickable" onclick="App.navigate('servers'); Views.Servers.showDetail('${App.escHtml(item.agent_id)}')">
          <td>${App.escHtml(item.hostname || '-')}</td>
          <td>${App.escHtml(item.license_status || '-')}</td>
          <td>${App.escHtml(item.channel || '-')}</td>
          <td>${App.escHtml(item.product_name || '-')}</td>
          <td>${App.escHtml(item.kms_machine ? `${item.kms_machine}${item.kms_port ? ':' + item.kms_port : ''}` : '-')}</td>
          <td>${App.escHtml(item.partial_product_key || '-')}</td>
          <td>${App.escHtml(item.scheduled_tasks || 0)}</td>
        </tr>
      `).join('');
  }

  function renderServiceMap(items) {
    const tbody = document.getElementById('service-map');
    if (!tbody) return;
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="text-muted text-center" style="padding:2rem">No service role data yet</td></tr>';
      return;
    }
    tbody.innerHTML = items
      .slice()
      .sort((a, b) => String(a.hostname || '').localeCompare(String(b.hostname || '')))
      .map(item => `
        <tr class="clickable" onclick="App.navigate('servers'); Views.Servers.showDetail('${App.escHtml(item.agent_id)}')">
          <td>${App.escHtml(item.hostname || '-')}</td>
          <td>${App.escHtml(item.group_name || '-')}</td>
          <td>${App.escHtml((item.roles || []).join(', ') || '-')}</td>
        </tr>
      `).join('');
  }

  function mapDistribution(source, colors) {
    const entries = Object.entries(source || {});
    return entries.map(([label, value], index) => ({
      label,
      value,
      color: colors[index % colors.length]
    })).sort((a, b) => b.value - a.value);
  }

  function normalizeOS(value) {
    const os = (value || 'unknown').toLowerCase();
    if (os.includes('windows')) return 'Windows';
    if (os.includes('linux')) return 'Linux';
    return os.charAt(0).toUpperCase() + os.slice(1);
  }

  return { render, refresh };
})();
