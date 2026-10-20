'use strict';

Views.Packages = (() => {
  const MAX_FILE = 500 * 1024 * 1024;
  const labelPattern = /^[A-Za-z0-9][A-Za-z0-9._+\-]{0,127}$/;
  const filenamePattern = /^[A-Za-z0-9][A-Za-z0-9._+() \-]{0,179}$/;
  let generation = 0, request = 0, packages = [], loaded = false, uploading = false;
  let deleting = new Set();
  const node = id => document.getElementById(id);
  const esc = value => App.escHtml(String(value ?? '')).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const can = permission => {
    const user = API.getUser();
    return user?.role === 'admin' || user?.permissions?.includes(permission);
  };
  const active = (version, anchor) => generation === version && anchor && node('packages-workspace') === anchor;

  async function render(container) {
    generation++; request++; packages = []; loaded = false; uploading = false; deleting = new Set();
    if (!can('packages.read')) {
      container.innerHTML = UI.empty('Package library unavailable', 'Your account needs packages.read to open this library.', 'box');
      return;
    }
    container.innerHTML = `<section id="packages-workspace" class="packages-workspace">
      <div class="page-header"><div><span class="eyebrow">DISTRIBUTION / PACKAGE LIBRARY</span><h2>Packages</h2><p class="page-subtitle">Versioned files for your managed fleet. Choose a target, inspect the checksum, then download.</p></div>
        <div class="page-actions">${can('packages.write') ? '<button id="packages-upload-toggle" class="btn btn-primary" aria-expanded="false" aria-controls="upload-form" onclick="Views.Packages.showUpload()">Upload package</button>' : '<span class="integration-status">Read-only library</span>'}<button id="packages-refresh" class="btn" onclick="Views.Packages.reload()">${UI.icon('refresh')} Refresh</button></div></div>
      <div class="packages-intro card"><div class="packages-intro-icon">${UI.icon('box')}</div><div><span class="eyebrow">READY FOR DISTRIBUTION</span><h3>One library. Clear targets.</h3><p>Uploaded packages are available through public download links for agent installation. Upload distributable files without credentials or private configuration. A checksum identifies the stored file; it does not verify its publisher.</p></div><div class="packages-capacity"><strong>500 MiB</strong><span>maximum per file</span></div></div>
      <div id="packages-feedback" class="integration-feedback" role="status" aria-live="polite"></div>
      ${can('packages.write') ? `<section id="upload-form" class="card packages-upload" hidden aria-labelledby="upload-title">
        <div class="section-heading"><div><span class="eyebrow">NEW RELEASE</span><h3 id="upload-title">Upload a package</h3></div><span class="text-muted">SHA-256 calculated on upload</span></div>
        <form id="pkg-upload-form"><fieldset id="pkg-fields"><div class="integration-fields">
          <div><label for="pkg-name">Package name</label><input id="pkg-name" required maxlength="128" placeholder="sms-agent" aria-describedby="pkg-label-help"></div>
          <div><label for="pkg-version">Version</label><input id="pkg-version" required maxlength="128" placeholder="1.0.0" aria-describedby="pkg-label-help"></div>
          <div><label for="pkg-os">Operating system</label><select id="pkg-os"><option value="">All systems</option><option value="linux">Linux</option><option value="windows">Windows</option></select></div>
          <div><label for="pkg-arch">Architecture</label><select id="pkg-arch"><option value="">All architectures</option><option value="amd64">amd64</option><option value="arm64">arm64</option></select></div>
        </div><p id="pkg-label-help" class="text-muted">Name and version: letters, digits, dots, underscores, plus or minus. Start with a letter or digit.</p>
        <label for="pkg-desc">Description <span class="text-muted">(optional)</span></label><textarea id="pkg-desc" rows="2" maxlength="4096" placeholder="What this release contains"></textarea>
        <div class="packages-file"><label for="pkg-file">Package file</label><input id="pkg-file" type="file" required aria-describedby="pkg-file-help"><p id="pkg-file-help">One non-empty file, up to 500 MiB. Use an ASCII filename starting with a letter or digit.</p><strong id="pkg-file-preview">No file selected</strong></div>
        <div class="page-actions"><button id="pkg-submit" type="submit" class="btn btn-primary">Upload package</button><button type="button" class="btn" onclick="Views.Packages.showUpload(false)">Close</button></div></fieldset>
        <div id="upload-status" class="integration-feedback" role="status" aria-live="polite"></div></form></section>` : ''}
      <section class="card packages-library" aria-labelledby="packages-list-title"><div class="section-heading"><div><span class="eyebrow">AVAILABLE RELEASES</span><h3 id="packages-list-title">Package library</h3></div><span id="packages-summary" role="status">Loading library…</span></div>
        <div class="packages-filters"><div><label for="packages-search">Find a release</label><input id="packages-search" type="search" placeholder="Name, version or description"></div><div><label for="packages-os">Operating system</label><select id="packages-os"><option value="">Any system</option><option value="linux">Linux + universal</option><option value="windows">Windows + universal</option></select></div><div><label for="packages-arch">Architecture</label><select id="packages-arch"><option value="">Any architecture</option><option value="amd64">amd64 + universal</option><option value="arm64">arm64 + universal</option></select></div></div>
        <div class="table-wrap" tabindex="0" role="region" aria-label="Package releases"><table><thead><tr><th>Package / version</th><th>Target</th><th>Size</th><th>Integrity</th><th>Uploaded</th><th>Actions</th></tr></thead><tbody id="packages-tbody"><tr><td colspan="6">Loading packages…</td></tr></tbody></table></div>
      </section><aside class="packages-onboarding card"><span class="eyebrow">FIRST AGENT</span><h3>From package to inventory</h3><ol><li>Choose the package for the host operating system and architecture.</li><li>Use <strong>Settings → Registration Tokens</strong> to prepare agent registration with the correct group.</li><li>Follow the installation instructions for your environment. After the agent reports, its inventory appears in <a href="#servers">Servers</a>.</li></ol><p class="text-muted">Uploading a package does not install or run it on any host.</p></aside>
    </section>`;
    node('pkg-upload-form')?.addEventListener('submit', uploadPackage);
    node('pkg-file')?.addEventListener('change', previewFile);
    ['packages-search', 'packages-os', 'packages-arch'].forEach(id => node(id).addEventListener('input', draw));
    node('packages-tbody').addEventListener('click', event => {
      const button = event.target.closest('[data-package-delete]');
      if (button) deletePackage(button.dataset.packageDelete);
    });
    await reload();
  }

  async function reload() {
    const version = generation, anchor = node('packages-workspace'), sequence = ++request;
    if (!anchor || !can('packages.read')) return;
    loaded = false;
    node('packages-refresh').disabled = true;
    node('packages-summary').textContent = 'Loading library…';
    node('packages-tbody').innerHTML = '<tr><td colspan="6" class="text-muted">Loading packages…</td></tr>';
    try {
      const response = await API.listPackages();
      if (!active(version, anchor) || sequence !== request) return;
      if (response?.data != null && !Array.isArray(response.data)) throw new Error('Invalid package list');
      packages = response?.data || []; loaded = true; draw();
    } catch (error) {
      if (!active(version, anchor) || sequence !== request) return;
      packages = []; node('packages-summary').textContent = 'Library unavailable';
      node('packages-tbody').innerHTML = `<tr><td colspan="6">${UI.empty('Could not load packages', 'Refresh the library to try again. No package data is available.', 'box')}<button class="btn" onclick="Views.Packages.reload()">Retry</button></td></tr>`;
    } finally {
      if (active(version, anchor) && sequence === request) node('packages-refresh').disabled = false;
    }
  }

  function draw() {
    if (!loaded || !node('packages-workspace')) return;
    const query = node('packages-search').value.trim().toLowerCase(), os = node('packages-os').value, arch = node('packages-arch').value;
    const items = packages.filter(p => (!query || `${p.name} ${p.version} ${p.description || ''}`.toLowerCase().includes(query)) && (!os || !p.os_target || p.os_target === os) && (!arch || !p.arch_target || p.arch_target === arch));
    node('packages-summary').textContent = `${items.length} of ${packages.length} releases · ${formatSize(packages.reduce((n, p) => n + Math.max(0, Number(p.file_size) || 0), 0))} stored`;
    if (!items.length) {
      node('packages-tbody').innerHTML = `<tr><td colspan="6">${UI.empty(packages.length ? 'No matching releases' : 'Your package library starts here', packages.length ? 'Adjust your filters to find another release.' : 'Upload a distributable package to make it available for download.', 'box')}${packages.length ? '<button class="btn" onclick="Views.Packages.resetFilters()">Reset filters</button>' : can('packages.write') ? '<button class="btn btn-primary" onclick="Views.Packages.showUpload(true)">Upload first package</button>' : '<p class="text-muted">Ask an administrator to upload a package.</p>'}</td></tr>`;
      return;
    }
    node('packages-tbody').innerHTML = items.map(p => `<tr>
      <td><strong>${esc(p.name)}</strong><span class="packages-version">${esc(p.version)}</span>${p.description ? `<p class="packages-description">${esc(p.description)}</p>` : ''}</td>
      <td><span class="integration-status">${esc(p.os_target || 'All systems')}</span><small class="packages-platform">${esc(p.arch_target || 'All architectures')}</small></td>
      <td>${formatSize(p.file_size)}</td><td><details class="packages-hash"><summary>SHA-256</summary><code>${esc(p.sha256 || 'Not available')}</code></details></td><td>${esc(App.timeAgo(p.created_at))}</td>
      <td><div class="page-actions"><a class="btn btn-sm" href="/api/packages/public/${esc(encodeURIComponent(p.id))}" download aria-label="Download ${esc(p.name)} ${esc(p.version)}">Download</a>${can('packages.write') ? `<button class="btn btn-sm btn-danger" data-package-delete="${esc(p.id)}" ${deleting.has(p.id) ? 'disabled' : ''} aria-label="Delete ${esc(p.name)} ${esc(p.version)}">${deleting.has(p.id) ? 'Deleting…' : 'Delete'}</button>` : ''}</div></td></tr>`).join('');
  }

  function resetFilters() {
    ['packages-search', 'packages-os', 'packages-arch'].forEach(id => { node(id).value = ''; }); draw(); node('packages-search').focus();
  }
  function showUpload(open) {
    const form = node('upload-form');
    if (!form || uploading || !can('packages.write')) return;
    form.hidden = typeof open === 'boolean' ? !open : !form.hidden;
    node('packages-upload-toggle').setAttribute('aria-expanded', String(!form.hidden));
    if (!form.hidden) node('pkg-name').focus(); else node('packages-upload-toggle').focus();
  }
  function previewFile() {
    const file = node('pkg-file').files[0];
    node('pkg-file-preview').textContent = file ? `${file.name} · ${formatSize(file.size)}` : 'No file selected';
  }
  async function uploadPackage(event) {
    event.preventDefault();
    if (uploading || !can('packages.write') || !node('pkg-upload-form')) return;
    const version = generation, anchor = node('packages-workspace'), status = node('upload-status');
    const file = node('pkg-file').files[0], name = node('pkg-name').value.trim(), release = node('pkg-version').value.trim();
    status.textContent = '';
    if (!labelPattern.test(name) || !labelPattern.test(release)) { status.textContent = 'Enter a valid package name and version (up to 128 ASCII characters).'; node(!labelPattern.test(name) ? 'pkg-name' : 'pkg-version').focus(); return; }
    if (!file || file.size === 0 || file.size > MAX_FILE || !filenamePattern.test(file.name)) { status.textContent = 'Select a non-empty file up to 500 MiB with a plain ASCII filename (up to 180 characters).'; node('pkg-file').focus(); return; }
    if (new TextEncoder().encode(node('pkg-desc').value).length > 4096) { status.textContent = 'Description is too long (maximum 4096 UTF-8 bytes).'; node('pkg-desc').focus(); return; }
    const form = new FormData();
    form.append('name', name); form.append('version', release); form.append('os_target', node('pkg-os').value); form.append('arch_target', node('pkg-arch').value); form.append('description', node('pkg-desc').value); form.append('file', file);
    uploading = true; node('pkg-fields').disabled = true; node('pkg-upload-form').setAttribute('aria-busy', 'true'); node('pkg-submit').textContent = 'Uploading…';
    status.textContent = 'Uploading and calculating SHA-256. Keep this page open until the server confirms the upload.';
    try {
      await API.uploadPackage(form);
      if (!active(version, anchor)) return;
      node('pkg-upload-form').reset(); previewFile();
      status.textContent = 'Package saved. The server calculated its SHA-256 checksum.';
      node('packages-feedback').textContent = `${name} ${release} is available for download.`;
      await reload();
    } catch (error) {
      if (!active(version, anchor)) return;
      status.textContent = `Upload could not be confirmed: ${error.message || 'Connection failed'}. Your inputs are preserved. Refresh the library before retrying to avoid a duplicate release.`;
    } finally {
      if (active(version, anchor)) {
        uploading = false; node('pkg-fields').disabled = false; node('pkg-upload-form').setAttribute('aria-busy', 'false'); node('pkg-submit').textContent = 'Upload package';
      }
    }
  }
  async function deletePackage(id) {
    const pkg = packages.find(p => p.id === id);
    if (!pkg || !can('packages.write') || deleting.has(id)) return;
    if (!confirm(`Delete ${pkg.name} ${pkg.version}? Its public download link will stop working. Installed agents are not removed.`)) return;
    const version = generation, anchor = node('packages-workspace');
    deleting.add(id); draw();
    try {
      const response = await API.deletePackage(id);
      if (!active(version, anchor)) return;
      node('packages-feedback').textContent = response?.data?.warning || `${pkg.name} ${pkg.version} deleted.`;
      await reload();
    } catch (error) {
      if (active(version, anchor)) node('packages-feedback').textContent = `Deletion could not be confirmed: ${error.message}. Refresh the library before retrying.`;
    } finally {
      if (active(version, anchor)) { deleting.delete(id); draw(); }
    }
  }
  function formatSize(bytes) {
    if (!Number.isFinite(Number(bytes)) || Number(bytes) < 0) return 'Unknown';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  }
  return {render, reload, draw, resetFilters, showUpload, uploadPackage, deletePackage};
})();
