const crypto = require('crypto');

// Validación de la firma de webhooks de Mercado Pago.
// Manifest: "id:{data.id};request-id:{x-request-id};ts:{ts};"  (HMAC-SHA256 hex)
// Notas: las notificaciones de Código QR NO vienen firmadas (no aplican acá).

const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

function parseSignature(header) {
  const parts = {};
  for (const chunk of String(header || '').split(',')) {
    const idx = chunk.indexOf('=');
    if (idx === -1) continue;
    const key = chunk.slice(0, idx).trim();
    const value = chunk.slice(idx + 1).trim();
    parts[key] = value;
  }
  return parts;
}

function isValidSignature({ xSignature, xRequestId, dataId, secret, toleranceMs }) {
  if (!secret) return false;
  const parts = parseSignature(xSignature);
  const ts = parts.ts;
  const hash = parts.v1;
  if (!ts || !hash) return false;

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  const tsMs = tsNum < 1e12 ? tsNum * 1000 : tsNum;
  const tolerance = toleranceMs == null ? DEFAULT_TOLERANCE_MS : toleranceMs;
  if (tolerance > 0 && Math.abs(Date.now() - tsMs) > tolerance) return false;

  const manifest = `id:${dataId ?? ''};request-id:${xRequestId ?? ''};ts:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  const a = Buffer.from(hash, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { isValidSignature, parseSignature };
