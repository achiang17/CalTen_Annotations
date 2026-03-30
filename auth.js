/* ============================================================
   auth.js — Client-side password gate
   ============================================================
   Not cryptographically secure — prevents casual unauthorized
   access only. Anyone reading source can bypass it.
   ============================================================ */

const AUTH_KEY = 'calten_auth';
const SITE_PASSWORD = 'gobeavers';

/**
 * Check if user is authenticated. Call on protected pages.
 * Redirects to login.html if not authenticated.
 */
function requireAuth() {
  if (sessionStorage.getItem(AUTH_KEY) !== 'authenticated') {
    window.location.href = 'login.html';
  }
}

/**
 * Handle login form. Runs automatically on login.html.
 */
function initLogin() {
  if (sessionStorage.getItem(AUTH_KEY) === 'authenticated') {
    window.location.href = 'home.html';
    return;
  }

  const input = document.getElementById('login-password');
  const btn = document.getElementById('btn-login');
  const error = document.getElementById('login-error');

  function attempt() {
    if (input.value === SITE_PASSWORD) {
      sessionStorage.setItem(AUTH_KEY, 'authenticated');
      window.location.href = 'home.html';
    } else {
      error.style.display = 'block';
      input.value = '';
      input.focus();
    }
  }

  btn.addEventListener('click', attempt);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') attempt();
  });
}

// Auto-detect login page
if (document.getElementById('btn-login')) {
  initLogin();
}
