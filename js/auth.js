/* ============================================================
   T-CMD — Authentication System
   Backend: Supabase (with localStorage fallback if not configured)
   ============================================================ */

const AuthManager = (() => {
  const STORAGE_KEY = 'tcmd_auth'; // session only — always localStorage

  // ── Session (always local) ────────────────────────────────
  function getSession() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { return null; }
  }
  function setSession(user) {
    const session = {
      userId: user.id,
      role: user.role,
      name: user.name,
      email: user.email,
      features: user.features || { coinSignals: true, memeScanner: true, tradingLog: true }
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }
  function clearSession() { localStorage.removeItem(STORAGE_KEY); }

  // ── Public (sync — safe for UI guards) ───────────────────
  return {
    init() { /* no-op, SupabaseDB self-initialises */ },

    isLoggedIn() { return !!getSession(); },
    getUser() { return getSession(); },
    isAdmin() { const s = getSession(); return s?.role === 'admin'; },
    hasFeature(f) { const s = getSession(); return !!(s?.features?.[f]); },
    logout() { clearSession(); },

    // ── Async auth ─────────────────────────────────────────
    async login(email, password) {
      try {
        const user = await SupabaseDB.getUserByEmail(email);
        if (!user) return { success: false, error: 'Invalid email or password.' };
        if (user.password !== password) return { success: false, error: 'Invalid email or password.' };
        if (user.status === 'pending') return { success: false, error: 'pending', msg: 'Your account is awaiting admin approval.' };
        if (user.status === 'disabled') return { success: false, error: 'Account is suspended. Contact admin.' };
        setSession(user);
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

    async register(name, email) {
      try {
        const user = await SupabaseDB.createUser({
          email, name, password: 'passkey',
          role: 'user', status: 'pending'
        });
        return { success: true, user };
      } catch (e) {
        return { success: false, error: e.message || 'Registration failed.' };
      }
    },

    // ── Admin helpers (async) ──────────────────────────────
    async getAllUsers() { return SupabaseDB.getAllUsers(); },
    async approveUser(id) { return SupabaseDB.updateUser(id, { status: 'active', features: { coinSignals: true, memeScanner: true, tradingLog: true } }); },
    async disableUser(id) { return SupabaseDB.updateUser(id, { status: 'disabled' }); },
    async updateFeatures(id, features) { return SupabaseDB.updateUser(id, { features }); },

    // ── Invite helpers ────────────────────────────────────
    async generateInvite(email = null, name = null) {
      const session = getSession();
      return SupabaseDB.createInvite({ email, name, createdBy: session?.userId || null });
    },
    async getAllInvites() { return SupabaseDB.getAllInvites(); },

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
  const modeBadge = SUPABASE_READY
    ? ''
    : `<div class="demo-mode-badge">⚠️ Demo Mode (localStorage) — <a href="js/config.js" target="_blank">Configure Supabase</a></div>`;
  return `
    <div class="auth-container">
        <div class="auth-logo">
            <div class="auth-logo-icon">⚡</div>
            <div class="auth-logo-name">T-CMD</div>
            <div class="auth-logo-sub">Trade Command</div>
        </div>
        ${modeBadge}
        <div class="auth-card" id="auth-card">
            <div class="auth-tabs">
                <button class="auth-tab active" id="tab-login" onclick="switchAuthTab('login')">Sign In</button>
                <button class="auth-tab" id="tab-register" onclick="switchAuthTab('register')">Request Access</button>
            </div>

            <!-- Login form -->
            <div id="auth-login-form">
                <div class="auth-field">
                    <label class="auth-label">Email</label>
                    <input class="auth-input" type="email" id="auth-email" placeholder="you@example.com" autocomplete="email">
                </div>
                <div class="auth-field">
                    <label class="auth-label">Password</label>
                    <input class="auth-input" type="password" id="auth-password" placeholder="••••••••" autocomplete="current-password">
                </div>
                <div class="auth-error" id="auth-error" style="display:none;"></div>
                <button class="btn btn-primary auth-btn" id="auth-submit" onclick="handleLogin()">
                    <span id="auth-btn-text">Sign In</span>
                </button>
                <div class="auth-divider"><span>or</span></div>
                <button class="btn btn-outline auth-btn" onclick="handlePasskeyLogin()" style="gap:8px;">
                    🔑 Sign In with Passkey
                </button>
            </div>

            <!-- Register form -->
            <div id="auth-register-form" style="display:none;">
                <div class="auth-field">
                    <label class="auth-label">Full Name</label>
                    <input class="auth-input" type="text" id="reg-name" placeholder="Your name">
                </div>
                <div class="auth-field">
                    <label class="auth-label">Email</label>
                    <input class="auth-input" type="email" id="reg-email" placeholder="you@example.com">
                </div>
                <div class="auth-error" id="reg-error" style="display:none;"></div>
                <button class="btn btn-primary auth-btn" onclick="handleRegister()">
                    <span>Request Access</span>
                </button>
                <p class="auth-hint">Your request will be reviewed by an admin before you can log in.</p>
            </div>
        </div>
    </div>`;
}

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
  const errorEl = document.getElementById('reg-error');
  if (!name || !email) { showAuthError(errorEl, 'Please fill in all fields.'); return; }

  const result = await AuthManager.register(name, email);
  if (result.success) {
    document.getElementById('auth-register-form').innerHTML = `
            <div style="text-align:center;padding:20px 0;">
                <div style="font-size:36px;">✅</div>
                <h3 style="color:var(--accent-green);margin:12px 0 6px;">Request Submitted!</h3>
                <p style="color:var(--text-muted);font-size:13px;">An admin will review your request and activate your account. Come back soon!</p>
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
  const panel = document.getElementById('admin-panel-content');
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
            <div class="admin-section-title">👥 Users (${users.length})</div>
            <table class="admin-user-table">
                <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Features</th><th>Actions</th></tr></thead>
                <tbody>${users.map(u => `
                <tr class="${u.status === 'pending' ? 'admin-row-pending' : ''}">
                    <td><strong>${u.name}</strong></td>
                    <td style="font-size:11.5px;color:var(--text-muted);">${u.email}</td>
                    <td><span class="role-badge role-${u.role}">${u.role}</span></td>
                    <td><span class="status-badge status-${u.status}">${u.status}</span></td>
                    <td>
                        <div style="display:flex;gap:4px;flex-wrap:wrap;">
                            ${['coinSignals', 'memeScanner', 'tradingLog'].map(f => `
                            <label class="feat-toggle" title="${f}">
                                <input type="checkbox" ${u.features?.[f] ? 'checked' : ''} onchange="toggleFeature('${u.id}','${f}',this.checked)" ${u.id === currentUser?.userId ? 'disabled' : ''}>
                                <span>${f === 'coinSignals' ? '📡' : f === 'memeScanner' ? '🔍' : '📋'}</span>
                            </label>`).join('')}
                        </div>
                    </td>
                    <td>
                        <div style="display:flex;gap:4px;">
                            ${u.status !== 'active' && u.id !== currentUser?.userId ? `<button class="admin-btn approve" onclick="adminApprove('${u.id}')">✓ Approve</button>` : ''}
                            ${u.status !== 'disabled' && u.id !== currentUser?.userId ? `<button class="admin-btn disable" onclick="adminDisable('${u.id}')">⊘ Disable</button>` : ''}
                            ${u.id === currentUser?.userId ? `<span style="color:var(--text-muted);font-size:11px;">You</span>` : ''}
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
