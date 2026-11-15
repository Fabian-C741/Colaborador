import { getSupabase, getSettings, api, currentProfile } from './config.js';
import { $, $$, money, escapeHtml, toast, applyBranding, qrImage } from './ui.js';
import { enqueue, dequeue, listQueue, uuid } from './offline.js';

let sb = null;
let profile = null;
let settings = null;
let products = [];
let cart = {}; // productId -> qty
let activeTab = 'sell';
let realtimeChannel = null;

const STATUS_LABEL = {
  pending: ['Pendiente', 'warn'],
  confirmed: ['Confirmada', 'ok'],
  rejected: ['Rechazada', 'err'],
  unassigned: ['Sin asignar', 'off'],
};
const METHOD_LABEL = { efectivo: 'Efectivo', qr: 'QR', transferencia: 'Transferencia' };

// ---------------------------------------------------------------- init
async function init() {
  sb = await getSupabase();
  settings = await getSettings();
  applyBranding(settings);

  const { data: sessionData } = await sb.auth.getSession();
  if (!sessionData || !sessionData.session) return (window.location.href = '/');

  profile = await currentProfile();
  if (!profile || !profile.active) {
    await sb.auth.signOut();
    return (window.location.href = '/');
  }
  $('#user-chip').textContent = `${profile.name} · ${profile.role === 'admin' ? 'Admin' : 'Colaborador'}`;

  buildTabs();
  wireGlobal();
  updateConnBadge();

  await loadProducts();
  await refreshSales();
  await refreshSettle();

  if (profile.role === 'admin') {
    buildAdminTabs();
    wireAdmin();
    await refreshAdmin();
    subscribeRealtime();
  }

  window.addEventListener('online', flushQueue);
  window.addEventListener('offline', updateConnBadge);
  flushQueue();

  registerServiceWorker();
}

// ---------------------------------------------------------------- tabs
function buildTabs() {
  const tabs = $('#tabs');
  const items = [
    ['sell', 'Vender'],
    ['sales', 'Mis ventas'],
    ['settle', 'Rendición'],
  ];
  if (profile.role === 'admin') items.push(['admin', 'Admin']);
  tabs.innerHTML = items
    .map(([id, label]) => `<button class="tab" data-tab="${id}">${label}</button>`)
    .join('');
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    showTab(btn.dataset.tab);
  });
  showTab('sell');
}

function showTab(id) {
  activeTab = id;
  $$('#tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
  $$('main > .tab-panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${id}`));
  if (id === 'sales') refreshSales();
  if (id === 'settle') refreshSettle();
  if (id === 'admin') refreshAdmin();
}

function buildAdminTabs() {
  const tabs = $('#admin-tabs');
  const items = [
    ['overview', 'Resumen'],
    ['sales', 'Ventas'],
    ['transfers', 'Transferencias'],
    ['settlements', 'Rendiciones'],
    ['products', 'Productos'],
    ['users', 'Colaboradores'],
    ['settings', 'Ajustes'],
  ];
  tabs.innerHTML = items.map(([id, l]) => `<button class="tab" data-atab="${id}">${l}</button>`).join('');
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    showAdminTab(btn.dataset.atab);
  });
  showAdminTab('overview');
}

