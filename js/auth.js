/* ============================================================
   T-CMD — Authentication System (Mock Passkey / localStorage)
   ============================================================ */

const AuthManager = (() => {
  const STORAGE_KEY = 'tcmd_auth';
  const USERS_KEY = 'tcmd_users';

  // ── Default admin + demo user ──────────────────────────
  const DEFAULT_USERS = [
    {
      id: 'admin-001',
      email: 'admin@t-cmd.app',
      name: 'Admin',
      password: 'admin123',
      role: 'admin',
      status: 'active',
      features: { coinSignals: true, memeScanner: true, tradingLog: true },
      joined: '2025-01-01T00:00:00Z'
    },
    {
      id: 'user-001',
      email: 'demo@t-cmd.app',
      name: 'Demo Trader',
      password: 'demo123',
      role: 'user',
      status: 'active',
      features: { coinSignals: true, memeScanner: true, tradingLog: true },
      joined: '2025-02-01T00:00:00Z'
    }
  ];

  // ── Init users ─────────────────────────────────────────
  function initUsers() {
    if (!localStorage.getItem(USERS_KEY)) {
      localStorage.setItem(USERS_KEY, JSON.stringify(DEFAULT_USERS));
    }
  }

  function getUsers() {
    initUsers();
    return JSON.parse(localStorage.getItem(USERS_KEY)) || [];
  }

  function saveUsers(users) {
    localStorage.setItem(USERS_KEY, JSON.stringify(users));
  }

  // ── Session ────────────────────────────────────────────
  function getSession() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { return null; }
  }

  function setSession(user) {
    const session = { userId: user.id, role: user.role, name: user.name, email: user.email, features: user.features };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }

  function clearSession() {
    localStorage.removeItem(STORAGE_KEY);
  }

  // ── Public API ─────────────────────────────────────────
  return {
    init() { initUsers(); },

    isLoggedIn() { return !!getSession(); },

    getUser() { return getSession(); },

    isAdmin() { const s = getSession(); return s && s.role === 'admin'; },

    hasFeature(feature) {
      const s = getSession();
      return s && s.features && s.features[feature];
    },

    login(email, password) {
      const users = getUsers();
      const user = users.find(u => u.email.toLowerCase() === email.toLowerCase() && u.password === password);
      if (!user) return { success: false, error: 'Invalid email or password.' };
      if (user.status === 'pending') return { success: false, error: 'pending', msg: 'Your account is awaiting admin approval.' };
      if (user.status === 'disabled') return { success: false, error: 'Account is suspended. Contact admin.' };
      setSession(user);
      return { success: true, user };
    },

    loginWithPasskey(email) {
      // Simulate passkey — just find by email, mark as passkey login
      const users = getUsers();
      const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
      if (!user) return { success: false, error: 'No account found for this email.' };
      if (user.status === 'pending') return { success: false, error: 'pending' };
      setSession(user);
      return { success: true, user };
    },

    logout() { clearSession(); },

    register(name, email) {
      const users = getUsers();
      if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
        return { success: false, error: 'Email already registered.' };
      }
      const newUser = {
        id: 'user-' + Date.now(),
        email, name,
        password: 'passkey',
        role: 'user',
        status: 'pending',
        features: { coinSignals: false, memeScanner: false, tradingLog: false },
        joined: new Date().toISOString()
      };
      users.push(newUser);
      saveUsers(users);
      return { success: true, user: newUser };
    },

    // ── Admin functions ──────────────────────────────────

    getAllUsers() { return getUsers(); },

    approveUser(userId) {
      const users = getUsers();
      const idx = users.findIndex(u => u.id === userId);
      if (idx === -1) return false;
      users[idx].status = 'active';
      users[idx].features = { coinSignals: true, memeScanner: true, tradingLog: true };
      saveUsers(users);
      return true;
    },

    disableUser(userId) {
      const users = getUsers();
      const idx = users.findIndex(u => u.id === userId);
      if (idx === -1) return false;
      users[idx].status = 'disabled';
      saveUsers(users);
      return true;
    },

    deleteUser(userId) {
      let users = getUsers();
      users = users.filter(u => u.id !== userId);
      saveUsers(users);
    },

    inviteUser(email, name) {
      return this.register(name || email.split('@')[0], email);
    },

    toggleFeature(userId, feature) {
      const users = getUsers();
      const idx = users.findIndex(u => u.id === userId);
      if (idx === -1) return;
      users[idx].features[feature] = !users[idx].features[feature];
      saveUsers(users);
      // Update session if self
      const session = getSession();
      if (session && session.userId === userId) {
        session.features[feature] = users[idx].features[feature];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      }
    }
  };
})();

