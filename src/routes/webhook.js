const express = require('express');
const { getAdmin, audit } = require('../supabaseAdmin');
const { isValidSignature } = require('../mp/signature');
const mp = require('../mp/client');

const router = express.Router();

// Registra el evento de webhook (dedup por id). Devuelve true si es nuevo.
async function registerEvent(id, topic) {
  const { error } = await getAdmin().from('webhook_events').insert({ id: String(id), topic: topic || null });
  if (!error) return true;
  if (error.code === '23505') return false; // duplicado
  throw error;
}

async function forgetEvent(id) {
  try {
    await getAdmin().from('webhook_events').delete().eq('id', String(id));
  } catch (err) {
    console.error('webhook forgetEvent:', err.message);
  }
}

// Estados de MP que implican que el dinero ya no está.
const REVERSED_STATUSES = new Set(['refunded', 'charged_back', 'cancelled', 'rejected']);

// Aplica el pago a la venta por external_reference.
async function applyPayment(payment) {
  const saleId = payment.external_reference;
  if (!saleId) return;

  const patch = {
    mp_payment_id: String(payment.id),
    method: 'qr',
  };

  let action = 'MP_PAYMENT_UPDATE';
  if (payment.status === 'approved') {
    patch.status = 'confirmed';
    patch.confirmed_at = new Date().toISOString();
    action = 'MP_PAYMENT_CONFIRMED';
  } else if (REVERSED_STATUSES.has(payment.status)) {
    // Reembolso / contracargo / cancelación: revertir la venta confirmada.
    patch.status = 'rejected';
    action = 'MP_PAYMENT_REVERSED';
  }

  const { data, error } = await getAdmin()
    .from('sales')
    .update(patch)
    .eq('id', saleId)
    .select('id, status')
    .maybeSingle();

  if (error) throw error;
  if (data) {
    await audit({
      actorId: null,
      actorName: 'webhook-mp',
      action,
      entity: 'sales',
      entityId: saleId,
      details: { payment_id: payment.id, status: payment.status },
    });
  }
}

// Webhook público de Mercado Pago.
// Procesa antes de responder: en serverless (Vercel) el contexto se congela al
// responder, por lo que hacerlo en background es poco confiable.
router.post('/webhooks/mercadopago', async (req, res) => {
  const query = req.query || {};
  const body = req.body || {};
  const type = body.type || body.topic || query.type || query.topic;
  const dataId = (body.data && body.data.id) || query['data.id'] || query.id;
  const signature = req.headers['x-signature'];
  const requestId = req.headers['x-request-id'];

  // 1) Validar firma (excepto el topic de QR "point_integration_wh", que no se firma)
  const signed = isValidSignature({
    xSignature: signature,
    xRequestId: requestId,
    dataId,
    secret: process.env.MP_WEBHOOK_SECRET,
  });
  if (process.env.MP_WEBHOOK_SECRET && !signed && type !== 'point_integration_wh') {
    return res.status(401).json({ error: 'Firma inválida' });
  }

  if (!dataId) return res.status(200).json({ received: true });

  const eventKey = `${type}:${dataId}`;

  try {
    // 2) Dedup: si ya se procesó, no repetir.
    const isNew = await registerEvent(eventKey, type);
    if (!isNew) return res.status(200).json({ received: true, duplicate: true });

    // 3) Procesar (rápido y antes de responder).
    if (type === 'payment' && mp.isConfigured()) {
      const payment = await mp.getPayment(dataId);
      await applyPayment(payment);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('webhook mercadopago:', err.message);
    // Liberamos el evento para que MP reintente y no quede "procesado" a medias.
    await forgetEvent(eventKey);
    return res.status(500).json({ error: 'processing_error' });
  }
});

module.exports = router;
