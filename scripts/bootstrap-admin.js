require('dotenv').config();
const { getAdmin, isConfigured } = require('../src/supabaseAdmin');

async function main() {
  if (!isConfigured()) {
    console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el .env');
    process.exit(1);
  }

  const [email, password, name] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Uso: node scripts/bootstrap-admin.js <email> <password> ["Nombre"]');
    process.exit(1);
  }

  const sb = getAdmin();
  const displayName = name || 'Administrador';

  const { data, error } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name: displayName },
  });
  if (error) {
    console.error('Error creando usuario:', error.message);
    process.exit(1);
  }

  const { error: profileErr } = await sb.from('profiles').upsert({
    id: data.user.id,
    name: displayName,
    email,
    role: 'admin',
    active: true,
  });
  if (profileErr) {
    console.error('Error creando perfil:', profileErr.message);
    process.exit(1);
  }

  console.log(`Admin creado: ${email} (${data.user.id})`);
}

main();