function showAdminTab(id) {
  $$('#admin-tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.atab === id));
  $$('#panel-admin > .tab-panel').forEach((p) => p.classList.toggle('active', p.id === `admin-${id}`));
}

// ---------------------------------------------------------------- products / cart
async function loadProducts() {
  const { data, error } = await sb
    .from('products')
    .select('*')
    .eq('active', true)
    .order('sort', { ascending: true });
  if (error) return toast(error.message, 'error');
  products = data || [];
  renderProducts();
}

function renderProducts() {
  const grid = $('#product-grid');
  if (!products.length) {
    grid.innerHTML = '<p class="empty">No hay productos cargados.</p>';
    return;
  }
  grid.innerHTML = products
    .map(
      (p) => `
      <div class="product-card">
        <div class="product-name">${escapeHtml(p.name)}</div>
        <div class="product-price">${money(p.price)}</div>
        <div class="qty-controls">
          <button class="btn small" data-dec="${p.id}">−</button>
          <span data-qty="${p.id}">${cart[p.id] || 0}</span>
          <button class="btn small" data-inc="${p.id}">+</button>
        </div>
      </div>`
    )
    .join('');
  grid.querySelectorAll('[data-inc]').forEach((b) =>
    b.addEventListener('click', () => addQty(b.dataset.inc, 1))
  );
  grid.querySelectorAll('[data-dec]').forEach((b) =>
    b.addEventListener('click', () => addQty(b.dataset.dec, -1))
  );
  renderCart();
}

function addQty(id, delta) {
  cart[id] = Math.max(0, (cart[id] || 0) + delta);
  if (cart[id] === 0) delete cart[id];
  $(`[data-qty="${id}"]`).textContent = cart[id] || 0;
  renderCart();
}

function cartItems() {
  return Object.entries(cart).map(([id, qty]) => {
    const p = products.find((x) => x.id === id);
    return { product: p, qty };
  }).filter((x) => x.product);
}

function cartTotal() {
  return cartItems().reduce((sum, x) => sum + Number(x.product.price) * x.qty, 0);
}

function renderCart() {
  const items = cartItems();
  $('#sell-total').textContent = `Total: ${money(cartTotal())}`;
  const el = $('#cart');
  if (!items.length) {
    el.innerHTML = '<p class="muted small">Elegí productos para vender.</p>';
    return;
  }
  el.innerHTML = items
    .map(
      (x) =>
        `<div class="cart-line"><span>${x.qty} × ${escapeHtml(x.product.name)}</span><span>${money(
          x.qty * x.product.price
        )}</span></div>`
    )
    .join('');
}

// ---------------------------------------------------------------- selling
function wireGlobal() {
  $('#logout-btn').addEventListener('click', async () => {
    await sb.auth.signOut();
    window.location.href = '/';
  });
  $('#sell-cash').addEventListener('click', () => sell('efectivo'));
  $('#sell-qr').addEventListener('click', () => sell('qr'));
  $('#cart-clear').addEventListener('click', () => {
    cart = {};
    renderProducts();
  });
  $('#sales-refresh').addEventListener('click', refreshSales);
  $('#settle-form').addEventListener('submit', submitSettlement);
  $('#my-password-btn').addEventListener('click', openChangeOwnPassword);
}

// ---------------------------------------------------------------- dialogs / claves
function openDialog(title, bodyHTML) {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal">
      <div class="modal-box">
        <div class="modal-head">
          <h2>${escapeHtml(title)}</h2>
          <button class="btn small ghost" type="button" data-close>×</button>
        </div>
        ${bodyHTML}
      </div>
    </div>`;
  root.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => (root.innerHTML = ''))
  );
  return root;
}

function closeDialog() {
  $('#modal-root').innerHTML = '';
}

function openChangeOwnPassword() {
  openDialog(
    'Cambiar mi contraseña',
    `<form id="own-pass-form" class="grid-form" style="grid-template-columns: 1fr">
      <label>Contraseña actual
        <input id="own-pass-current" type="password" autocomplete="current-password" required />
      </label>
      <label>Nueva contraseña
        <input id="own-pass-new" type="password" autocomplete="new-password" minlength="6" required />
      </label>
      <label>Repetir nueva contraseña
        <input id="own-pass-repeat" type="password" autocomplete="new-password" minlength="6" required />
      </label>
      <p class="error" id="own-pass-error"></p>
      <div class="form-actions">
        <button class="btn primary" type="submit" id="own-pass-submit">Guardar contraseña</button>
      </div>
    </form>`
  );

  const errorEl = $('#own-pass-error');
  $('#own-pass-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    const current = $('#own-pass-current').value;
    const next = $('#own-pass-new').value;
    const repeat = $('#own-pass-repeat').value;
    if (next.length < 6) return (errorEl.textContent = 'La nueva contraseña debe tener al menos 6 caracteres');
    if (next !== repeat) return (errorEl.textContent = 'Las contraseñas nuevas no coinciden');

    const btn = $('#own-pass-submit');
    btn.disabled = true;
    try {
      // Re-autenticación: verifica la contraseña actual antes de cambiarla.
      const { error: authErr } = await sb.auth.signInWithPassword({
        email: profile.email,
        password: current,
      });
      if (authErr) throw new Error('La contraseña actual no es correcta');

      const { error } = await sb.auth.updateUser({ password: next });
      if (error) throw new Error(error.message);

      closeDialog();
      toast('Contraseña actualizada', 'ok');
    } catch (err) {
      errorEl.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

function openAdminResetPassword(userId, userName) {
  openDialog(
    `Cambiar contraseña: ${userName}`,
    `<form id="admin-pass-form" class="grid-form" style="grid-template-columns: 1fr">
      <label>Nueva contraseña
        <input id="admin-pass-new" type="password" autocomplete="new-password" minlength="6" required />
      </label>
      <label>Repetir nueva contraseña
        <input id="admin-pass-repeat" type="password" autocomplete="new-password" minlength="6" required />
      </label>
      <p class="error" id="admin-pass-error"></p>
      <div class="form-actions">
        <button class="btn primary" type="submit" id="admin-pass-submit">Guardar contraseña</button>
      </div>
    </form>`
  );

  const errorEl = $('#admin-pass-error');
  $('#admin-pass-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    const next = $('#admin-pass-new').value;
    const repeat = $('#admin-pass-repeat').value;
    if (next.length < 6) return (errorEl.textContent = 'La contraseña debe tener al menos 6 caracteres');
    if (next !== repeat) return (errorEl.textContent = 'Las contraseñas no coinciden');

    const btn = $('#admin-pass-submit');
    btn.disabled = true;
    try {
      await api(`/admin/users/${userId}/password`, {
        method: 'POST',
        body: JSON.stringify({ password: next }),
      });
      closeDialog();
      toast('Contraseña del usuario actualizada', 'ok');
    } catch (err) {
      errorEl.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

async function sell(method) {
  const items = cartItems();
  if (!items.length) return toast('Agregá productos primero', 'error');

  if (method === 'qr' && !navigator.onLine) {
    return toast('Necesitás conexión para cobrar con QR', 'error');
  }

  if (method === 'qr') {
    // Un solo cobro/pago para todo el carrito: una venta y una preferencia.
    const total = cartTotal();
    const description = items.map((x) => `${x.qty} × ${x.product.name}`).join(', ');
    const sale = {
      event_id: settings ? settings.event_id : null,
      collaborator_id: profile.id,
      product_id: null,
      product_name: description,
      unit_price: total,
      quantity: 1,
      total,
      method,
      status: 'pending',
      client_uuid: uuid(),
      created_by: profile.id,
    };
    const ok = await persistSale(sale, method);
    if (!ok) return;
  } else {
    for (const { product, qty } of items) {
      const sale = {
        event_id: settings ? settings.event_id : null,
        collaborator_id: profile.id,
        product_id: product.id,
        product_name: product.name,
        unit_price: Number(product.price),
        quantity: qty,
        total: Number(product.price) * qty,
        method,
        status: 'pending',
        client_uuid: uuid(),
        created_by: profile.id,
      };
      await persistSale(sale, method);
    }
  }

  cart = {};
  renderProducts();
  await refreshSales();
  toast(method === 'efectivo' ? 'Venta en efectivo registrada' : 'Venta QR registrada', 'ok');
}

async function persistSale(sale, method) {
  const offline = !navigator.onLine;
  if (offline) {
    // El QR necesita conexión para generar la preferencia; no se puede diferir.
    if (method === 'qr') {
      toast('Sin conexión: no se puede cobrar con QR', 'error');
      return false;
    }
    await enqueue(sale);
    return true;
  }
  const { data, error } = await sb.from('sales').insert(sale).select('id').single();
  if (error) {
    // Reintento idempotente: si ya existe por client_uuid, se ignora.
    if (error.code === '23505') return true;
    if (method === 'qr') {
      toast(`No se pudo registrar la venta QR: ${error.message}`, 'error');
      return false;
    }
    await enqueue(sale);
    toast('Sin conexión: venta guardada para sincronizar', 'error');
    return true;
  }
  if (method === 'qr' && data) {
    await showQrPayment(data.id, sale.total, sale.product_name);
  }
  return true;
}

async function showQrPayment(saleId, total, description) {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal">
      <div class="modal-box">
        <div class="modal-head"><h2>Cobrar con QR</h2><button class="btn small ghost" data-close>×</button></div>
        <p class="muted small">${escapeHtml(description)} · ${money(total)}</p>
        <div class="qr-wrap" id="qr-wrap"><p class="muted">Generando QR…</p></div>
        <p class="hint" id="qr-status">Esperando el pago…</p>
        <button class="btn ghost" style="width:100%;margin-top:10px" data-close>Cerrar</button>
      </div>
    </div>`;
  root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => (root.innerHTML = '')));

  try {
    const order = await api('/mp/order', { method: 'POST', body: JSON.stringify({ saleId }) });
    const link = order.init_point || order.sandbox_init_point;
    $('#qr-wrap').innerHTML = `<img class="qr-img" alt="QR" src="${qrImage(link, 260)}" />
      <a class="muted small" href="${escapeHtml(link)}" target="_blank" rel="noopener">Abrir link de pago</a>`;
    pollSale(saleId);
  } catch (err) {
    $('#qr-wrap').innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

function pollSale(saleId) {
  let tries = 0;
  const timer = setInterval(async () => {
    tries += 1;
    const { data } = await sb.from('sales').select('status').eq('id', saleId).single();
    if (data && data.status === 'confirmed') {
      clearInterval(timer);
      $('#qr-status').innerHTML = '<span class="badge ok">Pago confirmado</span>';
      toast('Pago QR confirmado', 'ok');
      refreshSales();
      setTimeout(() => ($('#modal-root').innerHTML = ''), 1500);
    } else if (tries > 40) {
      clearInterval(timer);
    }
  }, 3000);
}

async function flushQueue() {
  updateConnBadge();
  if (!navigator.onLine || !profile) return;
  const queue = await listQueue();
  for (const item of queue) {
    const { error } = await sb.from('sales').insert(item);
    if (!error || error.code === '23505') {
      await dequeue(item.client_uuid);
    }
  }
  if (queue.length) {
    toast(`Sincronizadas ${queue.length} ventas pendientes`, 'ok');
    refreshSales();
  }
}

// ---------------------------------------------------------------- my sales
async function refreshSales() {
  if (!profile) return;
  const { data, error } = await sb
    .from('sales')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return toast(error.message, 'error');
  const rows = data || [];
  $('#sales-empty').classList.toggle('hidden', rows.length > 0);
  $('#sales-body').innerHTML = rows.map(saleRow).join('');
}

function saleRow(s) {
  const [label, cls] = STATUS_LABEL[s.status] || [s.status, 'off'];
  return `<tr>
    <td class="small">${new Date(s.created_at).toLocaleString('es-AR')}</td>
    <td>${escapeHtml(s.product_name)}</td>
    <td>${s.quantity}</td>
    <td class="amount">${money(s.total)}</td>
    <td>${METHOD_LABEL[s.method] || s.method}</td>
    <td><span class="badge ${cls}">${label}</span></td>
  </tr>`;
}

// ---------------------------------------------------------------- settlement
async function refreshSettle() {
  if (!profile) return;
  const { data } = await sb.from('sales').select('total, method, status').eq('collaborator_id', profile.id);
  const cash = (data || []).filter((s) => s.method === 'efectivo' && s.status !== 'rejected');
  const expected = cash.reduce((a, s) => a + Number(s.total), 0);
  $('#settle-expected').textContent = money(expected);

  const { data: settles } = await sb
    .from('settlements')
    .select('*')
    .eq('collaborator_id', profile.id)
    .order('created_at', { ascending: false });
  const settled = (settles || [])
    .filter((s) => s.status === 'confirmed')
    .reduce((a, s) => a + Number(s.declared_cash), 0);
  $('#settle-settled').textContent = money(settled);
  $('#settle-body').innerHTML = (settles || [])
    .map((s) => {
      const [label, cls] = STATUS_LABEL[s.status] || [s.status, 'off'];
      return `<tr>
        <td class="small">${new Date(s.created_at).toLocaleString('es-AR')}</td>
        <td class="amount">${money(s.expected_cash)}</td>
        <td class="amount">${money(s.declared_cash)}</td>
        <td class="amount">${s.counted_cash == null ? '—' : money(s.counted_cash)}</td>
        <td class="amount">${s.difference == null ? '—' : money(s.difference)}</td>
        <td><span class="badge ${cls}">${label}</span></td>
      </tr>`;
    })
    .join('');
}

async function submitSettlement(e) {
  e.preventDefault();
  const declared = Number($('#settle-amount').value || 0);
  const expectedText = $('#settle-expected').textContent;
  const { data } = await sb.from('sales').select('total, method, status').eq('collaborator_id', profile.id);
  const expected = (data || [])
    .filter((s) => s.method === 'efectivo' && s.status !== 'rejected')
    .reduce((a, s) => a + Number(s.total), 0);

  const { error } = await sb.from('settlements').insert({
    event_id: settings ? settings.event_id : null,
    collaborator_id: profile.id,
    expected_cash: expected,
    declared_cash: declared,
    note: $('#settle-note').value || null,
    status: 'pending',
  });
  if (error) return toast(error.message, 'error');
  $('#settle-form').reset();
  toast('Rendición declarada. Esperando confirmación del admin.', 'ok');
  refreshSettle();
}

// ---------------------------------------------------------------- admin
function wireAdmin() {
  $('#admin-sales-refresh').addEventListener('click', refreshAdminSales);
  $('#admin-sales-filter').addEventListener('change', refreshAdminSales);
  $('#admin-transfers-sync').addEventListener('click', syncTransfers);
  $('#product-form').addEventListener('submit', createProduct);
  $('#user-form').addEventListener('submit', createUser);
  $('#settings-form').addEventListener('submit', saveSettings);
}

async function refreshAdmin() {
  await Promise.all([refreshAdminStats(), refreshAdminSales(), refreshTransfers(), refreshSettlements()]);
  await Promise.all([refreshProducts(), refreshUsers(), loadSettingsForm(), refreshAudit()]);
}

async function refreshAdminStats() {
  const { data } = await sb.from('sales').select('total, method, status');
  const rows = data || [];
  const confirmed = rows.filter((s) => s.status === 'confirmed');
  const sum = (arr) => arr.reduce((a, s) => a + Number(s.total), 0);
  const cash = sum(confirmed.filter((s) => s.method === 'efectivo'));
  const qr = sum(confirmed.filter((s) => s.method === 'qr'));
  const transfer = sum(confirmed.filter((s) => s.method === 'transferencia'));
  const pending = sum(rows.filter((s) => s.status === 'pending'));
  const total = cash + qr + transfer;

  $('#admin-stats').innerHTML = `
    <div class="stat-card"><span class="stat-label">Total recaudado</span><span class="stat-value">${money(total)}</span><span class="stat-sub">${confirmed.length} ventas confirmadas</span></div>
    <div class="stat-card"><span class="stat-label">Efectivo</span><span class="stat-value">${money(cash)}</span></div>
    <div class="stat-card"><span class="stat-label">QR Mercado Pago</span><span class="stat-value">${money(qr)}</span></div>
    <div class="stat-card"><span class="stat-label">Transferencias</span><span class="stat-value">${money(transfer)}</span></div>
    <div class="stat-card"><span class="stat-label">Pendiente de confirmar</span><span class="stat-value">${money(pending)}</span></div>`;
}

async function refreshAdminSales() {
  const filter = $('#admin-sales-filter').value;
  let query = sb.from('sales').select('*, profiles:collaborator_id(name)').order('created_at', { ascending: false }).limit(200);
  if (filter) query = query.eq('status', filter);
  const { data, error } = await query;
  if (error) return toast(error.message, 'error');
  $('#admin-all-sales-body').innerHTML = (data || [])
    .map((s) => {
      const [label, cls] = STATUS_LABEL[s.status] || [s.status, 'off'];
      const canConfirm = s.status === 'pending';
      return `<tr>
        <td class="small">${new Date(s.created_at).toLocaleString('es-AR')}</td>
        <td>${escapeHtml(s.profiles ? s.profiles.name : '—')}</td>
        <td>${escapeHtml(s.product_name)}</td>
        <td>${s.quantity}</td>
        <td class="amount">${money(s.total)}</td>
        <td>${METHOD_LABEL[s.method] || s.method}</td>
        <td><span class="badge ${cls}">${label}</span></td>
        <td class="actions">
          ${canConfirm ? `<button class="btn small" data-confirm="${s.id}">Confirmar</button>` : ''}
          ${s.status !== 'rejected' ? `<button class="btn small danger" data-reject="${s.id}">Rechazar</button>` : ''}
        </td>
      </tr>`;
    })
    .join('');

  $('#admin-all-sales-body').querySelectorAll('[data-confirm]').forEach((b) =>
    b.addEventListener('click', () => setSaleStatus(b.dataset.confirm, 'confirmed'))
  );
  $('#admin-all-sales-body').querySelectorAll('[data-reject]').forEach((b) =>
    b.addEventListener('click', () => setSaleStatus(b.dataset.reject, 'rejected'))
  );
}

async function setSaleStatus(id, status) {
  const patch = { status };
  if (status === 'confirmed') {
    patch.confirmed_by = profile.id;
    patch.confirmed_at = new Date().toISOString();
  }
  const { error } = await sb.from('sales').update(patch).eq('id', id);
  if (error) return toast(error.message, 'error');
  toast('Venta actualizada', 'ok');
  refreshAdmin();
}

async function refreshTransfers() {
  const { data } = await sb
    .from('sales')
    .select('*')
    .eq('status', 'unassigned')
    .order('created_at', { ascending: false });
  const { data: users } = await sb.from('profiles').select('id, name').eq('active', true);
  const options = (users || []).map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
  $('#admin-transfers-body').innerHTML = (data || [])
    .map(
      (s) => `<tr>
        <td class="small">${new Date(s.created_at).toLocaleString('es-AR')}</td>
        <td>${escapeHtml(s.product_name)}</td>
        <td class="amount">${money(s.total)}</td>
        <td>
          <div class="row">
            <select class="mini-select" data-assign="${s.id}"><option value="">Elegir…</option>${options}</select>
            <button class="btn small" data-assign-btn="${s.id}">Asignar</button>
          </div>
        </td>
      </tr>`
    )
    .join('') || '<tr><td colspan="4" class="empty">No hay transferencias sin asignar.</td></tr>';

  $('#admin-transfers-body').querySelectorAll('[data-assign-btn]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.dataset.assignBtn;
      const select = $(`[data-assign="${id}"]`);
      if (!select.value) return toast('Elegí un colaborador', 'error');
      try {
        await api(`/admin/transfers/${id}/assign`, {
          method: 'POST',
          body: JSON.stringify({ collaboratorId: select.value }),
        });
        toast('Transferencia asignada', 'ok');
        refreshAdmin();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
}

async function syncTransfers() {
  toast('Sincronizando…');
  try {
    const res = await api('/admin/sync/transfers', { method: 'POST' });
    if (res.ok === false) toast(res.error || 'No disponible', 'error');
    else toast(`Transferencias: ${res.inserted} nuevas`, 'ok');
    refreshTransfers();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function refreshSettlements() {
  const { data } = await sb
    .from('settlements')
    .select('*, profiles:collaborator_id(name)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  $('#admin-settle-body').innerHTML = (data || [])
    .map(
      (s) => `<tr>
        <td class="small">${new Date(s.created_at).toLocaleString('es-AR')}</td>
        <td>${escapeHtml(s.profiles ? s.profiles.name : '—')}</td>
        <td class="amount">${money(s.expected_cash)}</td>
        <td class="amount">${money(s.declared_cash)}</td>
        <td><input class="mini-input" type="number" step="0.01" min="0" data-count="${s.id}" placeholder="${s.declared_cash}" /></td>
        <td class="amount" data-diff="${s.id}">—</td>
        <td class="actions"><button class="btn small primary" data-settle-ok="${s.id}">Confirmar</button></td>
      </tr>`
    )
    .join('') || '<tr><td colspan="7" class="empty">No hay rendiciones pendientes.</td></tr>';

  $('#admin-settle-body').querySelectorAll('[data-count]').forEach((input) =>
    input.addEventListener('input', () => {
      const id = input.dataset.count;
      const row = (data || []).find((s) => s.id === id);
      const diff = Number(input.value || row.declared_cash) - Number(row.expected_cash);
      $(`[data-diff="${id}"]`).textContent = money(diff);
    })
  );
  $('#admin-settle-body').querySelectorAll('[data-settle-ok]').forEach((b) =>
    b.addEventListener('click', () => confirmSettlement(b.dataset.settleOk, data))
  );
}

async function confirmSettlement(id, rows) {
  const settlement = (rows || []).find((s) => s.id === id);
  const input = $(`[data-count="${id}"]`);
  const counted = Number(input.value || settlement.declared_cash);
  const difference = counted - Number(settlement.expected_cash);

  const { error } = await sb
    .from('settlements')
    .update({
      counted_cash: counted,
      difference,
      status: 'confirmed',
      confirmed_by: profile.id,
      confirmed_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) return toast(error.message, 'error');

  // Confirma las ventas en efectivo pendientes de ese colaborador
  await sb
    .from('sales')
    .update({ status: 'confirmed', confirmed_by: profile.id, confirmed_at: new Date().toISOString() })
    .eq('collaborator_id', settlement.collaborator_id)
    .eq('method', 'efectivo')
    .eq('status', 'pending');

  toast('Rendición confirmada', 'ok');
  refreshAdmin();
}

// ---------------------------------------------------------------- products admin
async function refreshProducts() {
  const { data } = await sb.from('products').select('*').order('sort', { ascending: true });
  $('#admin-products-body').innerHTML = (data || [])
    .map(
      (p) => `<tr>
        <td>${escapeHtml(p.name)}</td>
        <td class="amount">${money(p.price)}</td>
        <td>${p.sort}</td>
        <td>${p.active ? '<span class="badge ok">Sí</span>' : '<span class="badge off">No</span>'}</td>
        <td class="actions">
          <button class="btn small" data-toggle="${p.id}" data-active="${p.active}">${p.active ? 'Desactivar' : 'Activar'}</button>
          <button class="btn small danger" data-del="${p.id}">Eliminar</button>
        </td>
      </tr>`
    )
    .join('');

  $('#admin-products-body').querySelectorAll('[data-toggle]').forEach((b) =>
    b.addEventListener('click', async () => {
      await sb.from('products').update({ active: b.dataset.active !== 'true' }).eq('id', b.dataset.toggle);
      refreshProducts();
      loadProducts();
    })
  );
  $('#admin-products-body').querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('¿Eliminar producto?')) return;
      await sb.from('products').delete().eq('id', b.dataset.del);
      refreshProducts();
      loadProducts();
    })
  );
}

async function createProduct(e) {
  e.preventDefault();
  const { error } = await sb.from('products').insert({
    event_id: settings.event_id,
    name: $('#product-name').value.trim(),
    price: Number($('#product-price').value),
    sort: Number($('#product-sort').value || 0),
    active: true,
  });
  if (error) return toast(error.message, 'error');
  $('#product-form').reset();
  $('#product-sort').value = '0';
  toast('Producto agregado', 'ok');
  refreshProducts();
  loadProducts();
}

// ---------------------------------------------------------------- users admin
async function refreshUsers() {
  try {
    const { users } = await api('/admin/users');
    $('#admin-users-body').innerHTML = (users || [])
      .map(
        (u) => `<tr>
          <td>${escapeHtml(u.name)}</td>
          <td>${escapeHtml(u.email)}</td>
          <td>${u.role === 'admin' ? '<span class="badge warn">Admin</span>' : 'Colaborador'}</td>
          <td>${u.active ? '<span class="badge ok">Sí</span>' : '<span class="badge off">No</span>'}</td>
          <td class="actions">
            <button class="btn small" data-upass="${u.id}" data-uname="${escapeHtml(u.name)}">Clave</button>
            <button class="btn small" data-uactive="${u.id}" data-val="${u.active}">${u.active ? 'Desactivar' : 'Activar'}</button>
            <button class="btn small danger" data-udel="${u.id}">Eliminar</button>
          </td>
        </tr>`
      )
      .join('');

    $('#admin-users-body').querySelectorAll('[data-upass]').forEach((b) =>
      b.addEventListener('click', () => openAdminResetPassword(b.dataset.upass, b.dataset.uname))
    );

    $('#admin-users-body').querySelectorAll('[data-uactive]').forEach((b) =>
      b.addEventListener('click', async () => {
        await api(`/admin/users/${b.dataset.uactive}`, {
          method: 'PATCH',
          body: JSON.stringify({ active: b.dataset.val !== 'true' }),
        });
        refreshUsers();
      })
    );
    $('#admin-users-body').querySelectorAll('[data-udel]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('¿Eliminar usuario?')) return;
        try {
          await api(`/admin/users/${b.dataset.udel}`, { method: 'DELETE' });
          refreshUsers();
        } catch (err) {
          toast(err.message, 'error');
        }
      })
    );
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function createUser(e) {
  e.preventDefault();
  try {
    await api('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        name: $('#user-name').value.trim(),
        email: $('#user-email').value.trim(),
        password: $('#user-password').value,
        role: $('#user-role').value,
      }),
    });
    $('#user-form').reset();
    toast('Usuario creado', 'ok');
    refreshUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------- settings admin
async function loadSettingsForm() {
  const s = await getSettings(true);
  if (!s) return;
  $('#set-event-name').value = s.event_name || '';
  $('#set-logo').value = s.logo_url || '';
  $('#set-favicon').value = s.favicon_url || '';
  $('#set-background').value = s.background_url || '';
  $('#set-primary').value = s.primary_color || '#5b8cff';
  $('#set-secondary').value = s.secondary_color || '#3f6fe0';
  $('#set-theme').value = s.theme || 'dark';
  $('#set-footer').value = s.footer_text || '';
  $('#set-privacy').value = s.privacy_text || '';
}

async function saveSettings(e) {
  e.preventDefault();
  const patch = {
    event_name: $('#set-event-name').value.trim(),
    logo_url: $('#set-logo').value.trim() || null,
    favicon_url: $('#set-favicon').value.trim() || null,
    background_url: $('#set-background').value.trim() || null,
    primary_color: $('#set-primary').value,
    secondary_color: $('#set-secondary').value,
    theme: $('#set-theme').value,
    footer_text: $('#set-footer').value.trim(),
    privacy_text: $('#set-privacy').value.trim() || null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from('app_settings').update(patch).eq('id', 1);
  if (error) return toast(error.message, 'error');
  settings = await getSettings(true);
  applyBranding(settings);
  toast('Personalización guardada', 'ok');
}

async function refreshAudit() {
  const { data } = await sb
    .from('audit_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);
  $('#admin-audit-body').innerHTML = (data || [])
    .map(
      (a) => `<tr>
        <td class="small">${new Date(a.created_at).toLocaleString('es-AR')}</td>
        <td>${escapeHtml(a.actor_name || '—')}</td>
        <td>${escapeHtml(a.action)}</td>
        <td class="small">${escapeHtml(a.entity || '')}</td>
      </tr>`
    )
    .join('');
}

// ---------------------------------------------------------------- realtime / conn
function subscribeRealtime() {
  realtimeChannel = sb
    .channel('sales-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, () => {
      if (activeTab === 'admin') refreshAdmin();
    })
    .subscribe();
}

function updateConnBadge() {
  const el = $('#conn-badge');
  if (!el) return;
  if (navigator.onLine) {
    el.className = 'badge ok';
    el.textContent = 'En línea';
  } else {
    el.className = 'badge err';
    el.textContent = 'Sin conexión';
  }
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

init();
