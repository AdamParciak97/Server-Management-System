'use strict';

Views.Overview = (() => {
  let loadVersion = 0;

  function metric(id, label, note, tone, icon) {
    return `<div class="card metric-card ${tone}"><div class="metric-header"><span>${label}</span><span class="metric-icon">${UI.icon(icon)}</span></div><div class="stat-value" id="${id}">—</div><div class="metric-footer"><span class="tiny-dot"></span>${note}</div></div>`;
  }

  function detailMetric(id, label) {
    return `<div class="detail-metric"><strong id="${id}">—</strong><span>${label}</span></div>`;
  }

  function distribution(id, title) {
    return `<div class="card"><div class="section-title">${title}</div><div id="${id}"><span class="spinner"></span></div></div>`;
  }

  async function render(container) {
    container.innerHTML = `
      <div class="page-header"><div><h2>Infrastructure overview</h2><p class="page-subtitle">Your entire environment. One clear perspective.</p></div><div class="page-actions"><button class="btn" onclick="Views.Overview.refresh()">${UI.icon('refresh')}Refresh</button><a class="btn btn-primary" href="#servers">${UI.icon('server')}View servers</a></div></div>
      <div id="overview-error" class="error-msg overview-error hidden" role="alert"></div>
      <section class="overview-hero" aria-label="Infrastructure workspace">
        <div class="hero-copy"><span class="eyebrow">VISIBILITY STARTS HERE</span><h3>A connected fleet.<br><em>A clear state of mind.</em></h3><p>Keep every server, service and security signal in view.<br>Your next move starts with the full picture.</p><div class="hero-actions"><a href="#packages" class="btn btn-primary">Connect your infrastructure ${UI.icon('arrow')}</a><a href="#compliance" class="hero-text-link">Explore compliance ↗</a></div></div>
        <div class="hero-visual" aria-hidden="true"><svg viewBox="0 0 400 240"><circle class="halo" cx="222" cy="122" r="110"/><circle class="orbit" cx="222" cy="122" r="83"/><circle class="orbit" cx="222" cy="122" r="55"/><path class="connector" d="M95 60 222 122 345 65M98 187 222 122 337 190M222 20v204"/><rect class="diagram-node" x="60" y="41" width="70" height="38" rx="7"/><rect class="diagram-node" x="306" y="47" width="70" height="38" rx="7"/><rect class="diagram-node" x="62" y="169" width="70" height="38" rx="7"/><rect class="diagram-node" x="300" y="171" width="70" height="38" rx="7"/><rect class="hub" x="187" y="87" width="70" height="70" rx="18"/><path d="M205 110h34v9h-34zM205 126h34v9h-34z" fill="none" stroke="#9ef1c9"/><circle class="diagram-dot" cx="211" cy="114.5" r="1.5"/><circle class="diagram-dot" cx="211" cy="130.5" r="1.5"/><text x="72" y="64">LINUX</text><text x="315" y="70">WINDOWS</text><text x="75" y="193">AGENT</text><text x="311" y="195">SERVICES</text><circle class="diagram-dot" cx="222" cy="39" r="3"/><circle class="diagram-dot" cx="139" cy="122" r="3"/><circle class="diagram-dot" cx="222" cy="205" r="3"/></svg></div>
      </section>
      <div class="grid-4 metric-grid" id="stats-grid">
        ${metric('st-total', 'Total servers', 'Registered in your workspace', 'info', 'server')}
        ${metric('st-online', 'Online now', 'Currently reporting', 'online', 'pulse')}
        ${metric('st-offline', 'Offline servers', 'Check agent connectivity', 'offline', 'server')}
        ${metric('st-alerts', 'Active alerts', 'Signals requiring attention', 'warning', 'bell')}
      </div>
      <div class="overview-main-grid">
        <section class="card"><div class="section-heading"><h3 class="section-title">Fleet availability</h3><span class="overview-updated" id="overview-updated"><span class="tiny-dot"></span>Loading snapshot</span></div><div class="health-content"><div class="health-ring"><svg viewBox="0 0 140 140" aria-hidden="true"><circle class="ring-track" cx="70" cy="70" r="58"/><circle class="ring-progress" id="fleet-ring" cx="70" cy="70" r="58" stroke-dasharray="0 365"/></svg><div class="ring-label"><strong id="fleet-percent">—</strong><span>servers online</span></div></div><div id="status-distribution"></div></div></section>
        ${distribution('os-distribution', 'Operating systems')}
      </div>
      <section class="card data-card"><div class="section-heading"><h3 class="section-title">Recently seen servers</h3><a href="#servers">View inventory ↗</a></div><div class="table-wrap"><table><thead><tr><th>Hostname</th><th>IP address</th><th>Operating system</th><th>Group</th><th>Last seen</th><th>Status</th></tr></thead><tbody id="recent-servers"><tr><td colspan="6"><span class="spinner"></span></td></tr></tbody></table></div></section>
      <details class="details-section"><summary><span>Security & maintenance<small>Exposure, updates and certificates</small></span></summary><div class="detail-metrics">
        ${detailMetric('st-pending-updates', 'Hosts with pending updates')}${detailMetric('st-pending-reboot', 'Hosts pending reboot')}${detailMetric('st-bitlocker-risk', 'BitLocker risk hosts')}${detailMetric('st-expiring-certs', 'Expiring certificates')}
        ${detailMetric('st-rdp-enabled', 'RDP enabled hosts')}${detailMetric('st-winrm-enabled', 'WinRM enabled hosts')}${detailMetric('st-baselines', 'Saved baselines')}${detailMetric('st-scheduled-tasks', 'Scheduled tasks')}
      </div><div class="grid-2 mb-2">${distribution('remote-access-distribution', 'Remote access exposure')}${distribution('security-posture-distribution', 'Security posture')}</div></details>
      <details class="details-section"><summary><span>Assets & licensing<small>Windows estate and license coverage</small></span></summary><div class="detail-metrics">${detailMetric('st-licensed-windows', 'Licensed Windows hosts')}${detailMetric('st-windows-assets', 'Windows assets')}</div><div class="grid-2 mb-2">${distribution('license-channel-distribution', 'License channels')}${distribution('license-status-distribution', 'License status')}</div><div class="table-wrap mb-2"><table><thead><tr><th>Hostname</th><th>Status</th><th>Channel</th><th>Product</th><th>KMS</th><th>Key</th><th>Tasks</th></tr></thead><tbody id="asset-licenses"></tbody></table></div></details>
      <details class="details-section"><summary><span>Services & dependencies<small>How your environment connects</small></span></summary><div class="detail-metrics">${detailMetric('st-service-roles', 'Service roles')}${detailMetric('st-dependencies', 'Dependency edges')}</div><div class="grid-2 mb-2">${distribution('service-role-distribution', 'Service roles')}${distribution('dependency-map-distribution', 'Dependencies')}</div><div class="table-wrap mb-2"><table><thead><tr><th>Hostname</th><th>Group</th><th>Roles</th></tr></thead><tbody id="service-map"></tbody></table></div></details>
    `;
    await loadData();
  }

  async function refresh() {
    await loadData();
  }

  async function loadData() {
    const anchor = document.getElementById('stats-grid');
    if (!anchor) return;
    const version = ++loadVersion;
    const isCurrent = () => version === loadVersion && document.getElementById('stats-grid') === anchor;
    try {
      const [statsResp, serversResp] = await Promise.all([
        API.getStats(),
        API.getServers()
      ]);

      if (!isCurrent()) return;
      document.getElementById('overview-error').classList.add('hidden');
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
      const total = Number(stats.total_servers || 0);
      const percent = total ? Math.min(100, Math.round(online / total * 100)) : null;
      document.getElementById('fleet-percent').textContent = percent === null ? '—' : percent + '%';
      document.getElementById('fleet-ring').setAttribute('stroke-dasharray', `${(percent || 0) * 3.644} 365`);
      document.getElementById('fleet-ring').setAttribute('opacity', percent ? '1' : '0');
      const updated = document.getElementById('overview-updated');
      updated.classList.add('is-current');
      updated.innerHTML = '<span class="tiny-dot"></span>Updated ' + new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
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
        tbody.innerHTML = `<tr><td colspan="6" class="empty-table-cell">${UI.empty('Your fleet starts here', 'Connect your first agent to bring inventory, health and security signals into this workspace.')}<div class="text-center mb-2"><a class="btn" href="#packages">${UI.icon('box')}Get an agent package</a></div></td></tr>`;
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
      if (!isCurrent()) return;
      const error = document.getElementById('overview-error');
      error.textContent = 'Unable to refresh the overview. ' + err.message;
      error.classList.remove('hidden');
      const updated = document.getElementById('overview-updated');
      updated.classList.remove('is-current');
      updated.textContent = 'Snapshot unavailable';
      document.getElementById('recent-servers').innerHTML = '<tr><td colspan="6" class="text-muted">Unable to load current data. Use Refresh to try again.</td></tr>';
    }
  }

  function renderDistribution(targetID, items) {
    const el = document.getElementById(targetID);
    if (!el) return;
    const total = items.reduce((sum, item) => sum + Number(item.value || 0), 0);
    if (!items.length || total === 0) {
      el.innerHTML = UI.empty('Waiting for your first signal', 'Data appears here when your agents report in.', 'pulse');
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
