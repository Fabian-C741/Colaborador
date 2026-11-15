export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function money(value) {
  const n = Number(value || 0);
  return n.toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 2 });
}

export function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let toastTimer = null;
export function toast(message, type = '') {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.className = `toast ${type}`;
  el.textContent = message;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

export function applyBranding(settings) {
  if (!settings) return;
  const root = document.documentElement;
  if (settings.primary_color) root.style.setProperty('--primary', settings.primary_color);
  if (settings.secondary_color) root.style.setProperty('--secondary', settings.secondary_color);
  if (settings.theme === 'light') document.body.classList.add('light');
  else document.body.classList.remove('light');

  if (settings.favicon_url) {
    let link = document.querySelector("link[rel='icon']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = settings.favicon_url;
  }
  if (settings.background_url) {
    document.body.style.backgroundImage = `url("${settings.background_url}")`;
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundAttachment = 'fixed';
  }
  document.title = settings.event_name ? `${settings.event_name}` : document.title;
  document.querySelectorAll('[data-event-name]').forEach((el) => {
    el.textContent = settings.event_name || '';
  });
  document.querySelectorAll('[data-footer]').forEach((el) => {
    el.textContent = settings.footer_text || '';
  });
  document.querySelectorAll('[data-logo]').forEach((el) => {
    if (settings.logo_url) {
      el.src = settings.logo_url;
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  });
}

export function qrImage(text, size = 240) {
  const url = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}`;
  return url;
}
