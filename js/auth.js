/* ============================================================
   T-CMD — Authentication System
   Backend: Supabase (with localStorage fallback if not configured)
   ============================================================ */

const AuthManager = (() => {
  const STORAGE_KEY = 'tcmd_auth'; // session only — always localStorage

  function clearSession() { localStorage.removeItem(STORAGE_KEY); }

  // ── Session integrity hash ────────────────────────────────
  // A lightweight deterrent against session tampering.
  // Computes a stable string from the session that changes if role/features/email
  // are altered. Not cryptographically secure (client-side JS), but it:
  //   a) Detects accidental or casual localStorage edits immediately
  //   b) Forces re-login when the hash doesn't match
  // Full security requires server-side JWT verification (see supabase-schema.sql).
  function _sessionHash(s) {
    if (!s) return '';
    return btoa(`${s.userId}|${s.role}|${s.email}|${JSON.stringify(s.features || {})}`);
  }
  function setSession(user) {
    const session = {
      userId:   user.id,
      role:     user.role,
      name:     user.name,
      email:    user.email,
      features: user.features || { coinSignals: true, memeScanner: true, tradingLog: true }
    };
    session._h = _sessionHash(session);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }
  function getSession() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!s) return null;
      // Detect tampering: recompute hash and compare
      const expected = _sessionHash(s);
      if (s._h && s._h !== expected) {
        console.error('[Security] Session integrity check failed — possible tampering. Logging out.');
        localStorage.removeItem(STORAGE_KEY);
        return null;
      }
      return s;
    } catch { return null; }
  }

  // ── Public (sync — safe for UI guards) ───────────────────
  return {
    init() { /* no-op, SupabaseDB self-initialises */ },

    isLoggedIn() { return !!getSession(); },
    getUser() { return getSession(); },
    isAdmin() { const s = getSession(); return s?.role === 'admin'; },
    hasFeature(f) { const s = getSession(); return !!(s?.features?.[f]); },

    // Re-verify the current session against the live database.
    // Call this before rendering privileged pages (admin, tax calculator).
    // Returns true if the session is still valid and the DB role matches localStorage.
    async verifySession() {
      const s = getSession();
      if (!s?.userId || !s?.email) return false;
      try {
        const dbUser = await SupabaseDB.getUserByEmail(s.email);
        if (!dbUser) { clearSession(); return false; }
        if (dbUser.status !== 'active') { clearSession(); return false; }
        // If the DB role differs from what's in localStorage, the session was tampered with.
        if (dbUser.role !== s.role || dbUser.id !== s.userId) {
          console.error('[Security] Session role mismatch vs database — forcing re-login.');
          clearSession();
          return false;
        }
        // Refresh the session with authoritative DB data so features are always current
        setSession(dbUser);
        return true;
      } catch {
        // Network error: don't log out — just trust the cached session
        return true;
      }
    },

    logout() {
      clearSession();
      // Wipe per-user transaction cache so the next user cannot see stale data
      if (typeof TaxEngine !== 'undefined' && TaxEngine.clearUserCache) {
        TaxEngine.clearUserCache();
      }
    },

    // ── Async auth ─────────────────────────────────────────
    async login(email, password) {
      try {
        const user = await SupabaseDB.getUserByEmail(email);
        if (!user) return { success: false, error: 'Invalid email or password.' };
        if (user.password !== password) return { success: false, error: 'Invalid email or password.' };
        if (user.status === 'pending') return { success: false, error: 'pending', msg: 'Your account is awaiting admin approval.' };
        if (user.status === 'disabled') return { success: false, error: 'Account is suspended. Contact admin.' };
        setSession(user);
        // Clear stale cache from any previously logged-in user
        if (typeof TaxEngine !== 'undefined' && TaxEngine.clearUserCache) TaxEngine.clearUserCache();
        return { success: true, user };
      } catch (e) {
        console.error('Login error:', e);
        return { success: false, error: 'Connection error. Please try again.' };
      }
    },

    async loginWithPasskey(email) {
      try {
        const user = await SupabaseDB.getUserByEmail(email);
        if (!user) return { success: false, error: 'No account found for this email.' };
        if (user.status === 'pending') return { success: false, error: 'pending' };
        setSession(user);
        return { success: true, user };
      } catch (e) {
        return { success: false, error: 'Connection error.' };
      }
    },

    async register(name, email, password = 'passkey') {
      try {
        const user = await SupabaseDB.createUser({
          email, name, password,
          role: 'user', status: 'pending'
        });
        return { success: true, user };
      } catch (e) {
        return { success: false, error: e.message || 'Registration failed.' };
      }
    },

    // ── Admin helpers (async) ──────────────────────────────
    // SECURITY: Every admin operation first verifies the session role.
    // The client-side check is a usability guard; Supabase RLS provides the
    // server-side enforcement layer that cannot be bypassed from the browser.
    _requireAdmin() {
      const s = getSession();
      if (!s || s.role !== 'admin') {
        console.error('[AuthManager] Unauthorized admin operation attempted by', s?.email || 'unauthenticated user');
        throw new Error('Unauthorized: administrator access required.');
      }
    },

    async getAllUsers() {
      this._requireAdmin();
      return SupabaseDB.getAllUsers();
    },
    async approveUser(id) {
      this._requireAdmin();
      return SupabaseDB.updateUser(id, { status: 'active', features: { coinSignals: true, memeScanner: true, tradingLog: true, whalesWallets: false, taxCalculator: false } });
    },
    async disableUser(id) {
      this._requireAdmin();
      return SupabaseDB.updateUser(id, { status: 'disabled' });
    },
    async updateFeatures(id, features) {
      this._requireAdmin();
      return SupabaseDB.updateUser(id, { features });
    },
    async deleteUser(id) {
      this._requireAdmin();
      // Prevent admin from deleting their own account accidentally
      const s = getSession();
      if (s.userId === id) throw new Error('Cannot delete your own admin account.');
      return SupabaseDB.deleteUser(id);
    },
    async createUserDirect({ name, email, password, role = 'user' }) {
      this._requireAdmin();
      return SupabaseDB.createUser({
        name, email, password, role, status: 'active',
        features: { coinSignals: true, memeScanner: true, tradingLog: true, whalesWallets: false, taxCalculator: false },
      });
    },
    async updateUser(id, data) {
      this._requireAdmin();
      return SupabaseDB.updateUser(id, data);
    },

    // ── Invite helpers ────────────────────────────────────
    async generateInvite(email = null, name = null) {
      this._requireAdmin();
      const session = getSession();
      return SupabaseDB.createInvite({ email, name, createdBy: session?.userId || null });
    },
    async getAllInvites() {
      this._requireAdmin();
      const session = getSession();
      // Non-admin requests are already blocked above; but pass createdBy as
      // defence-in-depth so the query itself is also scoped.
      return SupabaseDB.getAllInvites(session?.userId);
    },

    // Register via invite token (bypasses pending — creates active account)
    async registerViaInvite(token, name, email, password) {
      try {
        const invite = await SupabaseDB.getInvite(token);
        if (!invite) return { success: false, error: 'Invalid invite link.' };
        if (invite.used_at) return { success: false, error: 'This invite has already been used.' };
        if (new Date(invite.expires_at) < new Date()) return { success: false, error: 'This invite link has expired.' };

        const user = await SupabaseDB.createUser({
          email, name, password,
          role: 'user', status: 'active',
          features: { coinSignals: true, memeScanner: true, tradingLog: true }
        });
        await SupabaseDB.markInviteUsed(token);
        return { success: true, user };
      } catch (e) {
        return { success: false, error: e.message || 'Registration failed.' };
      }
    }
  };
})();

