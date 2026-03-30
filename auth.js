/* ============================================================
   auth.js — Client-side password gate + Dropbox token storage
   ============================================================ */

const AUTH_KEY = 'calten_auth';
const TOKEN_KEY = 'calten_dbx_token';
const SITE_PASSWORD = 'gobeavers';

/**
 * Check if user is authenticated. Redirects to login if not.
 */
function requireAuth() {
  if (sessionStorage.getItem(AUTH_KEY) !== 'authenticated') {
    window.location.href = 'index.html';
  }
}

/**
 * Get the stored Dropbox token.
 */
function getDropboxToken() {
  return sessionStorage.getItem(TOKEN_KEY) || '';
}

/**
 * Handle login form. Runs automatically on the login page.
 */
function initLogin() {
  if (sessionStorage.getItem(AUTH_KEY) === 'authenticated') {
    window.location.href = 'home.html';
    return;
  }

  const passwordInput = document.getElementById('login-password');
  const tokenInput = document.getElementById('login-token');
  const btn = document.getElementById('btn-login');
  const error = document.getElementById('login-error');

  function attempt() {
    const password = passwordInput.value;
    const token = tokenInput.value.trim();

    if (password !== SITE_PASSWORD) {
      error.textContent = 'Incorrect password.';
      error.style.display = 'block';
      passwordInput.value = '';
      passwordInput.focus();
      return;
    }

    if (!token) {
      error.textContent = 'Dropbox token is required.';
      error.style.display = 'block';
      tokenInput.focus();
      return;
    }

    sessionStorage.setItem(AUTH_KEY, 'authenticated');
    sessionStorage.setItem(TOKEN_KEY, token);
    window.location.href = 'home.html';
  }

  btn.addEventListener('click', attempt);
  [passwordInput, tokenInput].forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') attempt();
    });
  });
}

// Auto-detect login page
if (document.getElementById('btn-login')) {
  initLogin();
}
