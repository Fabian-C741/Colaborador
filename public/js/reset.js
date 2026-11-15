import { getSupabaseForRecovery, getSettings } from './config.js';
import { $, applyBranding, toast } from './ui.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForSession(sb, tries = 40, interval = 200) {
  for (let i = 0; i < tries; i += 1) {
    const { data } = await sb.auth.getSession();
    if (data && data.session) return data.session;
    await sleep(interval);
  }
  return null;
}

async function init() {
  try {
    const settings = await getSettings();
    applyBranding(settings);
  } catch {
    /* branding opcional */
  }

  const statusEl = $('#reset-status');
  const form = $('#reset-form');
  const errorEl = $('#reset-error');
  const doneEl = $('#reset-done');

  let sb;
  try {
    sb = await getSupabaseForRecovery();
  } catch (err) {
    statusEl.textContent = err.message;
    return;
  }

  // El link del email trae el token en el hash; esperamos a que se procese.
  const session = await waitForSession(sb);
  if (!session) {
    statusEl.textContent =
      'El enlace es inválido o expiró. Pedí uno nuevo desde la pantalla de ingreso.';
    return;
  }

  statusEl.textContent = 'Ingresá tu nueva contraseña.';
  form.classList.remove('hidden');
  $('#reset-password').focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    const next = $('#reset-password').value;
    const repeat = $('#reset-password-repeat').value;
    if (next.length < 6) return (errorEl.textContent = 'La contraseña debe tener al menos 6 caracteres');
    if (next !== repeat) return (errorEl.textContent = 'Las contraseñas no coinciden');

    const btn = $('#reset-btn');
    btn.disabled = true;
    btn.textContent = 'Guardando…';
    try {
      const { error } = await sb.auth.updateUser({ password: next });
      if (error) throw new Error(error.message);

      // Limpia el token del hash e invalida la sesión de recuperación.
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, '', window.location.pathname);
      }
      await sb.auth.signOut().catch(() => {});

      form.classList.add('hidden');
      statusEl.textContent = '';
      doneEl.classList.remove('hidden');
      toast('Contraseña actualizada', 'ok');
      setTimeout(() => (window.location.href = '/'), 1800);
    } catch (err) {
      errorEl.textContent = err.message;
      btn.disabled = false;
      btn.textContent = 'Guardar contraseña';
    }
  });
}

init();