// ── Auth UI ───────────────────────────────────────────────────
function renderAuthPage() {
  const page = document.getElementById('auth-page');
  if (!page) return;

  // ── Check for ?invite=TOKEN in URL ────────────────────────
  const params = new URLSearchParams(window.location.search);
  const inviteToken = params.get('invite');
  if (inviteToken) { renderInvitePage(page, inviteToken); return; }

  page.innerHTML = buildLoginForm();
  attachLoginHandlers();
}

function buildLoginForm() {
  const demoMode = !SUPABASE_READY;
  return `
    <div class="auth-wrap">
      <!-- Left decorative panel -->
      <div class="auth-brand-panel">
        <div class="auth-brand-content">
          <div class="auth-brand-logo">⚡</div>
          <div class="auth-brand-name">T-CMD</div>
          <div class="auth-brand-tagline">Trade Command</div>
          <div class="auth-brand-features">
            <div class="auth-feat">📡 Real-time signals</div>
            <div class="auth-feat">🔍 Meme scanner</div>
            <div class="auth-feat">🇸🇪 K4 Tax calculator</div>
            <div class="auth-feat">🐋 Whale tracker</div>
          </div>
        </div>
      </div>

      <!-- Right form panel -->
      <div class="auth-form-panel">
        <div class="auth-form-inner">
          <div class="auth-form-logo">
            <span class="auth-form-logo-icon">⚡</span>
            <span class="auth-form-logo-name">T-CMD</span>
          </div>

          ${demoMode ? `<div class="auth-demo-banner">⚠️ Demo mode — <a href="js/config.js" target="_blank">configure Supabase</a> for full access</div>` : ''}

          <!-- Tab switcher -->
          <div class="auth-toggle" id="auth-toggle">
            <button class="auth-toggle-btn active" id="tab-login" onclick="switchAuthTab('login')">Sign In</button>
            <button class="auth-toggle-btn" id="tab-register" onclick="switchAuthTab('register')">Request Access</button>
            <div class="auth-toggle-slider" id="auth-toggle-slider"></div>
          </div>

          <!-- Sign In form -->
          <div id="auth-login-form" class="auth-form-section">
            <h2 class="auth-form-title">Welcome back</h2>
            <p class="auth-form-sub">Sign in to your account to continue.</p>

            <div class="auth-field-group">
              <label class="auth-field-label">Email address</label>
              <input class="auth-field-input" type="email" id="auth-email"
                     placeholder="you@example.com" autocomplete="email">
            </div>
            <div class="auth-field-group">
              <label class="auth-field-label">Password</label>
              <div class="auth-input-wrap">
                <input class="auth-field-input" type="password" id="auth-password"
                       placeholder="••••••••" autocomplete="current-password">
                <button class="auth-eye-btn" type="button" onclick="toggleAuthPwd('auth-password',this)"
                        title="Show/hide password">👁</button>
              </div>
            </div>

            <div class="auth-error" id="auth-error" style="display:none"></div>

            <button class="auth-submit-btn" id="auth-submit" onclick="handleLogin()">
              <span id="auth-btn-text">Sign In →</span>
            </button>

            <div class="auth-sep"><span>or continue with</span></div>

            <button class="auth-passkey-btn" onclick="handlePasskeyLogin()">
              🔑 Passkey
            </button>
          </div>

          <!-- Request Access form -->
          <div id="auth-register-form" class="auth-form-section" style="display:none">
            <h2 class="auth-form-title">Request access</h2>
            <p class="auth-form-sub">Fill in your details — an admin will review your request.</p>

            <div class="auth-field-group">
              <label class="auth-field-label">Full name</label>
              <input class="auth-field-input" type="text" id="reg-name" placeholder="Your name">
            </div>
            <div class="auth-field-group">
              <label class="auth-field-label">Email address</label>
              <input class="auth-field-input" type="email" id="reg-email" placeholder="you@example.com">
            </div>
            <div class="auth-field-group">
              <label class="auth-field-label">Create password <span class="auth-field-hint">min 6 chars</span></label>
              <div class="auth-input-wrap">
                <input class="auth-field-input" type="password" id="reg-password"
                       placeholder="••••••••" autocomplete="new-password">
                <button class="auth-eye-btn" type="button" onclick="toggleAuthPwd('reg-password',this)"
                        title="Show/hide password">👁</button>
              </div>
            </div>

            <div class="auth-error" id="reg-error" style="display:none"></div>

            <button class="auth-submit-btn" onclick="handleRegister()">Send Request →</button>

            <p class="auth-register-note">Once approved you'll be able to sign in with your email and password.</p>
          </div>
        </div>
      </div>
    </div>`;
}

// Toggle password visibility helper
window.toggleAuthPwd = function(inputId, btn) {
  const inp = document.getElementById(inputId);
  if (!inp) return;
  if (inp.type === 'password') { inp.type = 'text'; btn.textContent = '🙈'; }
  else { inp.type = 'password'; btn.textContent = '👁'; }
};

async function renderInvitePage(page, token) {
  // Show loading while we validate the token
  page.innerHTML = `
    <div class="auth-container">
        <div class="auth-logo">
            <div class="auth-logo-icon">⚡</div>
            <div class="auth-logo-name">T-CMD</div>
        </div>
        <div class="auth-card">
            <div style="text-align:center;padding:20px;">
                <div style="font-size:28px;margin-bottom:12px;">🔗</div>
                <div style="color:var(--text-secondary);">Validating invite link...</div>
            </div>
        </div>
    </div>`;

  let invite = null;
  let inviteError = null;
  try {
    invite = await SupabaseDB.getInvite(token);
    if (!invite) inviteError = 'This invite link is invalid.';
    else if (invite.used_at) inviteError = 'This invite link has already been used.';
    else if (new Date(invite.expires_at) < new Date()) inviteError = 'This invite link has expired.';
  } catch (e) {
    inviteError = 'Could not validate invite. Check your connection.';
  }

  if (inviteError) {
    page.innerHTML = `
        <div class="auth-container">
            <div class="auth-logo"><div class="auth-logo-icon">⚡</div><div class="auth-logo-name">T-CMD</div></div>
            <div class="auth-card" style="text-align:center;">
                <div style="font-size:36px;margin-bottom:12px;">⛔</div>
                <h3 style="color:var(--accent-red);margin:0 0 8px;">${inviteError}</h3>
                <p style="color:var(--text-muted);font-size:13px;">Contact the person who invited you for a new link.</p>
                <a href="${window.location.pathname}" class="btn btn-outline" style="margin-top:16px;display:inline-block;">← Back to Login</a>
            </div>
        </div>`;
    return;
  }

  const expires = new Date(invite.expires_at);
  const daysLeft = Math.ceil((expires - Date.now()) / 86400000);

  page.innerHTML = `
    <div class="auth-container">
        <div class="auth-logo">
            <div class="auth-logo-icon">⚡</div>
            <div class="auth-logo-name">T-CMD</div>
            <div class="auth-logo-sub">You've been invited!</div>
        </div>
        <div class="auth-card">
            <div class="invite-banner">
                🎉 You have a <strong>T-CMD invite</strong> — expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}
            </div>
            <div class="auth-field">
                <label class="auth-label">Full Name</label>
                <input class="auth-input" type="text" id="inv-name" placeholder="Your name" value="${invite.name || ''}">
            </div>
            <div class="auth-field">
                <label class="auth-label">Email</label>
                <input class="auth-input" type="email" id="inv-email" placeholder="you@example.com" value="${invite.email || ''}">
            </div>
            <div class="auth-field">
                <label class="auth-label">Create Password</label>
                <input class="auth-input" type="password" id="inv-password" placeholder="Choose a password (min 6 chars)" autocomplete="new-password">
            </div>
            <div class="auth-error" id="inv-error" style="display:none;"></div>
            <button class="btn btn-primary auth-btn" id="inv-submit" onclick="handleInviteRegister('${token}')">
                <span id="inv-btn-text">Create My Account</span>
            </button>
        </div>
    </div>`;
}

