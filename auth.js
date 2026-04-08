/* ============================================================
   auth.js — Client-side password gate + Dropbox OAuth PKCE
   ============================================================ */

const AUTH_KEY = 'calten_auth';
const TOKEN_KEY = 'calten_dbx_token';
const SITE_PASSWORD = 'gobeavers';
const DBX_APP_KEY = '47f7xjqlp9rwmxv';

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

/* ── PKCE helpers ────────────────────────────────────────── */

function generateCodeVerifier() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(plain) {
  const data = new TextEncoder().encode(plain);
  return crypto.subtle.digest('SHA-256', data);
}

async function generateCodeChallenge(verifier) {
  const hash = await sha256(verifier);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ── OAuth flow ──────────────────────────────────────────── */

async function startDropboxOAuth() {
  const verifier = generateCodeVerifier();
  sessionStorage.setItem('dbx_code_verifier', verifier);

  const challenge = await generateCodeChallenge(verifier);
  const redirectUri = window.location.origin;

  const params = new URLSearchParams({
    client_id: DBX_APP_KEY,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    redirect_uri: redirectUri,
    token_access_type: 'online',
  });

  window.location.href = 'https://www.dropbox.com/oauth2/authorize?' + params.toString();
}

async function exchangeCodeForToken(code) {
  const verifier = sessionStorage.getItem('dbx_code_verifier');
  if (!verifier) throw new Error('Missing code verifier');

  const redirectUri = window.location.origin;

  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: code,
      grant_type: 'authorization_code',
      client_id: DBX_APP_KEY,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error('Token exchange failed: ' + text);
  }

  const data = await res.json();
  sessionStorage.removeItem('dbx_code_verifier');
  return data.access_token;
}

/* ── Login page init ─────────────────────────────────────── */

async function initLogin() {
  // Check if returning from Dropbox OAuth redirect
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');

  if (code && sessionStorage.getItem(AUTH_KEY) === 'authenticated') {
    // Returning from Dropbox OAuth — exchange code for token
    const statusEl = document.getElementById('dbx-status');
    try {
      statusEl.textContent = 'Connecting to Dropbox…';
      statusEl.style.display = 'block';
      statusEl.style.color = '#2563eb';

      const token = await exchangeCodeForToken(code);
      sessionStorage.setItem(TOKEN_KEY, token);

      // Clean URL and redirect
      window.history.replaceState({}, '', window.location.pathname);
      window.location.href = 'home.html';
    } catch (err) {
      statusEl.textContent = 'Dropbox connection failed: ' + err.message;
      statusEl.style.color = '#dc2626';
      statusEl.style.display = 'block';
    }
    return;
  }

  // Already fully authenticated
  if (sessionStorage.getItem(AUTH_KEY) === 'authenticated' && getDropboxToken()) {
    window.location.href = 'home.html';
    return;
  }

  const passwordInput = document.getElementById('login-password');
  const btn = document.getElementById('btn-login');
  const error = document.getElementById('login-error');
  const dbxSection = document.getElementById('dbx-section');

  // If already password-authenticated but no token, show Dropbox connect
  if (sessionStorage.getItem(AUTH_KEY) === 'authenticated') {
    document.getElementById('password-section').style.display = 'none';
    btn.style.display = 'none';
    dbxSection.style.display = 'block';
    return;
  }

  function attempt() {
    const password = passwordInput.value;

    if (password !== SITE_PASSWORD) {
      error.textContent = 'Incorrect password.';
      error.style.display = 'block';
      passwordInput.value = '';
      passwordInput.focus();
      return;
    }

    sessionStorage.setItem(AUTH_KEY, 'authenticated');

    // Show Dropbox connect step
    document.getElementById('password-section').style.display = 'none';
    btn.style.display = 'none';
    error.style.display = 'none';
    dbxSection.style.display = 'block';
  }

  btn.addEventListener('click', attempt);
  passwordInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') attempt();
  });
}

// Auto-detect login page
if (document.getElementById('btn-login')) {
  initLogin();
}
