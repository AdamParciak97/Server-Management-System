'use strict';
window.UI = {
  icon(name, className = '') {
    return `<svg class="icon ${className}" aria-hidden="true"><use href="/static/icons.svg#${name}"></use></svg>`;
  },
  empty(title, description, icon = 'server') {
    return `<div class="empty-state">${this.icon(icon)}<strong>${title}</strong><p>${description}</p></div>`;
  },
  securityNav(active) {
    return `<nav class="security-nav" aria-label="Security workspace"><a href="#alerts" ${active === 'alerts' ? 'aria-current="page"' : ''}>${this.icon('bell')} Alerts</a><a href="#compliance" ${active === 'compliance' ? 'aria-current="page"' : ''}>${this.icon('shield')} Compliance</a><span>SECURITY WORKSPACE</span></nav>`;
  },
  severity(value) {
    const level = ['critical', 'high', 'medium', 'low'].includes(value) ? value : 'unknown';
    return `<span class="security-badge severity-${level}">${App.escHtml(value || 'Unknown')}</span>`;
  },
  securityMetric(label, value, description, tone = '', icon = 'shield') {
    return `<div class="security-metric ${tone}"><span>${this.icon(icon)} ${label}</span><strong>${value}</strong><small>${description}</small></div>`;
  },
  // Native dialogs contain keyboard focus and handle Escape. Mount inside the
  // view so navigation also removes the dialog and its background inertness.
  dialog(host, title, content, context = 'SECURITY / DETAILS') {
    host.querySelector('.security-dialog')?.close();
    const opener = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'security-dialog';
    dialog.setAttribute('aria-labelledby', 'security-dialog-title');
    dialog.innerHTML = `<div class="security-dialog-heading"><div><span class="eyebrow">${App.escHtml(context)}</span><h3 id="security-dialog-title">${App.escHtml(title)}</h3></div><button type="button" class="btn" data-dialog-close aria-label="Close dialog">Close</button></div><div class="security-dialog-body">${content}</div>`;
    host.appendChild(dialog);
    dialog.querySelector('[data-dialog-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (!host.isConnected || host.querySelector('.security-dialog[open]')) return;
      if (opener?.isConnected) opener.focus();
      else host.querySelector('[id$="-refresh"]')?.focus();
    }, {once: true});
    dialog.showModal();
    return dialog;
  }
};
