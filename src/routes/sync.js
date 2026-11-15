const express = require('express');
const { getAdmin, audit } = require('../supabaseAdmin');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const mp = require('../mp/client');

const router = express.Router();

async function getEventId() {
  const { data } = await getAdmin().from('app_settings').select('event_id').eq('id', 1).single();
  if (data && data.event_id) return data.event_id;
  const { data: ev } = await getAdmin().from('events').select('id').limit(1).single();
  return ev ? ev.id : null;
}

const REVERSED_STATUSES = new Set(['refunded', 'charged_back', 'cancelled', 'rejected']);

// Reconciliación de pagos de MP (respaldo del webhook): confirma aprobados y
// revierte reembolsos/contracargos.
async function syncPayments() {
  if (!mp.isConfigured()) throw new Error('Mercado Pago no configurado');
  const payments = await mp.searchPayments({});
  let updated = 0; // aprobados nuevos (compat)
  let confirmed = 0;
  let reversed = 0;
  for (const payment of payments) {
    if (!payment.external_reference) continue;

    if (payment.status === 'approved') {
      const { data } = await getAdmin()
        .from('sales')
        .update({
          status: 'confirmed',
          method: 'qr',
          mp_payment_id: String(payment.id),
          confirmed_at: new Date().toISOString(),
        })
        .eq('id', payment.external_reference)
        .neq('status', 'confirmed')
        .select('id');
      if (data && data.length) {
        confirmed += 1;
        updated += 1;
      }
    } else if (REVERSED_STATUSES.has(payment.status)) {
      const { data } = await getAdmin()
        .from('sales')
        .update({
          status: 'rejected',
          mp_payment_id: String(payment.id),
        })
        .eq('id', payment.external_reference)
        .neq('status', 'rejected')
        .select('id');
      if (data && data.length) reversed += 1;
    }
  }
  return { checked: payments.length, updated, confirmed, reversed };
}

// Sincroniza transferencias recibidas -> ventas "unassigned" (para asignación manual)
async function syncTransfers() {
  if (!mp.isConfigured()) throw new Error('Mercado Pago no configurado');
  const eventId = await getEventId();
  if (!eventId) throw new Error('No hay evento configurado');

  const since = new Date(Date.now() - 1000 * 60 * 60 * 24 * 14).toISOString();
  const movements = await mp.searchAccountMovements({ since });

  let inserted = 0;
  for (const mv of movements) {
    const type = mv.type || mv.movement_type || '';
    const isIncoming = /bank_transfer|transfer|settlement|money_in|cash_in/i.test(type);
    const isCredit = mv.amount > 0 || mv.net_amount > 0 || mv.credit > 0;
    if (!isIncoming || !isCredit) continue;

    const amount = Math.abs(mv.amount || mv.net_amount || mv.credit || 0);
    const movementId = String(mv.id || mv.movement_id || `${type}-${mv.date}-${amount}`);
    const date = mv.date || mv.created_at || new Date().toISOString();
    const description = mv.description || mv.detail || 'Transferencia recibida';

    const { error } = await getAdmin().from('sales').insert({
      event_id: eventId,
      collaborator_id: null,
      product_id: null,
      product_name: description,
      unit_price: amount,
      quantity: 1,
      total: amount,
      method: 'transferencia',
      status: 'unassigned',
      mp_movement_id: movementId,
      created_at: date,
    });
    if (!error) inserted += 1;
    else if (error.code !== '23505') throw error;
  }
  return { checked: movements.length, inserted };
}

// Cron de Vercel (cada 5 min): sincroniza transferencias Y reconcilia pagos.
// El respaldo de pagos corre acá para no depender sólo del webhook.
router.get('/cron/sync-transfers', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'No autorizado' });
  }
  const result = {};
  try {
    result.transfers = { ok: true, ...(await syncTransfers()) };
  } catch (err) {
    result.transfers = { ok: false, error: err.message, notAvailable: err.notAvailable || false };
  }
  try {
    result.payments = { ok: true, ...(await syncPayments()) };
  } catch (err) {
    result.payments = { ok: false, error: err.message, notAvailable: err.notAvailable || false };
  }
  res.status(200).json({ ok: true, ...result });
});

// Sync manual (admin)
router.post('/admin/sync/payments', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const result = await syncPayments();
    await audit({
      actorId: req.user.id,
      actorName: req.user.name,
      action: 'SYNC_PAYMENTS',
      entity: 'sales',
      entityId: null,
      details: result,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/sync/transfers', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const result = await syncTransfers();
    await audit({
      actorId: req.user.id,
      actorName: req.user.name,
      action: 'SYNC_TRANSFERS',
      entity: 'sales',
      entityId: null,
      details: result,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message, notAvailable: err.notAvailable || false });
  }
});

// Asignar una transferencia a un colaborador
router.post('/admin/transfers/:saleId/assign', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { collaboratorId } = req.body || {};
    if (!collaboratorId) return res.status(400).json({ error: 'Falta collaboratorId' });

    const { data, error } = await getAdmin()
      .from('sales')
      .update({
        collaborator_id: collaboratorId,
        status: 'confirmed',
        confirmed_by: req.user.id,
        confirmed_at: new Date().toISOString(),
      })
      .eq('id', req.params.saleId)
      .eq('method', 'transferencia')
      .select('id')
      .single();
    if (error) throw error;

    await audit({
      actorId: req.user.id,
      actorName: req.user.name,
      action: 'ASSIGN_TRANSFER',
      entity: 'sales',
      entityId: req.params.saleId,
      details: { collaboratorId },
    });
    res.json({ sale: data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.syncPayments = syncPayments;
module.exports.syncTransfers = syncTransfers;
