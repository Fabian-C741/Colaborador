const { createClient } = require('@supabase/supabase-js');

let client = null;

function isConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function getAdmin() {
  if (!isConfigured()) {
    throw new Error('Supabase no está configurado (faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  }
  if (!client) {
    client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return client;
}

async function audit({ actorId, actorName, action, entity, entityId, details }) {
  try {
    await getAdmin().from('audit_log').insert({
      actor_id: actorId || null,
      actor_name: actorName || 'sistema',
      action,
      entity: entity || null,
      entity_id: entityId != null ? String(entityId) : null,
      details: details || null,
    });
  } catch (err) {
    console.error('audit_log:', err.message);
  }
}

module.exports = { getAdmin, isConfigured, audit };