/* ── UI: Show Auth Page ─────────────────────────────────── */
function showAuthPage(view = 'login') {
  document.getElementById('app').style.display = 'none';
  const page = document.getElementById('auth-page');
  page.style.display = 'flex';
  renderAuthView(view);
}

function hideAuthPage() {
  document.getElementById('auth-page').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
}

function renderAuthView(view) {
  const page = document.getElementById('auth-page');

  if (view === 'login') {
    page.innerHTML = `
      <div class="auth-container">
        <div class="auth-logo">
          <div class="auth-logo-icon">T</div>
          <div>
            <div class="auth-logo-text">T-CMD</div>
            <div class="auth-logo-sub">Trade Command</div>
          </div>
        </div>
        <div class="auth-card">
          <div class="auth-title">Welcome back</div>
          <div class="auth-subtitle">Sign in to access your trading dashboard and AI signals.</div>

          <div class="form-group">
            <label class="form-label">Email</label>
            <input class="form-input" type="email" id="login-email" placeholder="you@example.com" autocomplete="email">
          </div>
          <div class="form-group">
            <label class="form-label">Password</label>
            <input class="form-input" type="password" id="login-password" placeholder="••••••••" autocomplete="current-password">
          </div>
          <div id="login-error" style="color:var(--accent-red);font-size:12.5px;margin-bottom:10px;display:none;"></div>
          <button class="btn btn-primary" style="width:100%;justify-content:center;padding:11px;" id="login-btn">Sign In</button>

          <div class="auth-divider">or</div>

          <button class="passkey-btn" id="passkey-login-btn">
            <span>🔐</span> Sign in with Passkey
          </button>

          <div class="auth-switch">
            Don't have access? <span class="auth-switch-link" id="go-register">Request invite</span>
          </div>
          <a class="admin-login-link" id="go-admin-login">Admin access →</a>
        </div>
      </div>`;

    page.querySelector('#login-btn').addEventListener('click', () => doLogin());
    page.querySelector('#login-email').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
    page.querySelector('#login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
    page.querySelector('#go-register').addEventListener('click', () => renderAuthView('register'));
    page.querySelector('#go-admin-login').addEventListener('click', () => renderAuthView('admin-login'));
    page.querySelector('#passkey-login-btn').addEventListener('click', () => doPasskeyLogin());
    setTimeout(() => { page.querySelector('#login-email').focus(); }, 100);

  } else if (view === 'register') {
    page.innerHTML = `
      <div class="auth-container">
        <div class="auth-logo">
          <div class="auth-logo-icon">T</div>
          <div>
            <div class="auth-logo-text">T-CMD</div>
            <div class="auth-logo-sub">Trade Command</div>
          </div>
        </div>
        <div class="auth-card">
          <div class="auth-title">Request Access</div>
          <div class="auth-subtitle">Your account will require admin approval before you can log in.</div>
          <div class="form-group">
            <label class="form-label">Name</label>
            <input class="form-input" type="text" id="reg-name" placeholder="Your name">
          </div>
          <div class="form-group">
            <label class="form-label">Email</label>
            <input class="form-input" type="email" id="reg-email" placeholder="you@example.com">
          </div>
          <div id="reg-error" style="color:var(--accent-red);font-size:12.5px;margin-bottom:10px;display:none;"></div>
          <button class="btn btn-primary" style="width:100%;justify-content:center;padding:11px;" id="reg-btn">Submit Request</button>
          <div class="auth-switch">Already have access? <span class="auth-switch-link" id="back-login">Sign in</span></div>
        </div>
      </div>`;
    page.querySelector('#reg-btn').addEventListener('click', () => doRegister());
    page.querySelector('#back-login').addEventListener('click', () => renderAuthView('login'));

  } else if (view === 'pending') {
    page.innerHTML = `
      <div class="auth-container">
        <div class="auth-logo">
          <div class="auth-logo-icon">T</div>
          <div>
            <div class="auth-logo-text">T-CMD</div>
            <div class="auth-logo-sub">Trade Command</div>
          </div>
        </div>
        <div class="auth-card auth-pending">
          <div class="auth-pending-icon">⏳</div>
          <h3>Access Pending</h3>
          <p>Your request has been submitted. An admin will review and approve your account. You'll receive notification once approved.</p>
          <button class="btn btn-outline" style="margin-top:20px;" id="back-login-btn">Back to Sign In</button>
        </div>
      </div>`;
    page.querySelector('#back-login-btn').addEventListener('click', () => renderAuthView('login'));
  } else if (view === 'admin-login') {
    page.innerHTML = `
      <div class="auth-container">
        <div class="auth-logo">
          <div class="auth-logo-icon">T</div>
          <div>
            <div class="auth-logo-text">T-CMD</div>
            <div class="auth-logo-sub">Admin Access</div>
          </div>
        </div>
        <div class="auth-card">
          <div class="auth-title">Admin Sign In</div>
          <div class="auth-subtitle">Enter your administrator credentials to continue.</div>
          <div class="form-group">
            <label class="form-label">Email</label>
            <input class="form-input" type="email" id="adm-email" value="admin@t-cmd.app" autocomplete="email">
          </div>
          <div class="form-group">
            <label class="form-label">Password</label>
            <input class="form-input" type="password" id="adm-password" value="admin123" autocomplete="current-password">
          </div>
          <div id="adm-error" style="color:var(--accent-red);font-size:12.5px;margin-bottom:10px;display:none;"></div>
          <button class="btn btn-primary" style="width:100%;justify-content:center;padding:11px;" id="adm-btn">Sign In as Admin</button>
          <div class="auth-switch"><span class="auth-switch-link" id="back-to-login">← Back to login</span></div>
        </div>
      </div>`;
    page.querySelector('#adm-btn').addEventListener('click', () => {
      const email = page.querySelector('#adm-email').value;
      const pass = page.querySelector('#adm-password').value;
      const result = AuthManager.login(email, pass);
      if (result.success) { hideAuthPage(); App.init(); }
      else { const el = page.querySelector('#adm-error'); el.textContent = result.error || result.msg; el.style.display = 'block'; }
    });
    page.querySelector('#back-to-login').addEventListener('click', () => renderAuthView('login'));
  }
}

function doLogin() {
  const page = document.getElementById('auth-page');
  const email = page.querySelector('#login-email').value.trim();
  const password = page.querySelector('#login-password').value;
  const errEl = page.querySelector('#login-error');
  errEl.style.display = 'none';
  if (!email) { errEl.textContent = 'Please enter your email.'; errEl.style.display = 'block'; return; }
  const result = AuthManager.login(email, password);
  if (result.success) { hideAuthPage(); App.init(); }
  else if (result.error === 'pending') { renderAuthView('pending'); }
  else { errEl.textContent = result.error || result.msg; errEl.style.display = 'block'; }
}

function doPasskeyLogin() {
  const page = document.getElementById('auth-page');
  const email = page.querySelector('#login-email').value.trim();
  if (!email) { const errEl = page.querySelector('#login-error'); errEl.textContent = 'Enter your email first, then click Passkey.'; errEl.style.display = 'block'; return; }
  const result = AuthManager.loginWithPasskey(email);
  if (result.success) { hideAuthPage(); App.init(); }
  else if (result.error === 'pending') { renderAuthView('pending'); }
  else { const errEl = page.querySelector('#login-error'); errEl.textContent = result.error; errEl.style.display = 'block'; }
}

function doRegister() {
  const page = document.getElementById('auth-page');
  const name = page.querySelector('#reg-name').value.trim();
  const email = page.querySelector('#reg-email').value.trim();
  const errEl = page.querySelector('#reg-error');
  errEl.style.display = 'none';
  if (!name || !email) { errEl.textContent = 'Please fill in all fields.'; errEl.style.display = 'block'; return; }
  const result = AuthManager.register(name, email);
  if (result.success) { renderAuthView('pending'); }
  else { errEl.textContent = result.error; errEl.style.display = 'block'; }
}

/* ── Admin Panel ─────────────────────────────────────────── */
function openAdminPanel() {
  if (!AuthManager.isAdmin()) return;
  const overlay = document.getElementById('admin-overlay');
  overlay.classList.add('open');
  renderAdminPanel();
}

function closeAdminPanel() {
  document.getElementById('admin-overlay').classList.remove('open');
}

function renderAdminPanel() {
  const users = AuthManager.getAllUsers();
  const self = AuthManager.getUser();
  const tbody = document.getElementById('admin-users-tbody');

  tbody.innerHTML = users.map(u => {
    const isSelf = u.id === self.userId;
    const statusBadge = `<span class="user-status-badge status-${u.status}">${u.status}</span>`;
    const actions = isSelf ? '<em style="color:var(--text-muted);font-size:12px;">You</em>' : `
      ${u.status === 'pending' ? `<button class="btn btn-ghost" style="padding:4px 8px;font-size:11px;" onclick="adminApprove('${u.id}')">✅ Approve</button>` : ''}
      ${u.status === 'active' ? `<button class="btn btn-ghost" style="padding:4px 8px;font-size:11px;" onclick="adminDisable('${u.id}')">🚫 Disable</button>` : ''}
      <button class="btn btn-ghost" style="padding:4px 8px;font-size:11px;color:var(--accent-red);" onclick="adminDelete('${u.id}')">🗑</button>
    `;
    const features = ['coinSignals', 'memeScanner', 'tradingLog'].map(f => `
      <div style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-secondary);">
        <div class="feature-toggle ${u.features[f] ? 'on' : ''}" onclick="adminToggleFeature('${u.id}','${f}')"></div>
        ${f === 'coinSignals' ? 'Signals' : f === 'memeScanner' ? 'Scanner' : 'Log'}
      </div>`).join('');

    return `<tr>
      <td>${u.name}<br><span style="font-size:11px;color:var(--text-muted);">${u.email}</span></td>
      <td><span class="badge badge-neutral" style="font-size:11px;">${u.role}</span></td>
      <td>${statusBadge}</td>
      <td><div style="display:flex;gap:12px;flex-wrap:wrap;">${features}</div></td>
      <td>${actions}</td>
    </tr>`;
  }).join('');
}

window.adminApprove = (id) => { AuthManager.approveUser(id); renderAdminPanel(); showToast('✅', 'User Approved', 'User can now sign in.', 'success'); };
window.adminDisable = (id) => { AuthManager.disableUser(id); renderAdminPanel(); showToast('🚫', 'User Disabled', '', 'warning'); };
window.adminDelete = (id) => { AuthManager.deleteUser(id); renderAdminPanel(); showToast('🗑', 'User Deleted', '', 'warning'); };
window.adminToggleFeature = (id, feature) => { AuthManager.toggleFeature(id, feature); renderAdminPanel(); };
