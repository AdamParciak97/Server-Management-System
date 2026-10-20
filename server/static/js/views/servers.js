'use strict';

Views.Servers = (() => {
  let allServers = [];
  let groups = [];
  let page = 1;
  let pageData = null;
  let savedViews = [];
  let viewsVersion = 0;
  let selectedView = '';
  let savingView = false;
  let mounted = null;
  let reloadVersion = 0;
  let reloadFailed = false;
  let detailVersion = 0;
  let historyById = {};
  let currentHistory = [];
  let currentBaseline = null;
  let currentTimeline = [];
  let activeDetailId = null;
  let detailOpener = null;
  const detailSections = ['identity', 'reports', 'commands', 'timeline'];

  async function render(container) {
    mounted = container;
    page = 1;
    pageData = null;
    savedViews = [];
    selectedView = '';
    savingView = false;
    allServers = [];
    groups = [];
    reloadFailed = true;
    activeDetailId = null;
    detailOpener = null;
    container.innerHTML = `
      <div class="page-header inventory-header">
        <div><span class="eyebrow">INFRASTRUCTURE / INVENTORY</span><h2>Server inventory</h2><p class="page-subtitle">Know your fleet. Follow every host from heartbeat to history.</p></div>
        <div class="page-actions">
          <button id="servers-refresh" class="btn btn-sm" onclick="Views.Servers.reload()">${UI.icon('refresh')} Refresh</button>
          <button class="btn btn-sm" onclick="API.exportCSV()">Export all CSV</button>
          <button class="btn btn-primary" onclick="App.navigate('packages')">${UI.icon('box')} Get agent</button>
        </div>
      </div>
      <div id="inventory-summary" class="inventory-summary" aria-label="Fleet summary"></div>
      <div class="card mb-2 inventory-card">
        <div class="section-heading"><div><h3 class="section-title">Registered hosts</h3><p class="page-subtitle">Search, narrow down and inspect your infrastructure.</p></div><span id="servers-count" class="text-muted" role="status"></span></div>
        <div class="inventory-workspace">
          <div><span class="eyebrow">YOUR WORKSPACE</span><label for="inventory-view">Saved views<select id="inventory-view"><option value="">Unsaved filters</option></select></label></div>
          <div class="page-actions"><button class="btn btn-sm" id="inventory-save" onclick="Views.Servers.editView(false)">Save as new view</button><button class="btn btn-sm" id="inventory-update" onclick="Views.Servers.editView(true)" disabled>Update view</button><button class="btn btn-sm" id="inventory-delete" onclick="Views.Servers.deleteView()" disabled>Delete view</button></div>
          <p id="inventory-views-message" class="text-muted" role="status">Private to your account · filters always use your current access.</p>
          <button id="inventory-views-retry" class="btn btn-sm" onclick="Views.Servers.loadViews()" hidden>Retry saved views</button>
        </div>
        <div class="filters inventory-filters">
          <label class="inventory-search" for="filter-search">Search hosts<input type="search" id="filter-search" placeholder="Hostname, FQDN or IP address" maxlength="200"></label>
          <label for="filter-status">Status<select id="filter-status">
            <option value="">All statuses</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
            <option value="unknown">Unknown</option>
          </select></label>
          <label for="filter-group">Group<select id="filter-group">
            <option value="">All groups</option>
            <option value="__ungrouped__">No group</option>
          </select></label>
          <label for="filter-os">Operating system<select id="filter-os">
            <option value="">All OS</option>
            <option value="linux">Linux</option>
            <option value="windows">Windows</option>
          </select></label>
          <label for="filter-sort">Sort by<select id="filter-sort"><option value="name">Hostname A–Z</option><option value="seen">Last seen: newest</option><option value="status">Offline first</option></select></label>
        </div>
        <div class="inventory-filter-footer"><span id="servers-filter-note" class="text-muted">All registered hosts</span><button class="btn btn-sm" onclick="Views.Servers.clearFilters()">Clear filters</button></div>
        <div class="table-wrap" tabindex="0" role="region" aria-label="Server inventory table">
          <table id="servers-table">
            <thead><tr>
              <th>Hostname</th><th>IP</th><th>OS</th><th>Group</th>
              <th>Last Seen</th><th>Status</th><th>Actions</th>
            </tr></thead>
            <tbody id="servers-tbody">
              <tr><td colspan="7" class="text-center"><span class="spinner"></span></td></tr>
            </tbody>
          </table>
        </div>
        <div class="inventory-pagination" aria-label="Inventory pagination">
          <label for="inventory-page-size">Rows per page<select id="inventory-page-size"><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></label>
          <span id="inventory-page-note" role="status" aria-live="polite"></span>
          <div class="page-actions"><button id="inventory-prev" class="btn btn-sm" onclick="Views.Servers.changePage(-1)" disabled>Previous</button><button id="inventory-next" class="btn btn-sm" onclick="Views.Servers.changePage(1)" disabled>Next</button></div>
        </div>
      </div>
      <div id="server-detail" class="hidden" tabindex="-1" role="region" aria-label="Server details"></div>
    `;

    setupFilters();
    await Promise.all([reload(), loadViews()]);
  }

  async function reload() {
    const tbody = document.getElementById('servers-tbody');
    if (!tbody) return;
    const version = ++reloadVersion;
    const filters = readFilters();
    const requestedPage = page;
    setPagingBusy(true);
    if (reloadFailed) setFiltersDisabled(true);
    const isCurrent = () => version === reloadVersion &&
      document.getElementById('servers-tbody') === tbody;
    const refresh = document.getElementById('servers-refresh');
    if (refresh) { refresh.disabled = true; refresh.innerHTML = `${UI.icon('refresh')} Refreshing…`; }
    const summary = document.getElementById('inventory-summary');
    if (summary) summary.innerHTML = '<p class="text-muted" role="status">Loading fleet summary…</p>';
    try {
      const [sResp, gResp] = await Promise.all([API.getInventory({...filters, page: requestedPage}), API.listInventoryGroups()]);
      // Only the latest reload for the same mounted view may update its data.
      if (!isCurrent()) return;
      const data = sResp?.data;
      if (!sResp?.success && sResp?.success !== undefined) throw new Error('Invalid inventory response');
      if (!data || !Array.isArray(data.items) || !Number.isInteger(data.total) || data.total < 0 ||
          !Number.isInteger(data.page) || data.page < 1 || data.page_size !== filters.page_size ||
          data.items.length > filters.page_size || !data.summary ||
          !['total', 'online', 'offline', 'unknown'].every(key => Number.isSafeInteger(data.summary[key]) && data.summary[key] >= 0) ||
          data.summary.online + data.summary.offline + data.summary.unknown !== data.summary.total || data.total > data.summary.total) {
        throw new Error('Invalid inventory response');
      }
      pageData = data;
      page = data.page;
      allServers = data.items;
      groups = (gResp && gResp.data) ? gResp.data : [];
      populateGroupFilter();
      reloadFailed = false;
      renderSummary();
      renderFilterNote(filters);
      renderTable(allServers);
      renderPaging();
    } catch (err) {
      if (!isCurrent()) return;
      reloadFailed = true;
      pageData = null;
      setPagingBusy(false);
      const pageNote = document.getElementById('inventory-page-note');
      if (pageNote) pageNote.textContent = 'Page unavailable';
      const count = document.getElementById('servers-count');
      if (count) count.textContent = '';
      if (summary) summary.innerHTML = '<p class="text-muted">Fleet summary unavailable. Refresh to try again.</p>';
      tbody.innerHTML =
        `<tr><td colspan="7"><div class="empty-state" role="alert">${UI.icon('server')}<strong>Inventory could not be loaded</strong><p>${App.escHtml(err.message)}</p><button class="btn" onclick="Views.Servers.reload()">Try again</button></div></td></tr>`;
    } finally {
      if (isCurrent()) {
        setFiltersDisabled(false);
        if (refresh) { refresh.disabled = false; refresh.innerHTML = `${UI.icon('refresh')} Refresh`; }
      }
    }
  }

  function renderSummary() {
    const el = document.getElementById('inventory-summary');
    if (!el) return;
    const counts = pageData.summary;
    el.innerHTML = [
      ['', 'Total hosts', counts.total, 'Within your current access', 'server'],
      ['online', 'Online', counts.online, 'Reported online by API', 'pulse'],
      ['offline', 'Offline', counts.offline, 'Hosts to investigate', 'bell'],
      ['unknown', 'Unknown', counts.unknown, 'Status not established', 'history']
    ].map(([status, label, count, note, icon]) => `<button class="inventory-stat ${status}" data-status="${status}" aria-pressed="false" onclick="Views.Servers.filterStatus('${status}')"><span>${UI.icon(icon)} ${label}</span><strong>${count}</strong><small>${note}</small></button>`).join('');
  }

  function filterStatus(status) {
    const el = document.getElementById('filter-status');
    if (el) { el.value = status; return applyFilters(); }
  }

  function clearFilters() {
    ['filter-search', 'filter-status', 'filter-group', 'filter-os'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    page = 1;
    const loading = reload();
    document.getElementById('filter-search')?.focus?.();
    return loading;
  }

  function populateGroupFilter() {
    const sel = document.getElementById('filter-group');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">All groups</option><option value="__ungrouped__">No group</option>';
    groups.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = g.name;
      sel.appendChild(opt);
    });
    if (cur && cur !== '__ungrouped__' && !groups.some(g => g.id === cur)) {
      const opt = document.createElement('option');
      opt.value = cur; opt.textContent = 'Saved group (unavailable)'; sel.appendChild(opt);
    }
    sel.value = cur;
  }

  function readFilters() {
    const value = name => document.getElementById(`filter-${name}`)?.value || '';
    return {search: value('search').trim(), status: value('status'), group: value('group'), os: value('os'),
      sort: value('sort') || 'name', page_size: Number(document.getElementById('inventory-page-size')?.value || 25)};
  }

  function setupFilters() {
    ['filter-search', 'filter-status', 'filter-group', 'filter-os', 'filter-sort', 'inventory-page-size'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', applyFilters);
    });
    document.getElementById('inventory-view')?.addEventListener('change', applyView);
  }

  function applyFilters() {
    page = 1;
    // Keep a load error visible until explicit retry; never filter a stale page.
    if (reloadFailed) return;
    return reload();
  }

  function renderFilterNote(filters) {
    const active = [filters.search, filters.status, filters.group, filters.os].filter(Boolean).length;
    const note = document.getElementById('servers-filter-note');
    if (note) note.textContent = active ? `${active} active filter${active === 1 ? '' : 's'} · Filtered on server` : 'All registered hosts';
    document.getElementById('inventory-summary')?.querySelectorAll?.('[data-status]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.status === filters.status));
    });
  }

  function setPagingBusy(busy) {
    for (const id of ['inventory-prev', 'inventory-next']) {
      const button = document.getElementById(id);
      if (button && busy) button.disabled = true;
    }
    document.getElementById('servers-table')?.setAttribute('aria-busy', String(busy));
  }

  function setFiltersDisabled(disabled) {
    for (const id of ['filter-search', 'filter-status', 'filter-group', 'filter-os', 'filter-sort', 'inventory-page-size']) {
      const input = document.getElementById(id);
      if (input) input.disabled = disabled;
    }
  }

  function renderPaging() {
    setPagingBusy(false);
    const last = Math.max(1, Math.ceil(pageData.total / pageData.page_size));
    const note = document.getElementById('inventory-page-note');
    if (note) note.textContent = `Page ${page} of ${last} · ${pageData.total} matching hosts`;
    const prev = document.getElementById('inventory-prev'), next = document.getElementById('inventory-next');
    if (prev) prev.disabled = page <= 1;
    if (next) next.disabled = page >= last;
  }

  function changePage(direction) {
    if (reloadFailed || !pageData || document.getElementById('servers-refresh')?.disabled) return;
    const next = page + direction;
    if (next < 1 || next > Math.max(1, Math.ceil(pageData.total / pageData.page_size))) return;
    page = next;
    return reload();
  }

  async function loadViews() {
    const select = document.getElementById('inventory-view');
    if (!select) return;
    const version = ++viewsVersion;
    const current = () => version === viewsVersion && document.getElementById('inventory-view') === select;
    const message = document.getElementById('inventory-views-message');
    const retry = document.getElementById('inventory-views-retry');
    try {
      const response = await API.listInventoryViews();
      if (!current()) return;
      if (!Array.isArray(response?.data) || response.success === false) throw new Error('Invalid saved views response');
      savedViews = response.data;
      if (!savedViews.some(v => v.id === selectedView)) selectedView = '';
      renderViews();
      if (message) message.textContent = `${savedViews.length}/20 private views · current access applies every time`;
      if (retry) retry.hidden = true;
    } catch (err) {
      if (!current()) return;
      if (message) message.textContent = `Saved views unavailable: ${err.message}`;
      if (retry) retry.hidden = false;
    }
  }

  function renderViews() {
    const select = document.getElementById('inventory-view');
    if (!select) return;
    select.innerHTML = '<option value="">Unsaved filters</option>';
    savedViews.forEach(view => {
      const option = document.createElement('option');
      option.value = view.id;
      option.textContent = view.name;
      select.appendChild(option);
    });
    select.value = selectedView;
    for (const id of ['inventory-update', 'inventory-delete']) {
      const button = document.getElementById(id);
      if (button) button.disabled = !selectedView || savingView;
    }
  }

  function applyView() {
    selectedView = document.getElementById('inventory-view')?.value || '';
    const view = savedViews.find(item => item.id === selectedView);
    renderViews();
    if (!view) return;
    for (const key of ['search', 'status', 'group', 'os', 'sort']) {
      const el = document.getElementById(`filter-${key}`);
      if (!el) continue;
      // Preserve an unavailable group as an explicit filter: never silently widen it.
      if (key === 'group' && view.filters[key] && !groups.some(g => g.id === view.filters[key]) && view.filters[key] !== '__ungrouped__') {
        const option = document.createElement('option'); option.value = view.filters[key]; option.textContent = 'Saved group (access may have changed)'; el.appendChild(option);
      }
      el.value = view.filters[key] || '';
    }
    const size = document.getElementById('inventory-page-size');
    if (size) {
      if (![25, 50, 100].includes(view.filters.page_size)) {
        const option = document.createElement('option');
        option.value = String(view.filters.page_size); option.textContent = String(view.filters.page_size); size.appendChild(option);
      }
      size.value = String(view.filters.page_size);
    }
    page = 1;
    return reload();
  }

  function editView(update) {
    if (!mounted || savingView) return;
    const view = update ? savedViews.find(item => item.id === selectedView) : null;
    if (update && !view) return;
    const filters = readFilters();
    const dialog = UI.dialog(mounted, update ? 'Update saved view' : 'Save your workspace', `
      <form id="inventory-view-form"><p class="text-muted">Save filters, sorting and rows per page. This view is private to your account.</p>
      <label for="inventory-view-name">View name<input id="inventory-view-name" required maxlength="80" value="${App.escHtml(view?.name || '')}" placeholder="e.g. Offline production hosts"></label>
      <p class="text-muted">${App.escHtml([filters.search || 'Any hostname', filters.status || 'All statuses', filters.os || 'All systems'].join(' · '))}</p>
      <p id="inventory-save-error" role="alert"></p><button class="btn btn-primary" type="submit">${update ? 'Update view' : 'Save view'}</button></form>`, 'INVENTORY / PRIVATE VIEWS');
    dialog.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault();
      if (savingView) return;
      const name = dialog.querySelector('#inventory-view-name').value.trim();
      if (!name) return;
      savingView = true;
      const button = dialog.querySelector('[type="submit"]'); button.disabled = true;
      const select = document.getElementById('inventory-view');
      try {
        const response = await API.saveInventoryView(view?.id || '', {name, filters});
        if (document.getElementById('inventory-view') !== select || !dialog.isConnected) return;
        if (response?.success !== true || !response.data?.id) throw new Error('The server did not confirm saving the view. Refresh saved views before retrying.');
        selectedView = response.data.id;
        dialog.close();
        await loadViews();
      } catch (err) {
        if (dialog.isConnected) dialog.querySelector('#inventory-save-error').textContent = err.message;
      } finally {
        if (document.getElementById('inventory-view') === select) { savingView = false; renderViews(); }
        if (dialog.isConnected) button.disabled = false;
      }
    });
    dialog.querySelector('#inventory-view-name').focus();
  }

  function deleteView() {
    const view = savedViews.find(item => item.id === selectedView);
    if (!view || savingView || !mounted) return;
    const dialog = UI.dialog(mounted, 'Delete saved view', `<p>Delete <strong>${App.escHtml(view.name)}</strong>? Hosts and current filters are kept.</p><p role="alert" id="inventory-delete-error"></p><button class="btn btn-danger" id="inventory-delete-confirm">Delete view</button>`, 'INVENTORY / PRIVATE VIEWS');
    const button = dialog.querySelector('#inventory-delete-confirm');
    button.addEventListener('click', async () => {
      if (savingView) return;
      savingView = true; button.disabled = true;
      const select = document.getElementById('inventory-view');
      try {
        const response = await API.deleteInventoryView(view.id);
        if (document.getElementById('inventory-view') !== select || !dialog.isConnected) return;
        if (response?.success !== true || response.data?.deleted !== true) throw new Error('The server did not confirm deletion. Refresh saved views before retrying.');
        selectedView = ''; dialog.close(); await loadViews();
      } catch (err) { if (dialog.isConnected) dialog.querySelector('#inventory-delete-error').textContent = err.message; }
      finally {
        if (document.getElementById('inventory-view') === select) { savingView = false; renderViews(); }
        if (dialog.isConnected) button.disabled = false;
      }
    });
  }

  function renderTable(servers) {
    const tbody = document.getElementById('servers-tbody');
    if (!tbody) return;
    const count = document.getElementById('servers-count');
    if (count) count.textContent = `Showing ${(servers || []).length} of ${pageData.summary.total} servers`;
    if (!servers || servers.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-table-cell"><div class="empty-state inventory-empty">${UI.icon(pageData.summary.total ? 'search' : 'server')}<strong>${pageData.summary.total ? 'No servers found' : 'Your inventory starts with one agent'}</strong><p>${pageData.summary.total ? 'No hosts match these filters. Clear them to see your registered fleet.' : 'Hosts appear here after an agent registers with this server. Get an agent package to connect your first host.'}</p><button class="btn btn-primary" onclick="${pageData.summary.total ? 'Views.Servers.clearFilters()' : "App.navigate('packages')"}">${pageData.summary.total ? 'Clear filters' : 'Get agent package'}</button></div></td></tr>`;
      return;
    }
    tbody.innerHTML = servers.map(s => `
      <tr>
        <td><button class="host-link" onclick="Views.Servers.showDetail('${s.id}')">${UI.icon('server')}<span>${App.escHtml(s.hostname)}<small>${App.escHtml(s.fqdn || 'FQDN not reported')}</small></span></button></td>
        <td>${App.escHtml((s.ip_addresses || []).join(', '))}</td>
        <td>${App.escHtml(s.os || '-')}</td>
        <td>${App.escHtml(s.group_name || '-')}</td>
        <td>${App.timeAgo(s.last_seen)}</td>
        <td>${App.statusBadge(s.status)}</td>
        <td>
          <button class="btn btn-sm" aria-label="Inspect ${App.escHtml(s.hostname)}" onclick="Views.Servers.showDetail('${s.id}')">Inspect ${UI.icon('arrow')}</button>
          <button class="btn btn-sm" aria-label="Request report from ${App.escHtml(s.hostname)}" onclick="Views.Servers.forceReport('${s.id}')">${UI.icon('refresh')} Report</button>
        </td>
      </tr>
    `).join('');
  }

  async function showDetail(id) {
    const detailEl = document.getElementById('server-detail');
    if (!detailEl) return;
    const version = ++detailVersion;
    activeDetailId = id;
    if (!detailEl.contains?.(document.activeElement)) detailOpener = document.activeElement;
    const isCurrent = () => version === detailVersion &&
      document.getElementById('server-detail') === detailEl;
    detailEl.classList.remove('hidden');
    detailEl.innerHTML = '<div class="card detail-loading"><span role="status"><span class="spinner"></span> Loading host details…</span><button class="btn" onclick="Views.Servers.closeDetail()">Close</button></div>';
    detailEl.scrollIntoView({ behavior: 'auto', block: 'start' });
    detailEl.focus?.({ preventScroll: true });
    detailEl.onkeydown = event => {
      if (event.key === 'Escape') { event.stopPropagation(); closeDetail(); }
    };

    try {
      const [sResp, hResp, cmdsResp, timelineResp] = await Promise.all([
        API.getServer(id),
        API.getServerHistory(id, 10),
        API.listCommands(id),
        API.getServerTimeline(id, 25)
      ]);
      if (!isCurrent()) return;
      const server = sResp && sResp.data ? sResp.data : {};
      const history = hResp && hResp.data ? hResp.data : [];
      const cmds = cmdsResp && cmdsResp.data ? cmdsResp.data : [];
      const timeline = timelineResp && timelineResp.data ? timelineResp.data : [];
      let baseline = null;
      let baselineFailed = false;
      try {
        const baselineResp = await API.getServerBaseline(id);
        baseline = baselineResp && baselineResp.data ? baselineResp.data : null;
      } catch {
        baselineFailed = true;
      }
      // Publish the matching history and baseline only for the active selection.
      if (!isCurrent()) return;
      currentHistory = history;
      currentTimeline = timeline;
      currentBaseline = baseline;
      historyById = {};
      history.forEach(r => { historyById[r.id] = r; });
      if (currentBaseline && currentBaseline.report) {
        historyById[currentBaseline.report.id] = currentBaseline.report;
      }

      detailEl.innerHTML = `
        <div class="card host-detail-card">
          <div class="page-header host-detail-header">
            <div><span class="eyebrow">HOST WORKSPACE</span><h3>${App.escHtml(server.hostname || 'Unknown')}</h3><p class="page-subtitle">${App.escHtml(server.fqdn || server.os || 'Registered host')}</p></div>
            <div class="page-actions">
              ${App.statusBadge(server.status)}
              <button class="btn btn-sm" onclick="Views.Servers.closeDetail()">Close</button>
            </div>
          </div>
          <div class="host-detail-nav" role="tablist" aria-label="Host sections">
            ${[['identity', 'Overview'], ['reports', `Reports · ${history.length}`], ['commands', `Commands · ${Math.min(cmds.length, 10)}`], ['timeline', `Timeline · ${timeline.length}`]].map(([key, label], index) => `<button class="detail-tab" id="host-tab-${key}" role="tab" aria-selected="${index === 0}" aria-controls="host-panel-${key}" tabindex="${index === 0 ? 0 : -1}" onclick="Views.Servers.selectDetailTab('${key}')" onkeydown="Views.Servers.detailTabKey(event, '${key}')">${label}</button>`).join('')}
          </div>
          <section id="host-panel-identity" role="tabpanel" aria-labelledby="host-tab-identity" tabindex="0">
          <div class="grid-2 mb-2 host-facts">
            <div>
              <p><strong>IP:</strong> ${App.escHtml((server.ip_addresses || []).join(', '))}</p>
              <p><strong>OS:</strong> ${App.escHtml(server.os || '-')} ${App.escHtml(server.os_version || '')}</p>
              <p><strong>Arch:</strong> ${App.escHtml(server.architecture || '-')}</p>
              <p><strong>Agent Version:</strong> ${App.escHtml(server.agent_version || '-')}</p>
            </div>
            <div>
              <p><strong>Group:</strong> ${App.escHtml(server.group_name || '-')}</p>
              <p><strong>Last Seen:</strong> ${App.formatDate(server.last_seen)}</p>
              <p><strong>Registered:</strong> ${App.formatDate(server.registered_at)}</p>
              <p><strong>FQDN:</strong> ${App.escHtml(server.fqdn || '-')}</p>
            </div>
          </div>

          <div class="card mb-2">
            <div class="section-title">Group Assignment</div>
            <div class="form-row">
              <div class="form-group">
                <label for="server-group-select">Group</label>
                <select id="server-group-select">
                  <option value="">No group</option>
                  ${groups.map(group => `
                    <option value="${group.id}" ${server.group_id === group.id ? 'selected' : ''}>${App.escHtml(group.name)}</option>
                  `).join('')}
                </select>
              </div>
            </div>
            <button class="btn btn-sm btn-primary" onclick="Views.Servers.assignGroup('${id}')">Save Group</button>
          </div>
          <div class="host-actions"><button class="btn btn-primary" onclick="Views.Servers.forceReport('${id}')">${UI.icon('refresh')} Request report</button><button class="btn" onclick="Views.Commands.showCreateFor('${id}')">${UI.icon('terminal')} Send command</button><button class="btn" onclick="Views.Servers.selectDetailTab('reports', true)">Explore reports ${UI.icon('arrow')}</button></div>
          </section>
          <section id="host-panel-reports" role="tabpanel" aria-labelledby="host-tab-reports" tabindex="0" hidden>
          <div class="card mb-2">
            <div class="report-card-header">
              <div class="section-title" style="margin-bottom:0">Baseline Drift</div>
              ${currentBaseline ? `<button class="btn btn-sm" onclick="Views.Servers.showBaselineDrift()">View Drift</button>` : ''}
            </div>
            ${currentBaseline ? `
              <div class="report-kv">
                ${renderKV('Baseline Report', App.formatDate(currentBaseline.report ? currentBaseline.report.timestamp : currentBaseline.created_at))}
                ${renderKV('Pinned At', App.formatDate(currentBaseline.created_at))}
              </div>
            ` : baselineFailed ? `<div class="error-msg" role="status">Baseline could not be loaded. <button class="btn btn-sm" onclick="Views.Servers.showDetail('${id}')">Retry details</button></div>` : '<div class="text-muted">No baseline selected for this server yet.</div>'}
            <div class="text-muted mt-1">Pick one report as the gold snapshot, then compare the latest report against it.</div>
          </div>

          <div class="section-title mt-2">Recent Reports (${history.length})</div>
          <div class="card mb-2">
            <div class="section-title">Compare Reports</div>
            <div class="form-row">
              <div class="form-group">
                <label for="compare-report-from">Earlier Report</label>
                <select id="compare-report-from">
                  <option value="">Select report</option>
                  ${history.map(r => `<option value="${r.id}">${App.formatDate(r.timestamp)}</option>`).join('')}
                </select>
              </div>
              <div class="form-group">
                <label for="compare-report-to">Later Report</label>
                <select id="compare-report-to">
                  <option value="">Select report</option>
                  ${history.map(r => `<option value="${r.id}">${App.formatDate(r.timestamp)}</option>`).join('')}
                </select>
              </div>
            </div>
            <button class="btn btn-sm btn-primary" ${history.length < 2 ? 'disabled' : ''} onclick="Views.Servers.compareSelectedReports()">Compare</button>
            ${history.length < 2 ? '<p class="text-muted mt-1">Two reports are needed to compare changes.</p>' : ''}
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Timestamp</th><th>Received</th><th>Actions</th></tr></thead>
              <tbody>
                ${history.length ? history.map(r => `
                  <tr>
                    <td>${App.formatDate(r.timestamp)}</td>
                    <td>${App.formatDate(r.received_at)}</td>
                    <td>
                      <button class="btn btn-sm" onclick="Views.Servers.showReport('${r.id}')">View</button>
                      <button class="btn btn-sm" onclick="Views.Servers.setBaseline('${id}','${r.id}')">Set Baseline</button>
                    </td>
                  </tr>`).join('') : `<tr><td colspan="3"><div class="empty-state">${UI.icon('history')}<strong>No reports yet</strong><p>Reports arrive from the agent. Request a fresh snapshot to inspect this host.</p><button class="btn" onclick="Views.Servers.forceReport('${id}')">Request report</button></div></td></tr>`}
              </tbody>
            </table>
          </div>

          </section>
          <section id="host-panel-commands" role="tabpanel" aria-labelledby="host-tab-commands" tabindex="0" hidden>
          <div class="section-title mt-2">Recent Commands (${Math.min(cmds.length, 10)} shown)</div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Type</th><th>Priority</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>
              <tbody>
                ${cmds.slice(0, 10).map(c => `
                  <tr>
                    <td class="monospace">${App.escHtml(c.type)}</td>
                    <td><span class="${App.priorityClass(c.priority)}">${c.priority}</span></td>
                    <td>${renderCommandStatus(c.status)}</td>
                    <td>${App.timeAgo(c.created_at)}</td>
                    <td><button class="btn btn-sm" onclick="Views.Commands.showLog('${c.id}')">View</button></td>
                  </tr>`).join('') || '<tr><td colspan="5"><div class="empty-state"><strong>No commands yet</strong><p>Requests and execution results for this host will appear here.</p></div></td></tr>'}
              </tbody>
            </table>
          </div>

          <div class="mt-2" style="display:flex;gap:.5rem;flex-wrap:wrap;">
            <button class="btn btn-sm btn-primary" onclick="Views.Servers.forceReport('${id}')">Force Report</button>
            <button class="btn btn-sm" onclick="Views.Commands.showCreateFor('${id}')">Send Command</button>
          </div>

          </section>
          <section id="host-panel-timeline" role="tabpanel" aria-labelledby="host-tab-timeline" tabindex="0" hidden>
          <div class="section-title mt-2">Host Timeline (${timeline.length})</div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Time</th><th>Category</th><th>Status</th><th>Event</th><th>Details</th></tr></thead>
              <tbody>
                ${timeline.length ? timeline.map(item => `
                  <tr>
                    <td>${App.formatDate(item.timestamp)}</td>
                    <td>${renderTimelineCategory(item.category)}</td>
                    <td>${renderTimelineStatus(item.status)}</td>
                    <td>${App.escHtml(item.title || '-')}</td>
                    <td>${App.escHtml(item.message || '-')}</td>
                  </tr>
                `).join('') : '<tr><td colspan="5"><div class="empty-state"><strong>No timeline entries yet</strong><p>Reports, commands and alerts build this host’s activity history.</p></div></td></tr>'}
              </tbody>
            </table>
          </div>
          </section>
        </div>
      `;
      detailEl.querySelectorAll?.('.table-wrap').forEach(el => {
        el.tabIndex = 0;
        el.setAttribute('role', 'region');
        el.setAttribute('aria-label', 'Scrollable host data');
      });
    } catch (err) {
      if (!isCurrent()) return;
      detailEl.innerHTML = `<div class="card"><div class="empty-state" role="alert"><strong>Host details unavailable</strong><p>${App.escHtml(err.message)}</p><div class="host-actions"><button class="btn" onclick="Views.Servers.showDetail('${id}')">Try again</button><button class="btn" onclick="Views.Servers.closeDetail()">Close</button></div></div></div>`;
    }
  }

  function closeDetail() {
    ++detailVersion;
    activeDetailId = null;
    historyById = {};
    currentHistory = [];
    currentBaseline = null;
    currentTimeline = [];
    document.getElementById('server-detail')?.classList.add('hidden');
    if (detailOpener?.isConnected) detailOpener.focus();
  }

  function selectDetailTab(key, focus = false) {
    if (!detailSections.includes(key)) return;
    detailSections.forEach(name => {
      const tab = document.getElementById(`host-tab-${name}`);
      const panel = document.getElementById(`host-panel-${name}`);
      if (!tab || !panel) return;
      tab.setAttribute('aria-selected', String(name === key));
      tab.tabIndex = name === key ? 0 : -1;
      panel.hidden = name !== key;
      if (name === key && focus) tab.focus();
    });
  }

  function detailTabKey(event, key) {
    const index = detailSections.indexOf(key);
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % detailSections.length;
    else if (event.key === 'ArrowLeft') next = (index + detailSections.length - 1) % detailSections.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = detailSections.length - 1;
    else return;
    event.preventDefault();
    selectDetailTab(detailSections[next], true);
  }

  async function forceReport(id) {
    try {
      await API.forceReport(id);
      alert('Force report queued successfully');
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async function assignGroup(id) {
    const select = document.getElementById('server-group-select');
    if (!select) return;
    const version = detailVersion;
    const detailEl = document.getElementById('server-detail');
    try {
      await API.assignGroup(id, select.value);
      if (version !== detailVersion || document.getElementById('server-detail') !== detailEl) return;
      await reload();
      if (version !== detailVersion || activeDetailId !== id || document.getElementById('server-detail') !== detailEl) return;
      const refresh = showDetail(id);
      const refreshVersion = detailVersion;
      await refresh;
      if (refreshVersion !== detailVersion || document.getElementById('server-detail') !== detailEl) return;
      alert('Group updated');
    } catch (err) {
      if (version !== detailVersion || document.getElementById('server-detail') !== detailEl) return;
      alert('Error: ' + err.message);
    }
  }

  async function setBaseline(agentID, reportID) {
    const version = detailVersion;
    const detailEl = document.getElementById('server-detail');
    try {
      await API.setServerBaseline(agentID, reportID);
      if (version !== detailVersion || document.getElementById('server-detail') !== detailEl) return;
      const refresh = showDetail(agentID);
      const refreshVersion = detailVersion;
      await refresh;
      if (refreshVersion !== detailVersion || document.getElementById('server-detail') !== detailEl) return;
      selectDetailTab('reports');
      alert('Baseline updated');
    } catch (err) {
      if (version !== detailVersion || document.getElementById('server-detail') !== detailEl) return;
      alert('Error: ' + err.message);
    }
  }

  function showBaselineDrift() {
    if (!currentBaseline || !currentBaseline.report || !currentHistory.length) {
      alert('Baseline or latest report not available.');
      return;
    }
    const latest = currentHistory[0];
    App.showModal('Baseline Drift', renderReportDiff(currentBaseline.report, latest), null, {
      size: 'wide',
      cancelLabel: 'Close'
    });
  }

  function showReport(reportID) {
    const report = historyById[reportID];
    if (!report) {
      alert('Report not found');
      return;
    }
    App.showModal('Report Dashboard', renderReportDashboard(report), null, {
      size: 'full',
      cancelLabel: 'Close'
    });
  }

  function compareSelectedReports() {
    const fromID = document.getElementById('compare-report-from') ? document.getElementById('compare-report-from').value : '';
    const toID = document.getElementById('compare-report-to') ? document.getElementById('compare-report-to').value : '';
    if (!fromID || !toID || fromID === toID) {
      alert('Select two different reports.');
      return;
    }
    const fromReport = historyById[fromID];
    const toReport = historyById[toID];
    if (!fromReport || !toReport) {
      alert('Report data not found.');
      return;
    }
    App.showModal('Report Diff', renderReportDiff(fromReport, toReport), null, {
      size: 'wide',
      cancelLabel: 'Close'
    });
  }

  function downloadReportPDF(reportID) {
    const report = historyById[reportID];
    if (!report) {
      alert('Report not found');
      return;
    }
    const popup = window.open('', '_blank');
    if (!popup) {
      alert('Popup blocked by the browser.');
      return;
    }
    popup.document.open();
    popup.document.write(buildPrintableReportMarkup(report));
    popup.document.close();
  }

  async function promptEmailReport(reportID) {
    const recipientInput = window.prompt('Recipient email address (comma-separated, leave empty to use SMTP defaults)');
    if (recipientInput === null) return;
    const recipients = recipientInput
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
    try {
      await API.emailReport(reportID, { recipients });
      alert('Report email sent');
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  function renderReportDashboard(report) {
    const system = report.system_info || {};
    const services = normalizeArray(report.services);
    const packages = normalizeArray(report.packages);
    const securityAgents = normalizeArray(report.security_agents);
    const processes = normalizeArray(report.processes);
    const eventLogs = normalizeArray(report.event_logs);
    const scheduledTasks = normalizeArray(report.scheduled_tasks);
    const disks = normalizeArray(system.disks);
    const windowsLicense = system.windows_license || null;
    const windowsSecurity = system.windows_security || null;
    const windowsUpdate = system.windows_update || null;
    const securityPosture = system.security_posture || null;
    const bitlockerVolumes = normalizeArray(securityPosture && securityPosture.bitlocker_volumes);
    const localAdmins = normalizeArray(securityPosture && securityPosture.local_admins);
    const certificates = [...normalizeArray(securityPosture && securityPosture.certificates)].sort(sortCertificates);
    const expiringCertificates = certificates.filter(item => Number(item.days_left) >= 0 && Number(item.days_left) <= 30);
    const remoteAccessItems = buildRemoteAccessItems(securityPosture);
    const bitlockerRisk = hasBitLockerRisk(securityPosture);

    const runningServices = services.filter(s => isServiceRunning(s.status)).length;
    const stoppedServices = services.filter(s => isServiceStopped(s.status)).length;
    const topProcesses = [...processes]
      .sort((a, b) => ((b.cpu_percent || 0) - (a.cpu_percent || 0)) || ((b.memory_bytes || 0) - (a.memory_bytes || 0)))
      .slice(0, 10);
    const installedSecurity = securityAgents.filter(a => isAgentDetected(a.status)).length;
    const packageManagers = summarizePackages(packages);
    const sortedServices = [...services].sort(sortServices);
    const sortedPackages = [...packages].sort(sortPackages);
    const highestDisk = disks.reduce((max, disk) => {
      const usage = Number(disk.usage_percent || 0);
      return usage > max ? usage : max;
    }, 0);
    const healthItems = buildHealthItems(system, services, securityAgents, highestDisk);
    const reportKey = getReportKey(report);

    return `
      <div class="report-dashboard">
        <div class="report-header">
          <div>
            <div><strong>Timestamp:</strong> ${App.formatDate(report.timestamp)}</div>
            <div><strong>Received:</strong> ${App.formatDate(report.received_at)}</div>
          </div>
          <div style="display:flex;gap:.5rem;flex-wrap:wrap;justify-content:flex-end">
            <button class="btn btn-sm" onclick="Views.Servers.downloadReportPDF('${report.id}')">Export PDF</button>
            <button class="btn btn-sm btn-primary" onclick="Views.Servers.promptEmailReport('${report.id}')">Send Email</button>
          </div>
        </div>

        <div class="grid-4">
          ${renderMiniStat('CPU', formatPercent(system.cpu_usage_percent), 'info')}
          ${renderMiniStat('Memory', formatPercent(system.mem_usage_percent), 'warning')}
          ${renderMiniStat('Services', `${runningServices}/${services.length}`, 'online')}
          ${renderMiniStat('Packages', String(packages.length), 'info')}
        </div>

        ${securityPosture ? `
          <div class="grid-4 mt-2">
            ${renderMiniStat('BitLocker', bitlockerRisk ? 'Risk' : 'OK', bitlockerRisk ? 'offline' : 'online')}
            ${renderMiniStat('Remote Access', remoteAccessItems.some(item => item.enabled) ? `${remoteAccessItems.filter(item => item.enabled).length} enabled` : 'Disabled', remoteAccessItems.some(item => item.enabled) ? 'warning' : 'online')}
            ${renderMiniStat('Local Admins', String(localAdmins.length), localAdmins.length > 2 ? 'warning' : 'info')}
            ${renderMiniStat('Expiring Certs', String(expiringCertificates.length), expiringCertificates.length ? 'warning' : 'online')}
          </div>
        ` : ''}

        <div class="grid-2 mt-2">
          <div class="card">
            <div class="section-title">System</div>
            <div class="report-kv">
              ${renderKV('Hostname', system.hostname)}
              ${renderKV('FQDN', system.fqdn)}
              ${renderKV('OS', joinParts([system.os, system.os_version]))}
              ${renderKV('Architecture', system.architecture)}
              ${renderKV('Kernel', system.kernel_version)}
              ${renderKV('IPs', normalizeArray(system.ips).join(', '))}
              ${renderKV('Boot Time', system.boot_time ? App.formatDate(system.boot_time) : '')}
              ${renderKV('Uptime', formatUptime(system.uptime_seconds))}
              ${renderKV('Memory', `${formatBytes(system.mem_used_bytes)} / ${formatBytes(system.mem_total_bytes)}`)}
            </div>
            ${windowsLicense ? `
              <div class="section-title mt-2">Windows License</div>
              <div class="report-kv">
                ${renderKV('Status', windowsLicense.license_status)}
                ${renderKV('Channel', windowsLicense.channel)}
                ${renderKV('Product', windowsLicense.product_name)}
                ${renderKV('Key suffix', windowsLicense.partial_product_key)}
                ${renderKV('KMS Host', joinParts([windowsLicense.kms_machine, windowsLicense.kms_port ? ':' + windowsLicense.kms_port : '']))}
              </div>
            ` : ''}
            ${windowsSecurity ? `
              <div class="section-title mt-2">Windows Security</div>
              <div class="report-kv">
                ${renderKV('Defender Enabled', windowsSecurity.defender_enabled ? 'Yes' : 'No')}
                ${renderKV('Real-Time Protection', windowsSecurity.real_time_enabled ? 'Yes' : 'No')}
                ${renderKV('Signature Version', windowsSecurity.signature_version)}
                ${renderKV('Last Quick Scan', windowsSecurity.last_quick_scan ? App.formatDate(windowsSecurity.last_quick_scan) : '')}
              </div>
            ` : ''}
            ${windowsUpdate ? `
              <div class="section-title mt-2">Windows Update</div>
              <div class="report-kv">
                ${renderKV('Pending Updates', String(windowsUpdate.pending_updates || 0))}
                ${renderKV('Pending Reboot', windowsUpdate.pending_reboot ? 'Yes' : 'No')}
                ${renderKV('Last Installed KB', windowsUpdate.last_installed_kb)}
                ${renderKV('Last Installed At', windowsUpdate.last_installed_at ? App.formatDate(windowsUpdate.last_installed_at) : '')}
              </div>
            ` : ''}
            ${securityPosture ? `
              <div class="section-title mt-2">Security Posture</div>
              <div class="report-kv">
                ${renderKV('BitLocker Volumes', bitlockerVolumes.length ? `${bitlockerVolumes.length}${bitlockerRisk ? ' (attention required)' : ''}` : 'No data')}
                ${renderKV('RDP', securityPosture.rdp_enabled ? 'Enabled' : 'Disabled')}
                ${renderKV('WinRM', securityPosture.winrm_enabled ? 'Enabled' : 'Disabled')}
                ${renderKV('SSH', securityPosture.ssh_enabled ? 'Enabled' : 'Disabled')}
                ${renderKV('Local Admins', String(localAdmins.length))}
                ${renderKV('Certificates', certificates.length ? `${certificates.length} inventoried` : 'No data')}
                ${renderKV('Expiring Certs <= 30d', String(expiringCertificates.length))}
              </div>
            ` : ''}
          </div>

          <div class="card">
            <div class="section-title">Health Summary</div>
            ${renderHealthSummary(healthItems)}
            <div class="report-badge-row mt-1">
              <span class="report-chip">Stopped services: ${stoppedServices}</span>
              <span class="report-chip">Detected security tools: ${installedSecurity}</span>
              <span class="report-chip">Peak disk usage: ${formatPercent(highestDisk)}</span>
            </div>
          </div>
        </div>

        ${securityPosture ? `
          <div class="grid-2 mt-2">
            <div class="card">
              <div class="section-title">Remote Access & Encryption</div>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>Control</th><th>State</th><th>Notes</th></tr></thead>
                  <tbody>
                    ${remoteAccessItems.map(item => `
                      <tr>
                        <td>${App.escHtml(item.label)}</td>
                        <td>${item.enabled ? renderStatusPill('enabled', 'status-warning') : renderStatusPill('disabled', 'status-online')}</td>
                        <td>${App.escHtml(item.note)}</td>
                      </tr>
                    `).join('')}
                    ${bitlockerVolumes.length ? bitlockerVolumes.map(volume => `
                      <tr>
                        <td>${App.escHtml(`BitLocker ${volume.mount_point || '-'}`)}</td>
                        <td>${isBitLockerProtected(volume) ? renderStatusPill('protected', 'status-online') : renderStatusPill('unprotected', 'status-offline')}</td>
                        <td>${App.escHtml(joinParts([volume.protection_status, volume.encryption_method])) || '-'}</td>
                      </tr>
                    `).join('') : `
                      <tr>
                        <td>BitLocker</td>
                        <td>${renderStatusPill('no data', 'status-unknown')}</td>
                        <td>No BitLocker inventory in this report.</td>
                      </tr>
                    `}
                  </tbody>
                </table>
              </div>
            </div>

            <div class="card">
              <div class="section-title">Certificate Posture</div>
              ${certificates.length ? `
                <div class="report-summary">
                  <div class="report-summary-item ${expiringCertificates.length ? 'warn' : 'ok'}">
                    <span>Expiring &lt;= 30d</span>
                    <strong>${expiringCertificates.length}</strong>
                  </div>
                  <div class="report-summary-item">
                    <span>Total Certificates</span>
                    <strong>${certificates.length}</strong>
                  </div>
                  <div class="report-summary-item">
                    <span>Earliest Expiry</span>
                    <strong>${App.escHtml(formatDaysLeft(certificates[0] && certificates[0].days_left))}</strong>
                  </div>
                </div>
              ` : `<div class="text-muted">No certificate inventory in this report.</div>`}
              ${expiringCertificates.length ? `
                <div class="table-wrap mt-1">
                  <table>
                    <thead><tr><th>Subject</th><th>Store</th><th>Expires</th><th>Days Left</th></tr></thead>
                    <tbody>
                      ${expiringCertificates.slice(0, 10).map(cert => `
                        <tr>
                          <td>${App.escHtml(cert.subject || '-')}</td>
                          <td>${App.escHtml(cert.store || '-')}</td>
                          <td>${cert.not_after ? App.formatDate(cert.not_after) : '-'}</td>
                          <td>${App.escHtml(formatDaysLeft(cert.days_left))}</td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>
              ` : ''}
            </div>
          </div>
        ` : ''}

        <div class="grid-2 mt-2">
          <div class="card">
            <div class="section-title">Security Agents</div>
            ${securityAgents.length ? `
              <div class="table-wrap">
                <table>
                  <thead><tr><th>Name</th><th>Version</th><th>Status</th><th>Service</th></tr></thead>
                  <tbody>
                    ${securityAgents.map(agent => `
                      <tr>
                        <td>${App.escHtml(agent.name || '-')}</td>
                        <td>${App.escHtml(agent.version || '-')}</td>
                        <td>${renderAgentStatus(agent.status)}</td>
                        <td>${App.escHtml(agent.service_name || '-')}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            ` : `<div class="text-muted">No security agent data in this report.</div>`}
            <div class="report-footnote mt-1">Installed or detected: ${installedSecurity}</div>
          </div>

          <div class="card">
            <div class="section-title">Package Sources</div>
            ${packageManagers.length ? `
              <div class="report-summary">
                ${packageManagers.map(item => `
                  <div class="report-summary-item">
                    <span>${App.escHtml(item.label)}</span>
                    <strong>${item.count}</strong>
                  </div>
                `).join('')}
              </div>
            ` : `<div class="text-muted">No package inventory in this report.</div>`}
          </div>
        </div>

        <div class="card mt-2">
          <div class="section-title">Disks</div>
          ${disks.length ? `
            <div class="table-wrap">
              <table>
                <thead><tr><th>Mount</th><th>Device</th><th>FS</th><th>Used</th><th>Usage</th></tr></thead>
                <tbody>
                  ${disks.map(disk => `
                    <tr>
                      <td>${App.escHtml(disk.mount || '-')}</td>
                      <td>${App.escHtml(disk.device || '-')}</td>
                      <td>${App.escHtml(disk.fs_type || '-')}</td>
                      <td>${formatBytes(disk.used_bytes)} / ${formatBytes(disk.total_bytes)}</td>
                      <td>${formatPercent(disk.usage_percent)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          ` : `<div class="text-muted">No disk information in this report.</div>`}
        </div>

        <div class="card mt-2">
          <div class="section-title">Critical Event Log</div>
          ${eventLogs.length ? `
            <div class="table-wrap report-scroll-table">
              <table>
                <thead><tr><th>Time</th><th>Log</th><th>Source</th><th>ID</th><th>Level</th><th>Message</th></tr></thead>
                <tbody>
                  ${eventLogs.map(item => `
                    <tr>
                      <td>${App.formatDate(item.time_created)}</td>
                      <td>${App.escHtml(item.log_name || '-')}</td>
                      <td>${App.escHtml(item.provider || '-')}</td>
                      <td>${App.escHtml(item.event_id || '-')}</td>
                      <td>${renderEventLevel(item.level)}</td>
                      <td>${App.escHtml(item.message || '-')}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          ` : `<div class="text-muted">No critical Event Log entries in this report.</div>`}
        </div>

        ${windowsSecurity && Array.isArray(windowsSecurity.firewall_profiles) ? `
          <div class="card mt-2">
            <div class="section-title">Firewall Profiles</div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Profile</th><th>Enabled</th></tr></thead>
                <tbody>
                  ${windowsSecurity.firewall_profiles.map(profile => `
                    <tr>
                      <td>${App.escHtml(profile.name || '-')}</td>
                      <td>${profile.enabled ? renderStatusPill('enabled', 'status-online') : renderStatusPill('disabled', 'status-offline')}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        ` : ''}

        <div class="grid-2 mt-2">
          ${renderReportCollectionCard({
            reportKey,
            section: 'services',
            title: 'Services',
            items: sortedServices,
            topCount: 20,
            emptyText: 'No services in this report.',
            footnote: services.length > 20 ? `All services available in the "All" tab (${services.length} total).` : '',
            columns: ['Name', 'Status', 'Start Mode', 'PID'],
            renderRow: service => `
              <tr>
                <td>${App.escHtml(service.display_name || service.name || '-')}</td>
                <td>${renderServiceStatus(service.status)}</td>
                <td>${App.escHtml(service.start_mode || '-')}</td>
                <td>${service.pid || '-'}</td>
              </tr>
            `
          })}

          <div class="card">
            <div class="section-title">Top Processes</div>
            ${topProcesses.length ? `
              <div class="table-wrap">
                <table>
                  <thead><tr><th>Name</th><th>CPU</th><th>Memory</th><th>User</th></tr></thead>
                  <tbody>
                    ${topProcesses.map(proc => `
                      <tr>
                        <td>${App.escHtml(proc.name || '-')}</td>
                        <td>${formatPercent(proc.cpu_percent)}</td>
                        <td>${formatBytes(proc.memory_bytes)}</td>
                        <td>${App.escHtml(proc.user || '-')}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            ` : `<div class="text-muted">No process list in this report.</div>`}
          </div>
        </div>

        ${renderReportCollectionCard({
          reportKey,
          section: 'packages',
          title: 'Packages',
          items: sortedPackages,
          topCount: 20,
          emptyText: 'No package inventory in this report.',
          footnote: packages.length > 20 ? `Full inventory available in the "All" tab (${packages.length} total).` : '',
          columns: ['Name', 'Version', 'Manager', 'Arch'],
          renderRow: pkg => `
            <tr>
              <td>${App.escHtml(pkg.name || '-')}</td>
              <td>${App.escHtml(pkg.version || '-')}</td>
              <td>${App.escHtml(pkg.manager || '-')}</td>
              <td>${App.escHtml(pkg.architecture || '-')}</td>
            </tr>
          `
        })}

        ${renderReportCollectionCard({
          reportKey,
          section: 'local-admins',
          title: 'Local Administrators',
          items: localAdmins.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')),
          topCount: 20,
          emptyText: 'No local administrator inventory in this report.',
          footnote: localAdmins.length > 20 ? `Full local administrator inventory available in the "All" tab (${localAdmins.length} total).` : '',
          columns: ['Name', 'Class', 'Source'],
          renderRow: item => `
            <tr>
              <td>${App.escHtml(item.name || '-')}</td>
              <td>${App.escHtml(item.object_class || '-')}</td>
              <td>${App.escHtml(item.source || '-')}</td>
            </tr>
          `
        })}

        ${renderReportCollectionCard({
          reportKey,
          section: 'certificates',
          title: 'Certificates',
          items: certificates,
          topCount: 20,
          emptyText: 'No certificate inventory in this report.',
          footnote: certificates.length > 20 ? `Full certificate inventory available in the "All" tab (${certificates.length} total).` : '',
          columns: ['Subject', 'Store', 'Issuer', 'Expires', 'Days Left'],
          renderRow: cert => `
            <tr>
              <td>${App.escHtml(cert.subject || '-')}</td>
              <td>${App.escHtml(cert.store || '-')}</td>
              <td>${App.escHtml(cert.issuer || '-')}</td>
              <td>${cert.not_after ? App.formatDate(cert.not_after) : '-'}</td>
              <td>${App.escHtml(formatDaysLeft(cert.days_left))}</td>
            </tr>
          `
        })}

        ${renderReportCollectionCard({
          reportKey,
          section: 'tasks',
          title: 'Scheduled Tasks',
          items: scheduledTasks.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')),
          topCount: 20,
          emptyText: 'No scheduled tasks in this report.',
          footnote: scheduledTasks.length > 20 ? `Full scheduled task inventory available in the "All" tab (${scheduledTasks.length} total).` : '',
          columns: ['Name', 'State', 'Schedule', 'Command'],
          renderRow: task => `
            <tr>
              <td>${App.escHtml(task.path ? `${task.path}${task.name}` : (task.name || '-'))}</td>
              <td>${App.escHtml(task.state || '-')}</td>
              <td>${App.escHtml(task.schedule || '-')}</td>
              <td>${App.escHtml(task.command || '-')}</td>
            </tr>
          `
        })}
      </div>
    `;
  }

  function renderReportDiff(fromReport, toReport) {
    const systemBefore = fromReport.system_info || {};
    const systemAfter = toReport.system_info || {};
    const servicesDiff = diffByKey(normalizeArray(fromReport.services), normalizeArray(toReport.services), item => item.name || item.display_name || '');
    const packagesDiff = diffByKey(normalizeArray(fromReport.packages), normalizeArray(toReport.packages), item => `${item.name || ''}:${item.version || ''}`);
    const securityDiff = diffByKey(normalizeArray(fromReport.security_agents), normalizeArray(toReport.security_agents), item => item.name || '');
    const processDiff = diffByKey(normalizeArray(fromReport.processes), normalizeArray(toReport.processes), item => `${item.pid || ''}:${item.name || ''}`);
    const taskDiff = diffByKey(normalizeArray(fromReport.scheduled_tasks), normalizeArray(toReport.scheduled_tasks), item => `${item.path || ''}:${item.name || ''}`);
    const systemChanges = diffSystem(systemBefore, systemAfter);

    return `
      <div class="report-dashboard">
        <div class="grid-2">
          <div class="card">
            <div class="section-title">Compared Reports</div>
            <div class="report-kv">
              ${renderKV('Earlier', App.formatDate(fromReport.timestamp))}
              ${renderKV('Later', App.formatDate(toReport.timestamp))}
              ${renderKV('Services Changed', String(servicesDiff.changed.length))}
              ${renderKV('Packages Changed', String(packagesDiff.changed.length + packagesDiff.added.length + packagesDiff.removed.length))}
            </div>
          </div>
          <div class="card">
            <div class="section-title">Change Summary</div>
            <div class="report-summary">
              ${renderDiffSummaryItem('System fields', systemChanges.length)}
              ${renderDiffSummaryItem('Services added/removed/changed', servicesDiff.added.length + servicesDiff.removed.length + servicesDiff.changed.length)}
              ${renderDiffSummaryItem('Packages added/removed', packagesDiff.added.length + packagesDiff.removed.length + packagesDiff.changed.length)}
              ${renderDiffSummaryItem('Security agents changed', securityDiff.added.length + securityDiff.removed.length + securityDiff.changed.length)}
              ${renderDiffSummaryItem('Scheduled tasks changed', taskDiff.added.length + taskDiff.removed.length + taskDiff.changed.length)}
            </div>
          </div>
        </div>

        ${renderDiffTableCard('System Field Changes', systemChanges, ['Field', 'Before', 'After'], change => `
          <tr>
            <td>${App.escHtml(change.field)}</td>
            <td class="diff-remove">${App.escHtml(change.before)}</td>
            <td class="diff-add">${App.escHtml(change.after)}</td>
          </tr>
        `, 'No system-level changes detected.')}

        ${renderDiffBucketsCard('Services', servicesDiff, item => item.name || item.display_name || '-', item => item.status || '-')}
        ${renderDiffBucketsCard('Packages', packagesDiff, item => item.name || '-', item => item.version || '-')}
        ${renderDiffBucketsCard('Security Agents', securityDiff, item => item.name || '-', item => item.status || '-')}
        ${renderDiffBucketsCard('Processes', processDiff, item => item.name || '-', item => item.status || '-')}
        ${renderDiffBucketsCard('Scheduled Tasks', taskDiff, item => item.name || '-', item => `${item.state || '-'} / ${item.schedule || '-'}`)}
      </div>
    `;
  }

  function renderMiniStat(label, value, variant) {
    return `
      <div class="card stat-card ${variant}">
        <div class="stat-value report-stat-value">${App.escHtml(value)}</div>
        <div class="stat-label">${App.escHtml(label)}</div>
      </div>
    `;
  }

  function renderKV(label, value) {
    return `
      <div class="report-kv-row">
        <span class="report-kv-label">${App.escHtml(label)}</span>
        <span class="report-kv-value">${App.escHtml(value || '-')}</span>
      </div>
    `;
  }

  function renderServiceStatus(status) {
    const normalized = (status || 'unknown').toLowerCase();
    if (isServiceRunning(normalized)) return App.statusBadge('online');
    if (isServiceStopped(normalized)) return App.statusBadge('offline');
    return App.statusBadge('unknown');
  }

  function renderAgentStatus(status) {
    const normalized = (status || 'unknown').toLowerCase();
    if (isAgentDetected(normalized)) return App.statusBadge('online');
    if (normalized === 'stopped' || normalized === 'not_installed') return App.statusBadge('offline');
    return `<span class="status status-unknown">${App.escHtml(normalized)}</span>`;
  }

  function renderEventLevel(level) {
    const normalized = (level || 'unknown').toLowerCase();
    if (normalized.includes('critical') || normalized.includes('error')) return renderStatusPill(level, 'status-offline');
    if (normalized.includes('warning')) return renderStatusPill(level, 'status-warning');
    return renderStatusPill(level || 'Info', 'status-unknown');
  }

  function renderHealthSummary(items) {
    return `
      <div class="report-summary">
        ${items.map(item => `
          <div class="report-summary-item ${item.level}">
            <span>${App.escHtml(item.label)}</span>
            <strong>${App.escHtml(item.value)}</strong>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderReportCollectionCard({ reportKey, section, title, items, topCount, emptyText, footnote, columns, renderRow }) {
    const topItems = items.slice(0, topCount);
    const topID = `${reportKey}-${section}-top`;
    const allID = `${reportKey}-${section}-all`;
    return `
      <div class="card mt-2">
        <div class="report-card-header">
          <div class="section-title" style="margin-bottom:0">${App.escHtml(title)}</div>
          ${items.length ? `
            <div class="report-toggle">
              <button class="btn btn-sm is-active" id="${topID}-btn" onclick="Views.Servers.toggleReportCollection('${reportKey}', '${section}', 'top')">Top ${topCount}</button>
              <button class="btn btn-sm" id="${allID}-btn" onclick="Views.Servers.toggleReportCollection('${reportKey}', '${section}', 'all')">All (${items.length})</button>
            </div>
          ` : ''}
        </div>
        ${items.length ? `
          <div id="${topID}">
            ${renderReportTable(topItems, columns, renderRow, false)}
          </div>
          <div id="${allID}" class="hidden">
            ${renderReportTable(items, columns, renderRow, true)}
          </div>
        ` : `<div class="text-muted">${App.escHtml(emptyText)}</div>`}
        ${footnote ? `<div class="report-footnote mt-1">${App.escHtml(footnote)}</div>` : ''}
      </div>
    `;
  }

  function renderReportTable(items, columns, renderRow, scrollable) {
    return `
      <div class="table-wrap${scrollable ? ' report-scroll-table' : ''}">
        <table>
          <thead><tr>${columns.map(column => `<th>${App.escHtml(column)}</th>`).join('')}</tr></thead>
          <tbody>${items.map(renderRow).join('')}</tbody>
        </table>
      </div>
    `;
  }

  function renderDiffSummaryItem(label, count) {
    return `
      <div class="report-summary-item ${count ? 'warn' : 'ok'}">
        <span>${App.escHtml(label)}</span>
        <strong>${count}</strong>
      </div>
    `;
  }

  function renderDiffTableCard(title, items, columns, renderRow, emptyText) {
    return `
      <div class="card mt-2">
        <div class="section-title">${App.escHtml(title)}</div>
        ${items.length ? renderReportTable(items, columns, renderRow, true) : `<div class="text-muted">${App.escHtml(emptyText)}</div>`}
      </div>
    `;
  }

  function renderDiffBucketsCard(title, diff, labelFn, statusFn) {
    const rows = [
      ...diff.added.map(item => ({ bucket: 'Added', before: '-', after: statusFn(item), label: labelFn(item), kind: 'add' })),
      ...diff.removed.map(item => ({ bucket: 'Removed', before: statusFn(item), after: '-', label: labelFn(item), kind: 'remove' })),
      ...diff.changed.map(item => ({ bucket: 'Changed', before: statusFn(item.before), after: statusFn(item.after), label: labelFn(item.after || item.before), kind: 'change' }))
    ];
    return renderDiffTableCard(title, rows, ['Change', 'Item', 'Before', 'After'], row => `
      <tr>
        <td>${App.escHtml(row.bucket)}</td>
        <td>${App.escHtml(row.label)}</td>
        <td class="${row.kind !== 'add' ? 'diff-remove' : ''}">${App.escHtml(row.before)}</td>
        <td class="${row.kind !== 'remove' ? 'diff-add' : ''}">${App.escHtml(row.after)}</td>
      </tr>
    `, `No ${title.toLowerCase()} changes detected.`);
  }

  function diffSystem(before, after) {
    const fields = [
      ['hostname', 'Hostname'],
      ['fqdn', 'FQDN'],
      ['os', 'OS'],
      ['os_version', 'OS Version'],
      ['architecture', 'Architecture'],
      ['kernel_version', 'Kernel'],
      ['cpu_usage_percent', 'CPU Usage'],
      ['mem_usage_percent', 'Memory Usage'],
      ['uptime_seconds', 'Uptime'],
      ['ips', 'IPs']
    ];
    return fields.reduce((changes, [key, label]) => {
      const beforeValue = formatDiffValue(before[key], key);
      const afterValue = formatDiffValue(after[key], key);
      if (beforeValue !== afterValue) {
        changes.push({ field: label, before: beforeValue, after: afterValue });
      }
      return changes;
    }, []);
  }

  function formatDiffValue(value, key) {
    if (Array.isArray(value)) return value.join(', ');
    if (key === 'cpu_usage_percent' || key === 'mem_usage_percent') return formatPercent(value);
    if (key === 'uptime_seconds') return formatUptime(value);
    if (value == null || value === '') return '-';
    return String(value);
  }

  function diffByKey(beforeItems, afterItems, keyFn) {
    const beforeMap = new Map(beforeItems.map(item => [keyFn(item), item]));
    const afterMap = new Map(afterItems.map(item => [keyFn(item), item]));
    const added = [];
    const removed = [];
    const changed = [];

    afterMap.forEach((item, key) => {
      if (!beforeMap.has(key)) {
        added.push(item);
        return;
      }
      const before = beforeMap.get(key);
      if (JSON.stringify(before) !== JSON.stringify(item)) {
        changed.push({ before, after: item });
      }
    });

    beforeMap.forEach((item, key) => {
      if (!afterMap.has(key)) {
        removed.push(item);
      }
    });

    return { added, removed, changed };
  }

  function toggleReportCollection(reportKey, section, mode) {
    const topID = `${reportKey}-${section}-top`;
    const allID = `${reportKey}-${section}-all`;
    const topEl = document.getElementById(topID);
    const allEl = document.getElementById(allID);
    const topBtn = document.getElementById(`${topID}-btn`);
    const allBtn = document.getElementById(`${allID}-btn`);
    if (!topEl || !allEl || !topBtn || !allBtn) return;
    const showAll = mode === 'all';
    topEl.classList.toggle('hidden', showAll);
    allEl.classList.toggle('hidden', !showAll);
    topBtn.classList.toggle('is-active', !showAll);
    allBtn.classList.toggle('is-active', showAll);
  }

  function normalizeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function buildHealthItems(system, services, securityAgents, highestDisk) {
    const cpu = Number(system.cpu_usage_percent || 0);
    const mem = Number(system.mem_usage_percent || 0);
    const securityCount = securityAgents.filter(agent => isAgentDetected(agent.status)).length;
    const posture = system.security_posture || null;
    const certificates = normalizeArray(posture && posture.certificates);
    const expiringCerts = certificates.filter(item => Number(item.days_left) >= 0 && Number(item.days_left) <= 30).length;
    return [
      summarizeHealth('CPU load', cpu, '%', 70, 90),
      summarizeHealth('Memory usage', mem, '%', 75, 90),
      summarizeHealth('Disk pressure', highestDisk, '%', 80, 92),
      {
        label: 'Security tools',
        value: securityCount ? `${securityCount} detected` : 'none detected',
        level: securityCount ? 'ok' : 'warn'
      },
      {
        label: 'Running services',
        value: `${services.filter(service => isServiceRunning(service.status)).length}/${services.length || 0}`,
        level: services.length ? 'ok' : 'warn'
      },
      {
        label: 'Remote access',
        value: posture ? summarizeRemoteAccess(posture) : 'no data',
        level: posture && (posture.rdp_enabled || posture.winrm_enabled || posture.ssh_enabled) ? 'warn' : 'ok'
      },
      {
        label: 'Certificates',
        value: certificates.length ? `${expiringCerts} expiring / ${certificates.length}` : 'no data',
        level: expiringCerts ? 'warn' : 'ok'
      }
    ];
  }

  function summarizeHealth(label, value, suffix, warnAt, critAt) {
    const numeric = Number(value || 0);
    let level = 'ok';
    if (numeric >= critAt) level = 'crit';
    else if (numeric >= warnAt) level = 'warn';
    return {
      label,
      value: formatThresholdValue(numeric, suffix),
      level
    };
  }

  function summarizePackages(packages) {
    const counts = new Map();
    packages.forEach(pkg => {
      const key = (pkg.manager || 'unknown').toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return [...counts.entries()]
      .map(([label, count]) => ({ label: label.toUpperCase(), count }))
      .sort((a, b) => b.count - a.count);
  }

  function isServiceRunning(status) {
    const normalized = (status || '').toLowerCase();
    return normalized === 'running' || normalized === 'active' || normalized === 'started';
  }

  function isServiceStopped(status) {
    const normalized = (status || '').toLowerCase();
    return normalized === 'stopped' || normalized === 'inactive' || normalized === 'failed';
  }

  function isAgentDetected(status) {
    const normalized = (status || '').toLowerCase();
    return normalized === 'running' || normalized === 'installed' || normalized === 'detected' || normalized === 'healthy';
  }

  function renderCommandStatus(status) {
    const normalized = (status || 'unknown').toLowerCase();
    if (normalized === 'success') return renderStatusPill(normalized, 'status-online');
    if (normalized === 'running') return renderStatusPill(normalized, 'status-warning');
    if (normalized === 'error' || normalized === 'timeout' || normalized === 'cancelled') return renderStatusPill(normalized, 'status-offline');
    return renderStatusPill(normalized, 'status-unknown');
  }

  function renderTimelineCategory(category) {
    const normalized = (category || 'unknown').toLowerCase();
    if (normalized === 'report') return renderStatusPill('report', 'status-online');
    if (normalized === 'command') return renderStatusPill('command', 'status-warning');
    if (normalized === 'alert') return renderStatusPill('alert', 'status-offline');
    return renderStatusPill(normalized, 'status-unknown');
  }

  function renderTimelineStatus(status) {
    const normalized = (status || 'unknown').toLowerCase();
    if (normalized === 'success' || normalized === 'resolved') return renderStatusPill(normalized, 'status-online');
    if (normalized === 'active' || normalized === 'pending' || normalized === 'sent' || normalized === 'running' || normalized === 'acknowledged') return renderStatusPill(normalized, 'status-warning');
    if (normalized === 'error' || normalized === 'timeout' || normalized === 'cancelled') return renderStatusPill(normalized, 'status-offline');
    return renderStatusPill(normalized, 'status-unknown');
  }

  function sortServices(a, b) {
    const rank = statusRank(a.status) - statusRank(b.status);
    if (rank !== 0) return rank;
    return (a.display_name || a.name || '').localeCompare(b.display_name || b.name || '');
  }

  function sortPackages(a, b) {
    const nameDiff = (a.name || '').localeCompare(b.name || '');
    if (nameDiff !== 0) return nameDiff;
    return (b.version || '').localeCompare(a.version || '');
  }

  function statusRank(status) {
    if (isServiceStopped(status)) return 0;
    if (isServiceRunning(status)) return 1;
    return 2;
  }

  function formatPercent(value) {
    if (value == null || Number.isNaN(Number(value))) return '-';
    return `${Number(value).toFixed(1)}%`;
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (!value) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unitIndex = 0;
    let current = value;
    while (current >= 1024 && unitIndex < units.length - 1) {
      current /= 1024;
      unitIndex++;
    }
    return `${current.toFixed(current >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
  }

  function formatUptime(seconds) {
    const total = Number(seconds || 0);
    if (!total) return '0m';
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes || parts.length === 0) parts.push(`${minutes}m`);
    return parts.join(' ');
  }

  function joinParts(parts) {
    return parts.filter(Boolean).join(' ');
  }

  function formatThresholdValue(value, suffix) {
    if (!Number.isFinite(value)) return '-';
    return `${value.toFixed(1)}${suffix}`;
  }

  function buildRemoteAccessItems(securityPosture) {
    if (!securityPosture) return [];
    return [
      { label: 'RDP', enabled: !!securityPosture.rdp_enabled, note: securityPosture.rdp_enabled ? 'Remote Desktop connections allowed' : 'Remote Desktop disabled' },
      { label: 'WinRM', enabled: !!securityPosture.winrm_enabled, note: securityPosture.winrm_enabled ? 'Remote PowerShell available' : 'WinRM disabled' },
      { label: 'SSH', enabled: !!securityPosture.ssh_enabled, note: securityPosture.ssh_enabled ? 'SSH service running' : 'SSH disabled or not running' }
    ];
  }

  function summarizeRemoteAccess(securityPosture) {
    return buildRemoteAccessItems(securityPosture)
      .filter(item => item.enabled)
      .map(item => item.label)
      .join(', ') || 'disabled';
  }

  function isBitLockerProtected(volume) {
    const status = String((volume && volume.protection_status) || '').toLowerCase();
    return !!status && !status.includes('off') && !status.includes('unprotected');
  }

  function hasBitLockerRisk(securityPosture) {
    const volumes = normalizeArray(securityPosture && securityPosture.bitlocker_volumes);
    return volumes.some(volume => !isBitLockerProtected(volume));
  }

  function sortCertificates(a, b) {
    const daysDiff = Number(a.days_left || 0) - Number(b.days_left || 0);
    if (daysDiff !== 0) return daysDiff;
    return (a.subject || '').localeCompare(b.subject || '');
  }

  function formatDaysLeft(value) {
    if (value == null || value === '') return '-';
    const numeric = Number(value);
    if (Number.isNaN(numeric)) return String(value);
    if (numeric < 0) return `expired ${Math.abs(numeric)}d ago`;
    return `${numeric}d`;
  }

  function getReportKey(report) {
    const source = report.id || report.timestamp || Date.now();
    return `report-${String(source).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  }

  function buildPrintableReportMarkup(report) {
    const system = report.system_info || {};
    const services = normalizeArray(report.services);
    const packages = normalizeArray(report.packages);
    const securityAgents = normalizeArray(report.security_agents);
    const processes = normalizeArray(report.processes).slice(0, 15);
    const eventLogs = normalizeArray(report.event_logs).slice(0, 20);
    const scheduledTasks = normalizeArray(report.scheduled_tasks).slice(0, 20);
    const disks = normalizeArray(system.disks);
    const license = system.windows_license || null;
    const posture = system.security_posture || null;
    const bitlockerVolumes = normalizeArray(posture && posture.bitlocker_volumes);
    const localAdmins = normalizeArray(posture && posture.local_admins).slice(0, 20);
    const certificates = [...normalizeArray(posture && posture.certificates)].sort(sortCertificates).slice(0, 20);
    const remoteAccessItems = buildRemoteAccessItems(posture);

    return `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>SMS Report</title>
          <style>
            body { font-family: Segoe UI, Arial, sans-serif; margin: 32px; color: #111827; }
            h1, h2, h3 { margin: 0 0 12px; }
            .header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 24px; }
            .muted { color: #6b7280; }
            .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 16px; }
            .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
            .card { border: 1px solid #d1d5db; border-radius: 12px; padding: 16px; break-inside: avoid; }
            .stat { border: 1px solid #dbeafe; background: #eff6ff; border-radius: 10px; padding: 14px; }
            .stat strong { display: block; font-size: 24px; }
            .kv { display: grid; grid-template-columns: 180px 1fr; gap: 8px 12px; }
            table { width: 100%; border-collapse: collapse; margin-top: 8px; }
            th, td { text-align: left; border-bottom: 1px solid #e5e7eb; padding: 8px; font-size: 12px; vertical-align: top; }
            th { background: #f9fafb; }
            .section { margin-bottom: 16px; }
            @media print {
              .print-actions { display: none; }
              body { margin: 12mm; }
            }
          </style>
        </head>
        <body>
          <div class="header">
            <div>
              <h1>SMS Report</h1>
              <div class="muted">Snapshot from ${App.escHtml(App.formatDate(report.timestamp))}</div>
            </div>
            <div class="print-actions">
              <button onclick="window.print()">Print / Save PDF</button>
            </div>
          </div>
          <div class="stats">
            <div class="stat"><span class="muted">CPU</span><strong>${App.escHtml(formatPercent(system.cpu_usage_percent))}</strong></div>
            <div class="stat"><span class="muted">Memory</span><strong>${App.escHtml(formatPercent(system.mem_usage_percent))}</strong></div>
            <div class="stat"><span class="muted">Services</span><strong>${services.length}</strong></div>
            <div class="stat"><span class="muted">Packages</span><strong>${packages.length}</strong></div>
          </div>
          <div class="grid">
            <div class="card">
              <h3>System</h3>
              <div class="kv">
                <div class="muted">Hostname</div><div>${App.escHtml(system.hostname || '-')}</div>
                <div class="muted">FQDN</div><div>${App.escHtml(system.fqdn || '-')}</div>
                <div class="muted">OS</div><div>${App.escHtml(joinParts([system.os, system.os_version]))}</div>
                <div class="muted">IPs</div><div>${App.escHtml(normalizeArray(system.ips).join(', ') || '-')}</div>
                <div class="muted">Boot Time</div><div>${App.escHtml(system.boot_time ? App.formatDate(system.boot_time) : '-')}</div>
                <div class="muted">Uptime</div><div>${App.escHtml(formatUptime(system.uptime_seconds))}</div>
              </div>
            </div>
            <div class="card">
              <h3>Windows License</h3>
              ${license ? `
                <div class="kv">
                  <div class="muted">Status</div><div>${App.escHtml(license.license_status || '-')}</div>
                  <div class="muted">Channel</div><div>${App.escHtml(license.channel || '-')}</div>
                  <div class="muted">Product</div><div>${App.escHtml(license.product_name || '-')}</div>
                  <div class="muted">Key suffix</div><div>${App.escHtml(license.partial_product_key || '-')}</div>
                  <div class="muted">KMS</div><div>${App.escHtml(joinParts([license.kms_machine, license.kms_port ? ':' + license.kms_port : '']) || '-')}</div>
                </div>
              ` : '<div class="muted">No Windows licensing data in this report.</div>'}
            </div>
          </div>
          ${posture ? `
            <div class="card section">
              <h3>Security Posture</h3>
              <div class="kv">
                <div class="muted">BitLocker Volumes</div><div>${App.escHtml(bitlockerVolumes.length ? String(bitlockerVolumes.length) : 'No data')}</div>
                <div class="muted">RDP</div><div>${App.escHtml(posture.rdp_enabled ? 'Enabled' : 'Disabled')}</div>
                <div class="muted">WinRM</div><div>${App.escHtml(posture.winrm_enabled ? 'Enabled' : 'Disabled')}</div>
                <div class="muted">SSH</div><div>${App.escHtml(posture.ssh_enabled ? 'Enabled' : 'Disabled')}</div>
                <div class="muted">Local Admins</div><div>${App.escHtml(String(localAdmins.length))}</div>
                <div class="muted">Certificates</div><div>${App.escHtml(String(certificates.length))}</div>
              </div>
            </div>
          ` : ''}
          <div class="card section">
            <h3>Disks</h3>
            ${renderPrintableTable(
              ['Mount', 'Device', 'FS', 'Used', 'Usage'],
              disks.map(disk => [
                disk.mount || '-',
                disk.device || '-',
                disk.fs_type || '-',
                `${formatBytes(disk.used_bytes)} / ${formatBytes(disk.total_bytes)}`,
                formatPercent(disk.usage_percent)
              ])
            )}
          </div>
          <div class="card section">
            <h3>Top Processes</h3>
            ${renderPrintableTable(
              ['Name', 'CPU', 'Memory', 'User'],
              processes.map(item => [item.name || '-', formatPercent(item.cpu_percent), formatBytes(item.memory_bytes), item.user || '-'])
            )}
          </div>
          <div class="card section">
            <h3>Critical Event Log</h3>
            ${renderPrintableTable(
              ['Time', 'Log', 'Source', 'ID', 'Level', 'Message'],
              eventLogs.map(item => [
                App.formatDate(item.time_created),
                item.log_name || '-',
                item.provider || '-',
                item.event_id || '-',
                item.level || '-',
                item.message || '-'
              ])
            )}
          </div>
          <div class="card section">
            <h3>Security Agents</h3>
            ${renderPrintableTable(
              ['Name', 'Version', 'Status', 'Service'],
              securityAgents.map(item => [item.name || '-', item.version || '-', item.status || '-', item.service_name || '-'])
            )}
          </div>
          ${posture ? `
            <div class="card section">
              <h3>Remote Access & Encryption</h3>
              ${renderPrintableTable(
                ['Control', 'State', 'Notes'],
                [
                  ...remoteAccessItems.map(item => [item.label, item.enabled ? 'Enabled' : 'Disabled', item.note]),
                  ...bitlockerVolumes.map(item => [`BitLocker ${item.mount_point || '-'}`, isBitLockerProtected(item) ? 'Protected' : 'Unprotected', joinParts([item.protection_status, item.encryption_method]) || '-'])
                ]
              )}
            </div>
            <div class="card section">
              <h3>Local Administrators</h3>
              ${renderPrintableTable(
                ['Name', 'Class', 'Source'],
                localAdmins.map(item => [item.name || '-', item.object_class || '-', item.source || '-'])
              )}
            </div>
            <div class="card section">
              <h3>Certificates</h3>
              ${renderPrintableTable(
                ['Subject', 'Store', 'Issuer', 'Expires', 'Days Left'],
                certificates.map(item => [item.subject || '-', item.store || '-', item.issuer || '-', item.not_after ? App.formatDate(item.not_after) : '-', formatDaysLeft(item.days_left)])
              )}
            </div>
          ` : ''}
          <div class="card section">
            <h3>Scheduled Tasks</h3>
            ${renderPrintableTable(
              ['Name', 'State', 'Schedule', 'Command'],
              scheduledTasks.map(item => [item.name || '-', item.state || '-', item.schedule || '-', item.command || '-'])
            )}
          </div>
          <div class="card section">
            <h3>Top 20 Services</h3>
            ${renderPrintableTable(
              ['Name', 'Status', 'Start Mode', 'PID'],
              [...services].sort(sortServices).slice(0, 20).map(item => [item.display_name || item.name || '-', item.status || '-', item.start_mode || '-', item.pid || '-'])
            )}
          </div>
          <div class="card section">
            <h3>Top 20 Packages</h3>
            ${renderPrintableTable(
              ['Name', 'Version', 'Manager', 'Arch'],
              [...packages].sort(sortPackages).slice(0, 20).map(item => [item.name || '-', item.version || '-', item.manager || '-', item.architecture || '-'])
            )}
          </div>
          <script>setTimeout(() => window.print(), 300);</script>
        </body>
      </html>
    `;
  }

  function renderPrintableTable(headers, rows) {
    if (!rows.length) return '<div class="muted">No data available.</div>';
    return `
      <table>
        <thead><tr>${headers.map(item => `<th>${App.escHtml(item)}</th>`).join('')}</tr></thead>
        <tbody>
          ${rows.map(row => `<tr>${row.map(value => `<td>${App.escHtml(value == null ? '-' : value)}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
    `;
  }

  function renderStatusPill(label, className) {
    return `<span class="status ${className}">${App.escHtml(label)}</span>`;
  }

  return { render, reload, loadViews, applyView, editView, deleteView, changePage, showDetail, closeDetail, selectDetailTab, detailTabKey, clearFilters, filterStatus, forceReport, showReport, compareSelectedReports, toggleReportCollection, assignGroup, downloadReportPDF, promptEmailReport, setBaseline, showBaselineDrift };
})();
