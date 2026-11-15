import { getSupabase, getSettings, currentProfile } from './config.js';
import { $, applyBranding, toast } from './ui.js';

async function init() {
  try {
    const settings = await getSettings();
    applyBranding(settings);
  } catch (err) {
    toast(err.message, 'error');
  }

  // Si ya hay sesión válida, ir directo a la app
  try {
    const profile = await currentProfile();
    if (profile && profile.active) {
      window.location.href = '/app.html';
      return;
    }
  } catch {
    /* sin sesión */
  }

  const form = $('#login-form');
  const errorEl = $('#error');
  const btn = $('#submit-btn');

  // -------- Recuperar contraseña --------
  const recoverForm = $('#recover-form');
  const forgotLink = $('#forgot-link');
  const recoverCancel = $('#recover-cancel');
  const recoverError = $('#recover-error');
  const recoverBtn = $('#recover-btn');

  forgotLink.addEventListener('click', (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    form.classList.add('hidden');
    recoverForm.classList.remove('hidden');
    recoverError.textContent = '';
    $('#recover-email').value = $('#email').value.trim();
    $('#recover-email').focus();
  });

  recoverCancel.addEventListener('click', (e) => {
    e.preventDefault();
    recoverForm.classList.add('hidden');
    form.classList.remove('hidden');
  });

  recoverForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    recoverError.textContent = '';
    recoverBtn.disabled = true;
    recoverBtn.textContent = 'Enviando…';
    try {
      const sb = await getSupabase();
      const email = $('#recover-email').value.trim();
      const redirectTo = `${window.location.origin}/reset.html`;
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) throw new Error(error.message);
      // Mensaje genérico para no revelar si el email existe o no.
      toast('Si el email está registrado, te enviamos un enlace para restablecer la contraseña.', 'ok');
      recoverForm.classList.add('hidden');
      form.classList.remove('hidden');
    } catch (err) {
      recoverError.textContent = err.message;
    } finally {
      recoverBtn.disabled = false;
      recoverBtn.textContent = 'Enviar enlace';
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Ingresando…';
    try {
      const sb = await getSupabase();
      const email = $('#email').value.trim();
      const password = $('#password').value;
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);

      const profile = await currentProfile();
      if (!profile || !profile.active) {
        await sb.auth.signOut();
        throw new Error('Tu usuario está inactivo. Contactá al administrador.');
      }
      window.location.href = '/app.html';
    } catch (err) {
      errorEl.textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Ingresar';
    }
  });
}

init();
