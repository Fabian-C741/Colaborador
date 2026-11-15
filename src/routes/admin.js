const express = require('express');
const { getAdmin, isConfigured, audit } = require('../supabaseAdmin');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    supabase: isConfigured(),
    mp: Boolean(process.env.MP_ACCESS_TOKEN),
  });
});

// Configuración pública para el frontend (la anon key es pública por diseño)
router.get('/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
  });
});

// Branding público (sin auth)
router.get('/settings', async (req, res, next) => {
  try {
    const { data, error } = await getAdmin()
      .from('app_settings')
      .select('*')
      .eq('id', 1)
      .single();
    if (error) throw error;
    res.json({ settings: data });
  } catch (err) {
    next(err);
  }
});

// Lista de colaboradores (admin)
router.get('/admin/users', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { data, error } = await getAdmin()
      .from('profiles')
      .select('id, name, email, role, active, created_at')
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ users: data });
  } catch (err) {
    next(err);
  }
});

// Crear colaborador (admin). Crea el usuario en Auth y su perfil.
router.post('/admin/users', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nombre, email y contraseña son obligatorios' });
    }
    const safeRole = role === 'admin' ? 'admin' : 'colaborador';

    const { data: created, error: createErr } = await getAdmin().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name },
    });
    if (createErr) return res.status(400).json({ error: createErr.message });

    const { error: profileErr } = await getAdmin().from('profiles').insert({
      id: created.user.id,
      name,
      email,
      role: safeRole,
      active: true,
    });
    if (profileErr) {
      await getAdmin().auth.admin.deleteUser(created.user.id).catch(() => {});
      throw profileErr;
    }

    await audit({
      actorId: req.user.id,
      actorName: req.user.name,
      action: 'CREATE_USER',
      entity: 'profiles',
      entityId: created.user.id,
      details: { name, email, role: safeRole },
    });

    res.status(201).json({ user: { id: created.user.id, name, email, role: safeRole, active: true } });
  } catch (err) {
    next(err);
  }
});

// Activar/desactivar o cambiar rol
router.patch('/admin/users/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { active, role, name } = req.body || {};
    const patch = {};
    if (typeof active === 'boolean') patch.active = active;
    if (role === 'admin' || role === 'colaborador') patch.role = role;
    if (name) patch.name = name;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nada para actualizar' });

    const { data, error } = await getAdmin()
      .from('profiles')
      .update(patch)
      .eq('id', id)
      .select('id, name, email, role, active')
      .single();
    if (error) throw error;

    await audit({
      actorId: req.user.id,
      actorName: req.user.name,
      action: 'UPDATE_USER',
      entity: 'profiles',
      entityId: id,
      details: patch,
    });

    res.json({ user: data });
  } catch (err) {
    next(err);
  }
});

// Restablecer contraseña (admin)
router.post('/admin/users/:id/password', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }
    const { error } = await getAdmin().auth.admin.updateUserById(req.params.id, { password });
    if (error) throw error;

    await audit({
      actorId: req.user.id,
      actorName: req.user.name,
      action: 'RESET_PASSWORD',
      entity: 'profiles',
      entityId: req.params.id,
      details: null,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Eliminar colaborador
router.delete('/admin/users/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'No podés eliminar tu propio usuario' });
    }
    const { error } = await getAdmin().auth.admin.deleteUser(req.params.id);
    if (error) throw error;

    await audit({
      actorId: req.user.id,
      actorName: req.user.name,
      action: 'DELETE_USER',
      entity: 'profiles',
      entityId: req.params.id,
      details: null,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
