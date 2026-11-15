import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

let client = null;
let settings = null;

export async function getSupabase() {
  if (client) return client;
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error('No se pudo cargar la configuración');
  const cfg = await res.json();
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    throw new Error('Falta configurar Supabase (URL / anon key)');
  }
  client = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  return client;
}

// Cliente aislado para el flujo de recuperación de contraseña. Parsea el token
// del enlace del email (detectSessionInUrl) sin tocar la sesión persistida normal.
export async function getSupabaseForRecovery() {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error('No se pudo cargar la configuración');
  const cfg = await res.json();
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    throw new Error('Falta configurar Supabase (URL / anon key)');
  }
  return createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: true,
      flowType: 'implicit',
    },
  });
}

export async function getSettings(force = false) {
  if (settings && !force) return settings;
  const res = await fetch('/api/settings');
  if (!res.ok) return null;
  const data = await res.json();
  settings = data.settings;
  return settings;
}

export async function api(path, options = {}) {
  const sb = await getSupabase();
  const { data } = await sb.auth.getSession();
  const token = data && data.session ? data.session.access_token : null;
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
  return body;
}

export async function currentProfile() {
  const sb = await getSupabase();
  const { data } = await sb.auth.getUser();
  if (!data || !data.user) return null;
  const { data: profile } = await sb
    .from('profiles')
    .select('id, name, email, role, active')
    .eq('id', data.user.id)
    .single();
  return profile;
}