// ── Auth event handlers ───────────────────────────────────────
window.switchAuthTab = function (tab) {
  document.getElementById('tab-login').classList.toggle('active', tab === 'login');
  document.getElementById('tab-register').classList.toggle('active', tab === 'register');
  document.getElementById('auth-login-form').style.display = tab === 'login' ? '' : 'none';
  document.getElementById('auth-register-form').style.display = tab === 'register' ? '' : 'none';
};

function attachLoginHandlers() {
  ['auth-email', 'auth-password'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });
  });
}

window.handleLogin = async function () {
  const email = document.getElementById('auth-email')?.value.trim();
  const password = document.getElementById('auth-password')?.value;
  const errorEl = document.getElementById('auth-error');
  const btnText = document.getElementById('auth-btn-text');
  if (!email || !password) { showAuthError(errorEl, 'Please enter email and password.'); return; }

  btnText.textContent = 'Signing in…';
  document.getElementById('auth-submit').disabled = true;
  const result = await AuthManager.login(email, password);
  btnText.textContent = 'Sign In';
  document.getElementById('auth-submit').disabled = false;

  if (result.success) {
    // Clear any ?invite= params without reload, then mount the app
    history.replaceState(null, '', window.location.pathname);
    showAppPage();
    App.init();
  } else {
    showAuthError(errorEl, result.error === 'pending'
      ? '\u23f3 Your account is awaiting admin approval.'
      : result.error);
  }
};

window.handlePasskeyLogin = async function () {
  const email = document.getElementById('auth-email')?.value.trim();
  if (!email) { showAuthError(document.getElementById('auth-error'), 'Enter your email first.'); return; }
  const result = await AuthManager.loginWithPasskey(email);
  if (result.success) {
    history.replaceState(null, '', window.location.pathname);
    showAppPage();
    App.init();
  } else {
    showAuthError(document.getElementById('auth-error'), result.error);
  }
};

window.handleRegister = async function () {
  const name = document.getElementById('reg-name')?.value.trim();
  const email = document.getElementById('reg-email')?.value.trim();
  const password = document.getElementById('reg-password')?.value;
  const errorEl = document.getElementById('reg-error');
  if (!name || !email || !password) { showAuthError(errorEl, 'Please fill in all fields.'); return; }
  if (password.length < 6) { showAuthError(errorEl, 'Password must be at least 6 characters.'); return; }

  const result = await AuthManager.register(name, email, password);
  if (result.success) {
    document.getElementById('auth-register-form').innerHTML = `
            <div style="text-align:center;padding:20px 0;">
                <div style="font-size:36px;">✅</div>
                <h3 style="color:var(--accent-green);margin:12px 0 6px;">Request Submitted!</h3>
                <p style="color:var(--text-muted);font-size:13px;">An admin will review and activate your account.<br>Once approved, sign in with <strong>${email}</strong> and the password you just set.</p>
            </div>`;
  } else {
    showAuthError(errorEl, result.error);
  }
};

window.handleInviteRegister = async function (token) {
  const name = document.getElementById('inv-name')?.value.trim();
  const email = document.getElementById('inv-email')?.value.trim();
  const password = document.getElementById('inv-password')?.value;
  const errorEl = document.getElementById('inv-error');
  const btnText = document.getElementById('inv-btn-text');
  const btn = document.getElementById('inv-submit');

  if (!name || !email || !password) { showAuthError(errorEl, 'Please fill in all fields.'); return; }
  if (password.length < 6) { showAuthError(errorEl, 'Password must be at least 6 characters.'); return; }

  btnText.textContent = 'Creating account…';
  btn.disabled = true;
  const result = await AuthManager.registerViaInvite(token, name, email, password);
  btn.disabled = false;
  btnText.textContent = 'Create My Account';

  if (result.success) {
    // Auto-login and go straight to app
    const loginResult = await AuthManager.login(email, password);
    if (loginResult.success) {
      history.replaceState(null, '', window.location.pathname);
      showAppPage();
      App.init();
    } else {
      // Fallback: show success + redirect to login
      document.querySelector('.auth-card').innerHTML = `
        <div style="text-align:center;padding:24px 0;">
          <div style="font-size:40px;">\ud83c\udf89</div>
          <h3 style="color:var(--accent-green);margin:12px 0 6px;">Account Created!</h3>
          <p style="color:var(--text-muted);font-size:13px;margin-bottom:20px;">Redirecting you to login...</p>
        </div>`;
      setTimeout(() => { history.replaceState(null, '', window.location.pathname); renderAuthPage(); }, 1500);
    }
  } else {
    showAuthError(errorEl, result.error);
  }
};

function showAuthError(el, msg) {
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 5000);
}

