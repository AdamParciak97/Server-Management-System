'use strict';

Views.Packages = (() => {
  async function render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2>Packages</h2>
        <div class="page-actions">
          <button class="btn btn-primary" onclick="Views.Packages.showUpload()">&#8679; Upload Package</button>
          <button class="btn btn-sm" onclick="Views.Packages.reload()">&#8635; Refresh</button>
        </div>
      </div>
      <div id="upload-form" class="card mb-2 hidden">
        <div class="section-title">Upload Package</div>
        <form id="pkg-upload-form">
          <div class="form-row">
            <div class="form-group"><label>Name</label><input type="text" id="pkg-name" placeholder="elastic-agent" required></div>
            <div class="form-group"><label>Version</label><input type="text" id="pkg-version" placeholder="8.0.0" required></div>
          </div>
          <div class="form-row">
            <div class="form-group"><label>OS Target</label>
              <select id="pkg-os"><option value="">All</option><option value="linux">Linux</option><option value="windows">Windows</option></select>
            </div>
            <div class="form-group"><label>Arch Target</label>
              <select id="pkg-arch"><option value="">All</option><option value="amd64">amd64</option><option value="arm64">arm64</option></select>
            </div>
          </div>
          <div class="form-group mb-1"><label>Description</label><input type="text" id="pkg-desc"></div>
          <div class="form-group mb-2"><label>File</label><input type="file" id="pkg-file" required style="padding:.4rem;height:auto"></div>
          <div style="display:flex;gap:.5rem">
            <button type="submit" class="btn btn-primary">Upload</button>
            <button type="button" class="btn" onclick="document.getElementById('upload-form').classList.add('hidden')">Cancel</button>
          </div>
          <div id="upload-status" class="hidden mt-1"></div>
        </form>
      </div>
      <div class="card">
        <div class="section-title">Available Packages</div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Name</th><th>Version</th><th>OS</th><th>Arch</th><th>Size</th><th>SHA256</th><th>Uploaded</th><th>Actions</th>
            </tr></thead>
            <tbody id="packages-tbody">
              <tr><td colspan="8" class="text-center"><span class="spinner"></span></td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    document.getElementById('pkg-upload-form').addEventListener('submit', uploadPackage);
    await reload();
  }

  async function reload() {
    try {
      const resp = await API.listPackages();
      const pkgs = (resp && resp.data) ? resp.data : [];
      const tbody = document.getElementById('packages-tbody');
      if (!tbody) return;
      if (!pkgs.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted" style="padding:2rem">No packages uploaded yet</td></tr>';
        return;
      }
      tbody.innerHTML = pkgs.map(p => `
        <tr>
          <td>${App.escHtml(p.name)}</td>
          <td>${App.escHtml(p.version)}</td>
          <td>${App.escHtml(p.os_target || 'all')}</td>
          <td>${App.escHtml(p.arch_target || 'all')}</td>
          <td>${formatSize(p.file_size)}</td>
          <td class="monospace text-muted" style="font-size:.75rem">${p.sha256.slice(0,12)}...</td>
          <td>${App.timeAgo(p.created_at)}</td>
          <td style="display:flex;gap:.4rem;flex-wrap:wrap">
            <a href="/api/packages/${p.id}/download" class="btn btn-sm">&#8659; Download</a>
            <button class="btn btn-sm btn-danger" onclick="Views.Packages.deletePackage('${p.id}', '${App.escHtml(p.name)}', '${App.escHtml(p.version)}')">Delete</button>
          </td>
        </tr>
      `).join('');
    } catch (err) {
      const tbody = document.getElementById('packages-tbody');
      if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="error-msg">${App.escHtml(err.message)}</td></tr>`;
    }
  }

  function showUpload() {
    document.getElementById('upload-form').classList.toggle('hidden');
  }

  async function uploadPackage(e) {
    e.preventDefault();
    const statusEl = document.getElementById('upload-status');
    statusEl.className = 'mt-1';
    statusEl.textContent = 'Uploading...';
    statusEl.classList.remove('hidden');

    const form = new FormData();
    form.append('name', document.getElementById('pkg-name').value);
    form.append('version', document.getElementById('pkg-version').value);
    form.append('os_target', document.getElementById('pkg-os').value);
    form.append('arch_target', document.getElementById('pkg-arch').value);
    form.append('description', document.getElementById('pkg-desc').value);
    const file = document.getElementById('pkg-file').files[0];
    if (!file) return;
    form.append('file', file);

    try {
      await API.uploadPackage(form);
      statusEl.style.color = '#22c55e';
      statusEl.textContent = 'Upload successful!';
      document.getElementById('upload-form').classList.add('hidden');
      await reload();
    } catch (err) {
      statusEl.style.color = '#ef4444';
      statusEl.textContent = 'Error: ' + err.message;
    }
  }

  async function deletePackage(id, name, version) {
    if (!confirm(`Delete package ${name} ${version}?`)) return;
    try {
      await API.deletePackage(id);
      await reload();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  function formatSize(bytes) {
    if (!bytes) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  return { render, reload, showUpload, deletePackage };
})();
