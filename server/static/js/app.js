'use strict';

const Views = window.Views || (window.Views = {});

window.App = (() => {
  const views = {};
  let currentView = null;
  let refreshInterval = null;

  function registerView(name, module) {
    views[name] = module;
  }

  function showLogin() {
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('main-app').classList.add('hidden');
  }

  function showApp() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('main-app').classList.remove('hidden');
    const user = API.getUser();
    if (user) {
      document.getElementById('current-user').textContent = user.username + ' (' + user.role + ')';
    }
  }

  function navigate(viewName) {
    // Update nav
    document.querySelectorAll('.nav-link').forEach(a => {
      a.classList.toggle('active', a.dataset.view === viewName);
    });

    // Render view
    const content = document.getElementById('content');
    if (views[viewName]) {
      currentView = viewName;
      views[viewName].render(content);
    } else {
      content.innerHTML = `<p class="text-muted">View "${viewName}" not found.</p>`;
    }
  }

  async function updateAlertBadge() {
    try {
      const resp = await API.listAlerts(true);
      const alerts = resp && resp.data ? resp.data : [];
      const badge = document.getElementById('alert-badge');
      if (alerts.length > 0) {
        badge.textContent = alerts.length;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    } catch {}
  }

  function init() {
    API.init();

    // Register views
    registerView('overview', Views.Overview);
    registerView('servers', Views.Servers);
    registerView('commands', Views.Commands);
    registerView('alerts', Views.Alerts);
    registerView('compliance', Views.Compliance);
    registerView('packages', Views.Packages);
    registerView('audit', Views.Audit);
    registerView('settings', Views.Settings);

    // Login form
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('login-username').value;
      const password = document.getElementById('login-password').value;
      const errEl = document.getElementById('login-error');
      errEl.classList.add('hidden');
      try {
        await API.login(username, password);
        showApp();
        navigate('overview');
        refreshInterval = setInterval(updateAlertBadge, 30000);
        updateAlertBadge();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
      }
    });

    // Logout
    document.getElementById('logout-btn').addEventListener('click', async () => {
      await API.logout();
      if (refreshInterval) clearInterval(refreshInterval);
      showLogin();
    });

    // Navigation
    document.querySelectorAll('.nav-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        navigate(link.dataset.view);
      });
    });

    // Hash-based routing
    window.addEventListener('hashchange', () => {
      const view = location.hash.replace('#', '') || 'overview';
      navigate(view);
    });

    // Init: check if already logged in
    if (API.isLoggedIn()) {
      // Try to refresh first
      showApp();
      const hash = location.hash.replace('#', '') || 'overview';
      navigate(hash);
      refreshInterval = setInterval(updateAlertBadge, 30000);
      updateAlertBadge();
    } else {
      showLogin();
    }
  }

  // Utility functions exposed globally
  function formatDate(ts) {
    if (!ts) return '-';
    return new Date(ts).toLocaleString();
  }

  function timeAgo(ts) {
    if (!ts) return 'never';
    const diff = (Date.now() - new Date(ts)) / 1000;
    if (diff < 60) return Math.floor(diff) + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  function statusBadge(status) {
    const map = { online: 'status-online', offline: 'status-offline', unknown: 'status-unknown' };
    const cls = map[status] || 'status-unknown';
    return `<span class="status ${cls}">${status}</span>`;
  }

  function priorityClass(p) {
    return 'priority-' + (p || 'normal');
  }

  function escHtml(s) {
    if (s === null || s === undefined) return '';
    const value = String(s);
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function showModal(title, content, onConfirm, options = {}) {
    let existing = document.getElementById('modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'modal-overlay';
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    const sizeClass =
      options.size === 'full' ? ' modal-dialog-full' :
      options.size === 'wide' ? ' modal-dialog-wide' : '';
    modal.className = `modal-dialog${sizeClass}`;
    modal.innerHTML = `
      <h3 class="modal-title">${escHtml(title)}</h3>
      <div id="modal-content" class="modal-body">${content}</div>
      <div class="modal-actions">
        <button class="btn" id="modal-cancel">${escHtml(options.cancelLabel || 'Cancel')}</button>
        ${onConfirm ? '<button class="btn btn-primary" id="modal-confirm">Confirm</button>' : ''}
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.getElementById('modal-cancel').addEventListener('click', close);
    if (onConfirm) {
      document.getElementById('modal-confirm').addEventListener('click', () => {
        onConfirm();
        close();
      });
    }
    return { close };
  }

  return { init, showLogin, showApp, navigate, formatDate, timeAgo, statusBadge, priorityClass, escHtml, showModal };
})();

document.addEventListener('DOMContentLoaded', () => window.App.init());
