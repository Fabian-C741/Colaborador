const express = require('express');
const { getAdmin, audit } = require('../supabaseAdmin');
const { requireAuth } = require('../middleware/auth');
const mp = require('../mp/client');

const router = express.Router();

// Crea la preferencia de pago (QR/link) para una venta propia y devuelve el init_point.
router.post('/mp/order', requireAuth, async (req, res, next) => {
  try {
    if (!mp.isConfigured()) {
      return res.status(503).json({ error: 'Mercado Pago no está configurado' });
    }
    const { saleId } = req.body || {};
    if (!saleId) return res.status(400).json({ error: 'Falta saleId' });

    const { data: sale, error } = await getAdmin()
      .from('sales')
      .select('*')
      .eq('id', saleId)
      .single();
    if (error || !sale) return res.status(404).json({ error: 'Venta no encontrada' });
    if (sale.collaborator_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }
    if (sale.status === 'confirmed') {
      return res.status(409).json({ error: 'La venta ya está confirmada' });
    }

    const baseUrl = process.env.BASE_URL || '';
    const preference = await mp.createPreference({
      saleId: sale.id,
      amount: sale.total,
      description: sale.product_name,
      baseUrl,
      payerName: req.user.name,
    });

    await getAdmin()
      .from('sales')
      .update({ mp_order_id: String(preference.id) })
      .eq('id', sale.id);

    await audit({
      actorId: req.user.id,
      actorName: req.user.name,
      action: 'CREATE_MP_ORDER',
      entity: 'sales',
      entityId: sale.id,
      details: { preference_id: preference.id, total: sale.total },
    });

    res.json({
      init_point: preference.init_point,
      sandbox_init_point: preference.sandbox_init_point,
      preference_id: preference.id,
    });
  } catch (err) {
    next(err);
  }
});

// Estado de una venta (para polling de respaldo del webhook)
router.get('/mp/order/:saleId', requireAuth, async (req, res, next) => {
  try {
    const { data: sale, error } = await getAdmin()
      .from('sales')
      .select('id, status, mp_payment_id, collaborator_id, total, method')
      .eq('id', req.params.saleId)
      .single();
    if (error || !sale) return res.status(404).json({ error: 'Venta no encontrada' });
    if (sale.collaborator_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }
    res.json({ sale });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
