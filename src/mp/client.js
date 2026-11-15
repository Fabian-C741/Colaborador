const MP_API = 'https://api.mercadopago.com';

function isConfigured() {
  return Boolean(process.env.MP_ACCESS_TOKEN);
}

function currency() {
  return process.env.MP_CURRENCY || 'ARS';
}

async function mpRequest(pathname, options = {}) {
  const res = await fetch(MP_API + pathname, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body.message || body.error || `HTTP ${res.status}`;
    const err = new Error(`Mercado Pago: ${detail}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// Crea una preferencia (Checkout Pro). El comprador paga escaneando el QR/link.
// external_reference = id de la venta -> permite atribuir el pago en el webhook.
async function createPreference({ saleId, amount, description, baseUrl, payerName }) {
  const payload = {
    items: [
      {
        title: description || 'Venta',
        quantity: 1,
        currency_id: currency(),
        unit_price: Number(amount),
      },
    ],
    external_reference: saleId,
    statement_descriptor: 'EVENTO',
  };
  if (payerName) payload.payer = { name: payerName };
  if (baseUrl) {
    payload.notification_url = `${baseUrl}/api/webhooks/mercadopago`;
    payload.back_urls = {
      success: `${baseUrl}/app.html?pago=ok`,
      pending: `${baseUrl}/app.html?pago=pendiente`,
      failure: `${baseUrl}/app.html?pago=error`,
    };
    payload.auto_return = 'approved';
  }
  return mpRequest('/checkout/preferences', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function getPayment(id) {
  return mpRequest(`/v1/payments/${id}`);
}

async function searchPayments({ since } = {}) {
  const params = new URLSearchParams();
  params.set('sort', 'date_created');
  params.set('criteria', 'desc');
  params.set('range', 'date_created');
  params.set('begin_date', since || new Date(Date.now() - 1000 * 60 * 60 * 24 * 90).toISOString());
  params.set('end_date', new Date().toISOString());
  params.set('limit', '100');

  const results = [];
  let offset = 0;
  for (;;) {
    params.set('offset', String(offset));
    const body = await mpRequest(`/v1/payments/search?${params.toString()}`);
    const page = Array.isArray(body.results) ? body.results : [];
    results.push(...page);
    const total = body.paging && typeof body.paging.total === 'number' ? body.paging.total : null;
    offset += page.length;
    if (page.length === 0 || page.length < 100) break;
    if (total != null && offset >= total) break;
    if (offset >= 1000) break;
  }
  return results;
}

// Movimientos de cuenta: captura TRANSFERENCIAS recibidas (no llegan por webhook).
// Requiere que el reporte/movimientos esté disponible en la cuenta del evento.
// Se consulta por rango de fechas. La forma exacta puede variar según la cuenta.
async function searchAccountMovements({ since } = {}) {
  const params = new URLSearchParams();
  params.set('begin_date', since || new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString());
  params.set('end_date', new Date().toISOString());
  params.set('limit', '100');

  const results = [];
  let offset = 0;
  for (;;) {
    params.set('offset', String(offset));
    let body;
    try {
      body = await mpRequest(`/v1/account/movements/search?${params.toString()}`);
    } catch (err) {
      // Endpoint no disponible en esta cuenta: no romper el cron.
      err.notAvailable = err.status === 404 || err.status === 403;
      throw err;
    }
    const page = Array.isArray(body.results) ? body.results : Array.isArray(body) ? body : [];
    results.push(...page);
    offset += page.length;
    if (page.length === 0 || page.length < 100) break;
    if (offset >= 1000) break;
  }
  return results;
}

module.exports = {
  isConfigured,
  currency,
  createPreference,
  getPayment,
  searchPayments,
  searchAccountMovements,
};