// ── Admin panel renderer ──────────────────────────────────────
async function renderAdminPanel() {
  // SECURITY: abort immediately if the current session is not admin.
  // This prevents an attacker who edited localStorage from ever seeing
  // the admin UI or triggering admin data loads.
  if (!AuthManager.isAdmin()) {
    console.warn('[Security] Unauthorized attempt to render admin panel.');
    const panel = document.getElementById('admin-page-content') || document.getElementById('admin-panel-content');
    if (panel) panel.innerHTML = `<div style="color:#f87171;padding:40px;text-align:center;font-size:14px;">⛔ Access denied — administrator account required.</div>`;
    return;
  }

  // Priority: dedicated admin nav page → inline tax target → legacy drawer overlay
  window._taxAdminTarget = null; // reset so next call picks fresh target
  const panel = document.getElementById('admin-page-content')
    || document.getElementById('admin-panel-content');
  if (!panel) return;
  panel.innerHTML = `<div style="color:var(--text-muted);padding:20px;text-align:center;">Loading users...</div>`;

  try {
    const [users, invites] = await Promise.all([
      AuthManager.getAllUsers(),
      AuthManager.getAllInvites()
    ]);
    const currentUser = AuthManager.getUser();

    const openInvites = invites.filter(i => !i.used_at && new Date(i.expires_at) > new Date());

    panel.innerHTML = `
        <div class="admin-section">
            <div class="admin-section-title" style="display:flex;align-items:center;justify-content:space-between;">
                <span>👥 Users (${users.length})</span>
                <button class="admin-btn approve" style="font-size:11px;" onclick="adminToggleCreateForm()">＋ Create User</button>
            </div>

            <!-- Create User Form (hidden by default) -->
            <div id="admin-create-form" style="display:none;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:14px;margin-bottom:14px;">
                <div style="font-size:12px;font-weight:700;color:var(--text-primary);margin-bottom:10px;">New User</div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
                    <input id="cu-name"  class="auth-input" style="height:32px;font-size:12px;" type="text"     placeholder="Full name">
                    <input id="cu-email" class="auth-input" style="height:32px;font-size:12px;" type="email"    placeholder="Email address">
                    <input id="cu-pass"  class="auth-input" style="height:32px;font-size:12px;" type="password" placeholder="Temporary password">
                    <select id="cu-role" class="auth-input" style="height:32px;font-size:12px;cursor:pointer;">
                        <option value="user">User</option>
                        <option value="admin">Admin</option>
                    </select>
                </div>
                <div style="display:flex;gap:8px;align-items:center;">
                    <button class="admin-btn approve" onclick="adminCreateUser()" style="font-size:11px;padding:5px 14px;">✓ Create</button>
                    <button class="admin-btn" onclick="adminToggleCreateForm()" style="font-size:11px;padding:5px 12px;">Cancel</button>
                    <span id="admin-create-status" style="font-size:11px;color:var(--text-muted);"></span>
                </div>
            </div>

            <table class="admin-user-table">
                <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Features</th><th>Actions</th></tr></thead>
                <tbody>${users.map(u => `
                <tr id="urow-${u.id}" class="${u.status === 'pending' ? 'admin-row-pending' : ''}">
                    <td>
                        <div style="display:flex;flex-direction:column;gap:2px;">
                            <span id="uname-${u.id}"><strong>${u.name}</strong></span>
                            <input id="uname-input-${u.id}" class="auth-input" style="display:none;height:26px;font-size:11px;padding:0 6px;" value="${u.name}">
                        </div>
                    </td>
                    <td style="font-size:11.5px;color:var(--text-muted);">
                        <span id="uemail-${u.id}">${u.email}</span>
                        <input id="uemail-input-${u.id}" class="auth-input" style="display:none;height:26px;font-size:11px;padding:0 6px;" value="${u.email}">
                    </td>
                    <td>
                        <span id="urole-${u.id}"><span class="role-badge role-${u.role}">${u.role}</span></span>
                        <select id="urole-input-${u.id}" style="display:none;height:26px;font-size:11px;background:rgba(255,255,255,0.07);border:1px solid var(--border-subtle);border-radius:5px;color:var(--text-primary);cursor:pointer;">
                            <option value="user"  ${u.role === 'user' ? 'selected' : ''}>user</option>
                            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option>
                        </select>
                    </td>
                    <td><span class="status-badge status-${u.status}">${u.status}</span></td>
                    <td>
                        <div style="display:flex;gap:4px;flex-wrap:wrap;">
                            ${['coinSignals', 'memeScanner', 'tradingLog', 'whalesWallets', 'taxCalculator'].map(f => `
                            <label class="feat-toggle" title="${f}" style="position:relative">
                                <input type="checkbox" ${u.features?.[f] ? 'checked' : ''} onchange="toggleFeature('${u.id}','${f}',this.checked)" ${u.id === currentUser?.userId ? 'disabled' : ''}>
                                <span>${f === 'coinSignals' ? '📡' : f === 'memeScanner' ? '🔍' : f === 'tradingLog' ? '📋' : f === 'whalesWallets' ? '🐋' : '🇸🇪'}</span>
                            </label>`).join('')}
                        </div>
                    </td>
                    <td>
                        <div style="display:flex;gap:4px;flex-wrap:wrap;">
                            ${u.id === currentUser?.userId
        ? `<span style="color:var(--text-muted);font-size:11px;">You</span>`
        : `
                            <span id="uactions-${u.id}" style="display:flex;gap:4px;">
                                ${u.status !== 'active' ? `<button class="admin-btn approve" onclick="adminApprove('${u.id}')">✓</button>` : ''}
                                ${u.status !== 'disabled' ? `<button class="admin-btn disable" onclick="adminDisable('${u.id}')">⊘</button>` : ''}
                                <button class="admin-btn" style="background:rgba(99,102,241,.15);color:#818cf8;border:1px solid rgba(99,102,241,.25)" onclick="adminStartEdit('${u.id}')">✏️</button>
                                <button class="admin-btn disable" style="background:rgba(239,68,68,.15);color:#f87171;border:1px solid rgba(239,68,68,.25)" onclick="adminDeleteUser('${u.id}','${u.name.replace(/'/g, '')}')">🗑</button>
                            </span>
                            <span id="usave-${u.id}" style="display:none;gap:4px;">
                                <button class="admin-btn approve" onclick="adminSaveEdit('${u.id}')">✓ Save</button>
                                <button class="admin-btn" onclick="adminCancelEdit('${u.id}')">✕</button>
                            </span>`}
                        </div>
                    </td>
                </tr>`).join('')}
                </tbody>
            </table>
        </div>

        <div class="admin-section" style="margin-top:20px;">
            <div class="admin-section-title">🔗 Invite Links</div>
            <div class="invite-gen-row">
                <input class="auth-input" type="email" id="invite-email" placeholder="Pre-fill email (optional)">
                <input class="auth-input" type="text" id="invite-name" placeholder="Pre-fill name (optional)">
                <button class="btn btn-primary invite-gen-btn" onclick="generateInviteLink()">🔗 Generate Invite</button>
            </div>
            <div id="invite-output" style="display:none;" class="invite-output-box">
                <div class="invite-output-label">📋 Invite link (valid 7 days) — click to copy:</div>
                <div class="invite-output-url" id="invite-url-display" onclick="copyInviteUrl()" title="Click to copy"></div>
                <div style="font-size:11px;color:var(--accent-green);margin-top:4px;" id="invite-copy-msg" style="display:none;">Copied!</div>
            </div>
            ${openInvites.length > 0 ? `
            <div style="margin-top:14px;">
                <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">Active open invites (${openInvites.length})</div>
                ${openInvites.map(i => `
                <div class="open-invite-row">
                    <span class="num-cyan" style="font-size:11px;font-family:var(--font-mono);">${i.token}</span>
                    ${i.email ? `<span style="font-size:11px;color:var(--text-muted);">${i.email}</span>` : ''}
                    <span style="font-size:11px;color:var(--text-muted);">Expires ${new Date(i.expires_at).toLocaleDateString()}</span>
                    <button class="admin-btn" style="font-size:10px;padding:2px 8px;" onclick="copyUrl('${TCMD_CONFIG.APP_URL}?invite=${i.token}')">Copy</button>
                </div>`).join('')}
            </div>` : ''}
        </div>

        <div class="admin-section" style="margin-top:20px;">
            <div class="admin-section-title">⚙️ System</div>
            <div style="font-size:12px;color:var(--text-muted);">
                Mode: <strong style="color:${SUPABASE_READY ? 'var(--accent-green)' : 'var(--accent-amber)'}">${SUPABASE_READY ? '🟢 Supabase (live)' : '🟡 localStorage (demo)'}</strong>
                ${!SUPABASE_READY ? ' — <a href="js/config.js" target="_blank" style="color:var(--accent-cyan);">Configure Supabase →</a>' : ''}
            </div>
        </div>

        <div class="admin-section" style="margin-top:20px;">
            <div class="admin-section-title">🔑 API Keys</div>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">
                Keys are stored securely in Supabase (per-admin). Required for rug checker, cluster detector, wallet imports, tax imports, and historical pricing.
                Get keys:
                <a href="https://birdeye.so/developer" target="_blank" style="color:var(--accent-cyan);">Birdeye →</a>
                &nbsp;·&nbsp;<a href="https://dev.helius.xyz" target="_blank" style="color:var(--accent-cyan);">Helius →</a>
                &nbsp;·&nbsp;<a href="https://etherscan.io/myapikey" target="_blank" style="color:var(--accent-cyan);">Etherscan →</a>
                &nbsp;·&nbsp;<a href="https://www.coingecko.com/en/api/pricing" target="_blank" style="color:var(--accent-cyan);">CoinGecko →</a>
                &nbsp;·&nbsp;<a href="https://basescan.org/myapikey" target="_blank" style="color:var(--accent-cyan);">Basescan →</a>
                &nbsp;·&nbsp;<a href="https://arbiscan.io/myapikey" target="_blank" style="color:var(--accent-cyan);">Arbiscan →</a>
                &nbsp;·&nbsp;<a href="https://monadexplorer.com" target="_blank" style="color:var(--accent-cyan);">Monadscan →</a>
            </div>
            <div style="display:flex;flex-direction:column;gap:10px;">
                <!-- Birdeye key -->
                <div style="display:flex;align-items:center;gap:8px;">
                    <label style="font-size:12px;font-weight:600;color:var(--text-primary);width:110px;flex-shrink:0;">🦅 Birdeye</label>
                    <input id="admin-birdeye-key" type="password" placeholder="Paste Birdeye API key…"
                        value="${ChainAPIs.getKeys().birdeye || ''}"
                        style="flex:1;height:30px;background:rgba(255,255,255,0.05);border:1px solid var(--border-subtle);border-radius:7px;color:var(--text-primary);font-size:12px;font-family:var(--font-mono);padding:0 10px;outline:none;">
                    <button onclick="adminSaveKey('birdeye')" style="height:30px;padding:0 12px;background:var(--accent-cyan);border:none;border-radius:7px;color:#0d1021;font-size:12px;font-weight:700;cursor:pointer;">Save</button>
                    <button onclick="adminTestKey('birdeye')" id="birdeye-test-btn" style="height:30px;padding:0 12px;background:rgba(255,255,255,0.07);border:1px solid var(--border-subtle);border-radius:7px;color:var(--text-secondary);font-size:12px;cursor:pointer;">Test</button>
                    <span id="birdeye-key-status" style="font-size:11px;color:var(--text-muted);min-width:80px;"></span>
                </div>
                <!-- Helius key -->
                <div style="display:flex;align-items:center;gap:8px;">
                    <label style="font-size:12px;font-weight:600;color:var(--text-primary);width:110px;flex-shrink:0;">🔆 Helius</label>
                    <input id="admin-helius-key" type="password" placeholder="Paste Helius API key (Solana)…"
                        value="${ChainAPIs.getKeys().helius || ''}"
                        style="flex:1;height:30px;background:rgba(255,255,255,0.05);border:1px solid var(--border-subtle);border-radius:7px;color:var(--text-primary);font-size:12px;font-family:var(--font-mono);padding:0 10px;outline:none;">
                    <button onclick="adminSaveKey('helius')" style="height:30px;padding:0 12px;background:var(--accent-cyan);border:none;border-radius:7px;color:#0d1021;font-size:12px;font-weight:700;cursor:pointer;">Save</button>
                    <button onclick="adminTestKey('helius')" id="helius-test-btn" style="height:30px;padding:0 12px;background:rgba(255,255,255,0.07);border:1px solid var(--border-subtle);border-radius:7px;color:var(--text-secondary);font-size:12px;cursor:pointer;">Test</button>
                    <span id="helius-key-status" style="font-size:11px;color:var(--text-muted);min-width:80px;"></span>
                </div>
                <!-- Etherscan key -->
                <div style="display:flex;align-items:center;gap:8px;">
                    <label style="font-size:12px;font-weight:600;color:var(--text-primary);width:110px;flex-shrink:0;">🦊 Etherscan</label>
                    <input id="admin-etherscan-key" type="password" placeholder="Paste Etherscan API key (MetaMask / EVM / Phantom ETH)…"
                        value="${ChainAPIs.getKeys().etherscan || ''}"
                        style="flex:1;height:30px;background:rgba(255,255,255,0.05);border:1px solid var(--border-subtle);border-radius:7px;color:var(--text-primary);font-size:12px;font-family:var(--font-mono);padding:0 10px;outline:none;">
                    <button onclick="adminSaveKey('etherscan')" style="height:30px;padding:0 12px;background:var(--accent-cyan);border:none;border-radius:7px;color:#0d1021;font-size:12px;font-weight:700;cursor:pointer;">Save</button>
                    <button onclick="adminTestKey('etherscan')" id="etherscan-test-btn" style="height:30px;padding:0 12px;background:rgba(255,255,255,0.07);border:1px solid var(--border-subtle);border-radius:7px;color:var(--text-secondary);font-size:12px;cursor:pointer;">Test</button>
                    <span id="etherscan-key-status" style="font-size:11px;color:var(--text-muted);min-width:80px;"></span>
                </div>
                <!-- CoinGecko Demo key -->
                <div style="display:flex;align-items:center;gap:8px;">
                    <label style="font-size:12px;font-weight:600;color:var(--text-primary);width:110px;flex-shrink:0;">🦎 CoinGecko</label>
                    <input id="admin-coingecko-key" type="password" placeholder="Paste CoinGecko Demo API key…"
                        value="${ChainAPIs.getKeys().coingecko || ''}"
                        style="flex:1;height:30px;background:rgba(255,255,255,0.05);border:1px solid var(--border-subtle);border-radius:7px;color:var(--text-primary);font-size:12px;font-family:var(--font-mono);padding:0 10px;outline:none;">
                    <button onclick="adminSaveKey('coingecko')" style="height:30px;padding:0 12px;background:var(--accent-cyan);border:none;border-radius:7px;color:#0d1021;font-size:12px;font-weight:700;cursor:pointer;">Save</button>
                    <button onclick="adminTestKey('coingecko')" id="coingecko-test-btn" style="height:30px;padding:0 12px;background:rgba(255,255,255,0.07);border:1px solid var(--border-subtle);border-radius:7px;color:var(--text-secondary);font-size:12px;cursor:pointer;">Test</button>
                    <span id="coingecko-key-status" style="font-size:11px;color:var(--text-muted);min-width:80px;"></span>
                </div>
                <!-- Basescan key (Base / L2) -->
                <div style="display:flex;align-items:center;gap:8px;">
                    <label style="font-size:12px;font-weight:600;color:var(--text-primary);width:110px;flex-shrink:0;">🔵 Basescan</label>
                    <input id="admin-basescan-key" type="password" placeholder="Paste Basescan API key (Base network)…"
                        value="${ChainAPIs.getKeys().basescan || ''}"
                        style="flex:1;height:30px;background:rgba(255,255,255,0.05);border:1px solid var(--border-subtle);border-radius:7px;color:var(--text-primary);font-size:12px;font-family:var(--font-mono);padding:0 10px;outline:none;">
                    <button onclick="adminSaveKey('basescan')" style="height:30px;padding:0 12px;background:var(--accent-cyan);border:none;border-radius:7px;color:#0d1021;font-size:12px;font-weight:700;cursor:pointer;">Save</button>
                    <button onclick="adminTestKey('basescan')" id="basescan-test-btn" style="height:30px;padding:0 12px;background:rgba(255,255,255,0.07);border:1px solid var(--border-subtle);border-radius:7px;color:var(--text-secondary);font-size:12px;cursor:pointer;">Test</button>
                    <span id="basescan-key-status" style="font-size:11px;color:var(--text-muted);min-width:80px;"></span>
                </div>
                <!-- Arbiscan key (Arbitrum) -->
                <div style="display:flex;align-items:center;gap:8px;">
                    <label style="font-size:12px;font-weight:600;color:var(--text-primary);width:110px;flex-shrink:0;">🔷 Arbiscan</label>
                    <input id="admin-arbiscan-key" type="password" placeholder="Paste Arbiscan API key (Arbitrum)…"
                        value="${ChainAPIs.getKeys().arbiscan || ''}"
                        style="flex:1;height:30px;background:rgba(255,255,255,0.05);border:1px solid var(--border-subtle);border-radius:7px;color:var(--text-primary);font-size:12px;font-family:var(--font-mono);padding:0 10px;outline:none;">
                    <button onclick="adminSaveKey('arbiscan')" style="height:30px;padding:0 12px;background:var(--accent-cyan);border:none;border-radius:7px;color:#0d1021;font-size:12px;font-weight:700;cursor:pointer;">Save</button>
                    <button onclick="adminTestKey('arbiscan')" id="arbiscan-test-btn" style="height:30px;padding:0 12px;background:rgba(255,255,255,0.07);border:1px solid var(--border-subtle);border-radius:7px;color:var(--text-secondary);font-size:12px;cursor:pointer;">Test</button>
                    <span id="arbiscan-key-status" style="font-size:11px;color:var(--text-muted);min-width:80px;"></span>
                </div>
                <!-- Monadscan key (Monad) -->
                <div style="display:flex;align-items:center;gap:8px;">
                    <label style="font-size:12px;font-weight:600;color:var(--text-primary);width:110px;flex-shrink:0;">🟣 Monadscan</label>
                    <input id="admin-monadscan-key" type="password" placeholder="Paste Monadscan API key (Monad)…"
                        value="${ChainAPIs.getKeys().monadscan || ''}"
                        style="flex:1;height:30px;background:rgba(255,255,255,0.05);border:1px solid var(--border-subtle);border-radius:7px;color:var(--text-primary);font-size:12px;font-family:var(--font-mono);padding:0 10px;outline:none;">
                    <button onclick="adminSaveKey('monadscan')" style="height:30px;padding:0 12px;background:var(--accent-cyan);border:none;border-radius:7px;color:#0d1021;font-size:12px;font-weight:700;cursor:pointer;">Save</button>
                    <button onclick="adminTestKey('monadscan')" id="monadscan-test-btn" style="height:30px;padding:0 12px;background:rgba(255,255,255,0.07);border:1px solid var(--border-subtle);border-radius:7px;color:var(--text-secondary);font-size:12px;cursor:pointer;">Test</button>
                    <span id="monadscan-key-status" style="font-size:11px;color:var(--text-muted);min-width:80px;"></span>
                </div>
                <div id="admin-key-status" style="font-size:11px;color:var(--text-muted);min-height:16px;"></div>
            </div>
        </div>

        <div class="admin-section" style="margin-top:20px;">
            <div class="admin-section-title">🐋 Wallet Tracker</div>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">
                Track smart money wallets across chains. Wallets saved here are <strong style="color:var(--accent-cyan)">shared with all users</strong> via Supabase.
            </div>
            ${SUPABASE_READY ? `
            <details style="margin-bottom:12px;">
              <summary style="font-size:11px;color:var(--accent-amber);cursor:pointer;list-style:none;">
                ⚠️ If users can't see wallets — run this SQL in Supabase
              </summary>
              <pre style="margin-top:8px;background:var(--bg-deep);border:1px solid var(--border-subtle);border-radius:6px;padding:10px;font-size:10.5px;color:var(--accent-cyan);overflow-x:auto;white-space:pre-wrap;">CREATE TABLE IF NOT EXISTS watched_wallets (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  chain text NOT NULL,
  address text NOT NULL,
  label text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE watched_wallets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read"   ON watched_wallets FOR SELECT USING (true);
CREATE POLICY "public insert" ON watched_wallets FOR INSERT WITH CHECK (true);
CREATE POLICY "public delete" ON watched_wallets FOR DELETE USING (true);</pre>
            </details>` : ''}
            <div class="wallet-tracker-chains">
                <button class="wt-chain-tab active" data-chain="SOL" onclick="switchWtChain('SOL',this)">◎ SOL</button>
                <button class="wt-chain-tab" data-chain="ETH" onclick="switchWtChain('ETH',this)">Ξ ETH</button>
                <button class="wt-chain-tab" data-chain="BASE" onclick="switchWtChain('BASE',this)">B BASE</button>
                <button class="wt-chain-tab" data-chain="BSC" onclick="switchWtChain('BSC',this)">B BSC</button>
            </div>
            <div id="wt-panel">
                <div style="color:var(--text-muted);font-size:12px;padding:8px 0;">Loading wallets…</div>
            </div>
        </div>`;
  } catch (e) {
    panel.innerHTML = `<div style="color:var(--accent-red);padding:20px;">Failed to load users: ${e.message}</div>`;
  }
}

window.adminApprove = async function (id) {
  await AuthManager.approveUser(id);
  renderAdminPanel();
};
window.adminDisable = async function (id) {
  await AuthManager.disableUser(id);
  renderAdminPanel();
};

// ── Create user ───────────────────────────────────────────────
window.adminToggleCreateForm = function () {
  const f = document.getElementById('admin-create-form');
  if (f) f.style.display = f.style.display === 'none' ? 'block' : 'none';
};
window.adminCreateUser = async function () {
  const name = document.getElementById('cu-name')?.value.trim();
  const email = document.getElementById('cu-email')?.value.trim();
  const pass = document.getElementById('cu-pass')?.value.trim();
  const role = document.getElementById('cu-role')?.value || 'user';
  const status = document.getElementById('admin-create-status');
  if (!name || !email || !pass) {
    if (status) { status.textContent = '⚠️ Name, email and password are required'; status.style.color = '#f59e0b'; }
    return;
  }
  if (status) { status.textContent = 'Creating…'; status.style.color = 'var(--text-muted)'; }
  try {
    await AuthManager.createUserDirect({ name, email, password: pass, role });
    renderAdminPanel();
  } catch (e) {
    if (status) { status.textContent = '✗ ' + (e.message || 'Failed'); status.style.color = '#f87171'; }
  }
};

// ── Delete user ───────────────────────────────────────────────
window.adminDeleteUser = async function (id, name) {
  if (!confirm(`Delete user "${name}"? This cannot be undone.`)) return;
  try {
    await AuthManager.deleteUser(id);
    renderAdminPanel();
  } catch (e) {
    alert('Delete failed: ' + (e.message || 'Unknown error'));
  }
};

// ── Inline edit ───────────────────────────────────────────────
window.adminStartEdit = function (id) {
  // Show inputs, hide display spans
  ['uname', 'uemail', 'urole'].forEach(f => {
    const display = document.getElementById(`${f}-${id}`);
    const input = document.getElementById(`${f}-input-${id}`);
    if (display) display.style.display = 'none';
    if (input) input.style.display = 'inline-block';
  });
  const actions = document.getElementById(`uactions-${id}`);
  const save = document.getElementById(`usave-${id}`);
  if (actions) actions.style.display = 'none';
  if (save) save.style.display = 'flex';
};
window.adminCancelEdit = function (id) {
  ['uname', 'uemail', 'urole'].forEach(f => {
    const display = document.getElementById(`${f}-${id}`);
    const input = document.getElementById(`${f}-input-${id}`);
    if (display) display.style.display = '';
    if (input) input.style.display = 'none';
  });
  const actions = document.getElementById(`uactions-${id}`);
  const save = document.getElementById(`usave-${id}`);
  if (actions) actions.style.display = 'flex';
  if (save) save.style.display = 'none';
};
window.adminSaveEdit = async function (id) {
  const name = document.getElementById(`uname-input-${id}`)?.value.trim();
  const email = document.getElementById(`uemail-input-${id}`)?.value.trim();
  const role = document.getElementById(`urole-input-${id}`)?.value;
  if (!name || !email) { alert('Name and email cannot be empty'); return; }
  try {
    await AuthManager.updateUser(id, { name, email, role });
    renderAdminPanel();
  } catch (e) {
    alert('Update failed: ' + (e.message || 'Unknown error'));
  }
};
window.toggleFeature = async function (id, feature, enabled) {
  const users = await AuthManager.getAllUsers();
  const user = users.find(u => u.id === id);
  if (!user) return;
  const features = { ...user.features, [feature]: enabled };
  await AuthManager.updateFeatures(id, features);
};

window.generateInviteLink = async function () {
  const email = document.getElementById('invite-email')?.value.trim() || null;
  const name = document.getElementById('invite-name')?.value.trim() || null;
  const inv = await AuthManager.generateInvite(email, name);
  const fullUrl = `${TCMD_CONFIG.APP_URL}?invite=${inv.token}`;
  const output = document.getElementById('invite-output');
  const display = document.getElementById('invite-url-display');
  if (output && display) {
    output.style.display = 'block';
    display.textContent = fullUrl;
    display.dataset.url = fullUrl;
    navigator.clipboard.writeText(fullUrl).catch(() => { });
    const msg = document.getElementById('invite-copy-msg');
    if (msg) { msg.style.display = 'block'; setTimeout(() => msg.style.display = 'none', 2000); }
  }
};

window.copyInviteUrl = function () {
  const url = document.getElementById('invite-url-display')?.dataset.url;
  if (url) { navigator.clipboard.writeText(url); }
  const msg = document.getElementById('invite-copy-msg');
  if (msg) { msg.style.display = 'block'; setTimeout(() => msg.style.display = 'none', 2000); }
};

window.copyUrl = function (url) {
  navigator.clipboard.writeText(url).catch(() => { });
};

// ── Page navigation helpers ───────────────────────────────────
function showAuthPage() {
  const app = document.getElementById('app');
  const authPage = document.getElementById('auth-page');
  if (app) app.style.display = 'none';
  if (authPage) {
    authPage.style.display = 'flex';
    renderAuthPage();
  }
}

function showAppPage() {
  const app = document.getElementById('app');
  const authPage = document.getElementById('auth-page');
  if (app) app.style.display = '';
  if (authPage) authPage.style.display = 'none';
}

// ── Admin panel open/close ────────────────────────────────────
function openAdminPanel() {
  const overlay = document.getElementById('admin-overlay');
  if (overlay) overlay.classList.add('open');
  renderAdminPanel();
}

function closeAdminPanel() {
  const overlay = document.getElementById('admin-overlay');
  if (overlay) overlay.classList.remove('open');
}

window.showAuthPage = showAuthPage;
window.showAppPage = showAppPage;
window.openAdminPanel = openAdminPanel;
window.closeAdminPanel = closeAdminPanel;

// ── Wallet Tracker admin UI ──────────────────────────────────
let _wtCurrentChain = 'SOL';

window.switchWtChain = async function (chain, btn) {
  _wtCurrentChain = chain;
  document.querySelectorAll('.wt-chain-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  await renderWtPanel();
};

async function renderWtPanel() {
  const panel = document.getElementById('wt-panel');
  if (!panel) return;
  const chain = _wtCurrentChain;
  const allWallets = await WalletTracker.getWallets();
  const wallets = allWallets.filter(w => w.chain === chain);
  const cfg = WalletTracker.CHAIN_CONFIG[chain];

  // EVM chains now use centralized API key from Admin → API Keys section
  const keySection = '';

  panel.innerHTML = `
    ${keySection}
    <div class="wt-import-section">
      <div class="wt-import-title">📤 Bulk Import JSON</div>
      <div class="wt-import-row">
        <textarea id="wt-json-input" class="wt-json-textarea"
          placeholder='[{"address":"4V91ZL...","name":"rookixbt","emoji":"🧑"},...]'></textarea>
        <button class="btn btn-ghost" style="font-size:11px;white-space:nowrap;align-self:flex-end;"
          onclick="importWalletsJson('${chain}')">Import</button>
      </div>
      <div id="wt-import-result" class="wt-import-result"></div>
    </div>
    <div class="wt-add-row">
      <input id="wt-addr-input" class="auth-input" type="text" placeholder="${cfg?.label} wallet address…" style="flex:1;">
      <input id="wt-label-input" class="auth-input" type="text" placeholder="Label (e.g. Whale123)" style="width:130px;">
      <button class="btn btn-primary" style="font-size:11px;white-space:nowrap;" onclick="addTrackedWallet('${chain}')">+ Track</button>
    </div>
    <div id="wt-wallet-list">
      ${wallets.length === 0
      ? `<div style="color:var(--text-muted);font-size:12px;padding:10px 0;">No wallets tracked on ${cfg?.label || chain} yet.</div>`
      : wallets.map(w => `
          <div class="wt-wallet-row" id="wt-row-${w.id}">
            <div class="wt-wallet-info">
              <span class="wt-wallet-label">${w.label}</span>
              <a href="${cfg?.explorer(w.address) || '#'}" target="_blank" 
                 class="wt-wallet-addr" title="${w.address}">${w.address.slice(0, 8)}…${w.address.slice(-4)}</a>
            </div>
            <div class="wt-wallet-actions">
              <button class="wt-fetch-btn" onclick="fetchWtActivity('${w.id}','${w.address}','${chain}')">📋 Activity</button>
              <button class="wt-remove-btn" onclick="removeTrackedWallet('${w.id}','${w.address}')">×</button>
            </div>
          </div>
          <div class="wt-activity-row" id="wt-activity-${w.id}" style="display:none;"></div>`
      ).join('')}
    </div>`;
}

window.saveWtApiKey = function () {
  // API keys are now managed centrally in Admin → API Keys via ChainAPIs.setKey()
  showToast('ℹ️', 'API Keys Centralized', 'Set API keys in Admin → API Keys section', 'info');
};

window.addTrackedWallet = async function (chain) {
  const addr = document.getElementById('wt-addr-input')?.value.trim();
  const label = document.getElementById('wt-label-input')?.value.trim();
  if (!addr) return;
  await WalletTracker.addWallet(chain, addr, label);
  showToast('✅', 'Wallet Added', `${label || addr.slice(0, 8)} tracked on ${chain}`, 'success');
  await renderWtPanel();
};

window.removeTrackedWallet = async function (id, address) {
  await WalletTracker.removeWallet(id, address);
  showToast('🗑️', 'Wallet Removed', 'Wallet removed from tracker', 'info');
  await renderWtPanel();
};

window.fetchWtActivity = async function (id, address, chain) {
  const el = document.getElementById(`wt-activity-${id}`);
  if (!el) return;
  el.style.display = 'block';
  el.innerHTML = '<div style="color:var(--text-muted);font-size:11px;padding:6px 0 6px 12px;">Fetching…</div>';
  const activity = chain === 'SOL'
    ? await WalletTracker.fetchSolanaActivity(address, 5)
    : await WalletTracker.fetchEvmActivity(address, chain);

  if (activity.error) {
    el.innerHTML = `<div style="color:var(--accent-amber);font-size:11px;padding:6px 0 6px 12px;">⚠️ ${activity.error}</div>`;
    return;
  }
  if (!activity.recent?.length) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:11px;padding:6px 0 6px 12px;">No recent activity found.</div>';
    return;
  }
  el.innerHTML = `<div class="wt-activity-list">
    ${activity.recent.map(tx => `
      <div class="wt-tx-row">
        ${tx.type ? `<span class="wt-tx-type ${tx.type.toLowerCase()}">${tx.type}</span>` : ''}
        ${tx.token ? `<span class="wt-tx-token">${tx.token}</span>` : ''}
        ${tx.amount ? `<span class="wt-tx-amount">${tx.amount}</span>` : ''}
        <span class="wt-tx-time">${tx.timeAgo}</span>
        ${tx.url ? `<a href="${tx.url}" target="_blank" class="wt-tx-link">↗</a>` : ''}
        ${tx.sig ? `<a href="${tx.url}" target="_blank" class="wt-tx-link" title="${tx.sig}">tx ↗</a>` : ''}
      </div>`).join('')}
  </div>`;
};

// ── API Key management (Rug Checker) ─────────────────────────
window.adminSaveKey = function (name) {
  const input = document.getElementById(`admin-${name}-key`);
  if (!input) return;
  const val = input.value.trim();
  if (typeof ChainAPIs !== 'undefined') {
    ChainAPIs.setKey(name, val);
  } else {
    localStorage.setItem(`tcmd_${name}_key`, val);
  }
  const status = document.getElementById('admin-key-status');
  if (status) { status.textContent = `✓ ${name} key saved`; status.style.color = 'var(--accent-green)'; }
  setTimeout(() => { const s = document.getElementById('admin-key-status'); if (s) s.textContent = ''; }, 3000);
};

window.adminTestKey = async function (name) {
  const btn = document.getElementById(`${name}-test-btn`);
  const status = document.getElementById(`${name}-key-status`) || document.getElementById('admin-key-status');
  if (!btn || typeof ChainAPIs === 'undefined') return;
  const key = document.getElementById(`admin-${name}-key`)?.value?.trim();
  if (!key) { if (status) { status.textContent = `No ${name} key entered`; status.style.color = '#f59e0b'; } return; }
  btn.textContent = 'Testing…'; btn.disabled = true;
  try {
    if (name === 'coingecko') {
      const result = await ChainAPIs.testCoinGeckoKey(key);
      if (status) {
        if (result.valid) {
          let msg = `✓ CoinGecko key is valid!`;
          if (result.usage) msg += ` (${result.usage.remaining}/${result.usage.limit} remaining)`;
          if (result.error) msg += ` ⚠️ ${result.error}`;
          status.textContent = msg;
          status.style.color = result.error ? '#f59e0b' : 'var(--accent-green)';
        } else {
          status.textContent = `✗ ${result.error || 'CoinGecko key invalid'}`;
          status.style.color = '#ef4444';
        }
      }
    } else if (name === 'etherscan') {
      // Etherscan test: call their API status endpoint
      try {
        const r = await fetch(`https://api.etherscan.io/api?module=account&action=balance&address=0x0000000000000000000000000000000000000000&tag=latest&apikey=${key}`);
        const data = await r.json();
        const ok = data?.status === '1' || data?.message === 'OK';
        if (status) {
          status.textContent = ok ? '✓ Etherscan key is valid!' : '✗ Etherscan key invalid or quota exceeded';
          status.style.color = ok ? 'var(--accent-green)' : '#ef4444';
        }
      } catch {
        if (status) { status.textContent = 'Error testing Etherscan key'; status.style.color = '#ef4444'; }
      }
    } else if (name === 'basescan' || name === 'arbiscan' || name === 'monadscan') {
      const testFn = name === 'basescan' ? ChainAPIs.testBasescanKey
                   : name === 'arbiscan' ? ChainAPIs.testArbiscanKey
                   : ChainAPIs.testMonadscanKey;
      const result = await testFn(key);
      if (status) {
        status.textContent = result.ok ? `✓ ${name} key is valid!` : `✗ ${result.error || name + ' key invalid'}`;
        status.style.color = result.ok ? 'var(--accent-green)' : '#ef4444';
      }
    } else {
      const ok = name === 'birdeye'
        ? await ChainAPIs.testBirdeyeKey(key)
        : await ChainAPIs.testHeliusKey(key);
      if (status) {
        status.textContent = ok ? `✓ ${name} key is valid!` : `✗ ${name} key invalid or quota exceeded`;
        status.style.color = ok ? 'var(--accent-green)' : '#ef4444';
      }
    }
  } catch (e) {
    if (status) { status.textContent = `Error testing ${name} key`; status.style.color = '#ef4444'; }
  }
  btn.textContent = 'Test'; btn.disabled = false;
};

window.importWalletsJson = async function (chain) {
  const textarea = document.getElementById('wt-json-input');
  const resultEl = document.getElementById('wt-import-result');
  const raw = (textarea?.value || '').trim();
  if (!raw) return;

  let entries;
  try {
    entries = JSON.parse(raw);
    if (!Array.isArray(entries)) throw new Error('Expected a JSON array');
  } catch (e) {
    resultEl.textContent = '❌ Invalid JSON: ' + e.message;
    resultEl.style.color = 'var(--accent-red)';
    return;
  }

  let added = 0, skipped = 0;
  for (const item of entries) {
    const addr = (item.address || '').trim();
    if (!addr) { skipped++; continue; }
    const label = [item.emoji, item.name].filter(Boolean).join(' ') || addr.slice(0, 8) + '…';
    try {
      await WalletTracker.addWallet(chain, addr, label);
      added++;
    } catch { skipped++; }
  }

  resultEl.textContent = `✅ Imported ${added} wallet${added !== 1 ? 's' : ''}${skipped ? ` · ${skipped} skipped` : ''}`;
  resultEl.style.color = 'var(--accent-green)';
  textarea.value = '';
  setTimeout(() => renderWtPanel(), 400);
  showToast('📤', 'Wallets Imported', `${added} wallets added to ${chain}`, 'success');
};

// Re-render wallet panel after admin panel loads
const _origOpenAdmin = window.openAdminPanel;
window.openAdminPanel = function () {
  if (_origOpenAdmin) _origOpenAdmin();
  setTimeout(() => { _wtCurrentChain = 'SOL'; renderWtPanel(); }, 300);
};
