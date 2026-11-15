const { getAdmin } = require('../supabaseAdmin');

function bearerToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

async function requireAuth(req, res, next) {
  try {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ error: 'No autenticado' });

    const { data, error } = await getAdmin().auth.getUser(token);
    if (error || !data || !data.user) return res.status(401).json({ error: 'Sesión inválida' });

    const { data: profile } = await getAdmin()
      .from('profiles')
      .select('id, name, email, role, active')
      .eq('id', data.user.id)
      .single();

    if (!profile || !profile.active) return res.status(403).json({ error: 'Usuario inactivo' });

    req.user = profile;
    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Requiere rol de administrador' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, bearerToken };
