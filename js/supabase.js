/* ============================================================
   T-CMD — Supabase Database Client
   Wraps all DB operations. Falls back to localStorage if
   Supabase is not configured (SUPABASE_READY === false).
   ============================================================ */

const SupabaseDB = (() => {
    // ── Supabase REST helpers ─────────────────────────────────
    const headers = () => ({
        'Content-Type': 'application/json',
        'apikey': TCMD_CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${TCMD_CONFIG.SUPABASE_ANON_KEY}`,
        'Prefer': 'return=representation'
    });

    const url = (table, query = '') =>
        `${TCMD_CONFIG.SUPABASE_URL}/rest/v1/${table}${query ? '?' + query : ''}`;

    async function sbGet(table, query) {
        const r = await fetch(url(table, query), { headers: headers() });
        if (!r.ok) throw new Error(`Supabase GET ${table} failed: ${r.status}`);
        return r.json();
    }

    async function sbPost(table, body) {
        const r = await fetch(url(table), {
            method: 'POST', headers: headers(), body: JSON.stringify(body)
        });
        if (!r.ok) { const e = await r.text(); throw new Error(e); }
        const data = await r.json();
        return Array.isArray(data) ? data[0] : data;
    }

    async function sbPatch(table, query, body) {
        const r = await fetch(url(table, query), {
            method: 'PATCH', headers: headers(), body: JSON.stringify(body)
        });
        if (!r.ok) throw new Error(`Supabase PATCH ${table} failed: ${r.status}`);
        const data = await r.json();
        return Array.isArray(data) ? data[0] : data;
    }

    async function sbDelete(table, query) {
        const r = await fetch(url(table, query), { method: 'DELETE', headers: headers() });
        if (!r.ok) throw new Error(`Supabase DELETE ${table} failed: ${r.status}`);
    }

    // Upsert using Supabase's conflict resolution (ON CONFLICT DO UPDATE)
    async function sbUpsert(table, body, onConflict) {
        const q = onConflict ? `on_conflict=${encodeURIComponent(onConflict)}` : '';
        const hdrs = { ...headers(), 'Prefer': 'resolution=merge-duplicates,return=representation' };
        const r = await fetch(url(table, q), {
            method: 'POST', headers: hdrs, body: JSON.stringify(body)
        });
        if (!r.ok) { const e = await r.text(); throw new Error(e); }
        const data = await r.json();
        return Array.isArray(data) ? data[0] : data;
    }

    // ── localStorage fallback helpers ─────────────────────────
    const LS_USERS = 'tcmd_users';
    const LS_INVITES = 'tcmd_invites';

    const DEFAULT_USERS = [
        {
            id: 'admin-001', email: 'admin@t-cmd.app', name: 'Admin', password: 'admin123',
            role: 'admin', status: 'active',
            features: { coinSignals: true, memeScanner: true, tradingLog: true, whalesWallets: true, taxCalculator: true },
            created_at: '2025-01-01T00:00:00Z'
        },
        {
            id: 'user-001', email: 'demo@t-cmd.app', name: 'Demo Trader', password: 'demo123',
            role: 'user', status: 'active',
            features: { coinSignals: true, memeScanner: true, tradingLog: true, whalesWallets: false, taxCalculator: false },
            created_at: '2025-02-01T00:00:00Z'
        }
    ];

    function lsUsers() {
        const raw = localStorage.getItem(LS_USERS);
        if (!raw) { localStorage.setItem(LS_USERS, JSON.stringify(DEFAULT_USERS)); return DEFAULT_USERS; }
        return JSON.parse(raw);
    }
    function lsSaveUsers(u) { localStorage.setItem(LS_USERS, JSON.stringify(u)); }
    function lsInvites() { return JSON.parse(localStorage.getItem(LS_INVITES) || '[]'); }
    function lsSaveInvites(v) { localStorage.setItem(LS_INVITES, JSON.stringify(v)); }

    function lsGenToken() {
        return Array.from(crypto.getRandomValues(new Uint8Array(16)))
            .map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // ── Helper: get current user ID (scopes all per-user data) ───
    // Session is stored as { userId, role, name, email, ... }
    // so we read .userId — never .id (which is undefined on the session).
    function _uid() {
        try { return AuthManager.getUser()?.userId || 'anon'; } catch { return 'anon'; }
    }

    // ── Public API ────────────────────────────────────────────
    return {
        // Expose user ID so TaxEngine / WalletTracker can scope caches
        getCurrentUserId() { return _uid(); },

        // ── Users ─────────────────────────────────────
        async getUserByEmail(email) {
            if (!SUPABASE_READY) {
                return lsUsers().find(u => u.email.toLowerCase() === email.toLowerCase()) || null;
            }
            const rows = await sbGet('users', `email=eq.${encodeURIComponent(email)}&limit=1`);
            return rows[0] || null;
        },

        async getAllUsers() {
            if (!SUPABASE_READY) return lsUsers();
            return sbGet('users', 'order=created_at.asc');
        },

        async createUser({ email, name, password, role = 'user', status = 'pending', features }) {
            const defaultFeatures = features || { coinSignals: false, memeScanner: false, tradingLog: false };
            if (!SUPABASE_READY) {
                const users = lsUsers();
                if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
                    throw new Error('Email already registered.');
                }
                const u = {
                    id: 'user-' + Date.now(), email, name, password, role, status,
                    features: defaultFeatures, created_at: new Date().toISOString()
                };
                users.push(u);
                lsSaveUsers(users);
                return u;
            }
            const existing = await sbGet('users', `email=eq.${encodeURIComponent(email)}&limit=1`);
            if (existing.length) throw new Error('Email already registered.');
            return sbPost('users', { email, name, password, role, status, features: defaultFeatures });
        },

        async updateUser(id, data) {
            if (!SUPABASE_READY) {
                const users = lsUsers();
                const idx = users.findIndex(u => u.id === id);
                if (idx === -1) throw new Error('User not found');
                users[idx] = { ...users[idx], ...data };
                lsSaveUsers(users);
                return users[idx];
            }
            return sbPatch('users', `id=eq.${id}`, data);
        },

        async deleteUser(id) {
            if (!SUPABASE_READY) {
                const users = lsUsers().filter(u => u.id !== id);
                lsSaveUsers(users);
                return;
            }
            await sbDelete('users', `id=eq.${id}`);
        },

        // ── Invites ───────────────────────────────────
        async createInvite({ email = null, name = null, createdBy = null }) {
            const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
            if (!SUPABASE_READY) {
                const token = lsGenToken();
                const inv = {
                    id: 'inv-' + Date.now(), token, email, name,
                    created_by: createdBy, used_at: null, expires_at: expiresAt,
                    created_at: new Date().toISOString()
                };
                const invites = lsInvites();
                invites.push(inv);
                lsSaveInvites(invites);
                return inv;
            }
            return sbPost('invites', { email, name, created_by: createdBy, expires_at: expiresAt });
        },

        async getInvite(token) {
            if (!SUPABASE_READY) {
                return lsInvites().find(i => i.token === token) || null;
            }
            const rows = await sbGet('invites', `token=eq.${token}&limit=1`);
            return rows[0] || null;
        },

        async markInviteUsed(token) {
            const now = new Date().toISOString();
            if (!SUPABASE_READY) {
                const invites = lsInvites();
                const idx = invites.findIndex(i => i.token === token);
                if (idx !== -1) { invites[idx].used_at = now; lsSaveInvites(invites); }
                return;
            }
            await sbPatch('invites', `token=eq.${token}`, { used_at: now });
        },

        async getAllInvites(createdBy = null) {
            if (!SUPABASE_READY) {
                const all = lsInvites();
                return createdBy ? all.filter(i => i.created_by === createdBy) : all;
            }
            const q = createdBy
                ? `created_by=eq.${createdBy}&order=created_at.desc`
                : 'order=created_at.desc';
            return sbGet('invites', q);
        },

        // ── Generic per-user key-value store ──────────────────
        // Backed by the user_data Supabase table (user_id, key, value jsonb).
        // Falls back to user-scoped localStorage when Supabase is unavailable.
        async getUserData(key, fallback = null) {
            const userId = _uid();
            if (!SUPABASE_READY) {
                try { return JSON.parse(localStorage.getItem(`tcmd_${userId}_${key}`) || 'null') ?? fallback; }
                catch { return fallback; }
            }
            try {
                const rows = await sbGet('user_data', `user_id=eq.${userId}&key=eq.${encodeURIComponent(key)}&limit=1`);
                return rows[0]?.value ?? fallback;
            } catch { return fallback; }
        },

        async setUserData(key, value) {
            const userId = _uid();
            if (!SUPABASE_READY) {
                localStorage.setItem(`tcmd_${userId}_${key}`, JSON.stringify(value));
                return;
            }
            try {
                await sbUpsert('user_data', {
                    user_id: userId, key, value,
                    updated_at: new Date().toISOString()
                }, 'user_id,key');
            } catch (e) {
                console.warn('[SupabaseDB] setUserData failed, falling back to localStorage:', e.message);
                localStorage.setItem(`tcmd_${userId}_${key}`, JSON.stringify(value));
            }
        },

        // ── Watched Wallets (user-scoped — each wallet belongs to one user) ──
        // Required Supabase table: see supabase-schema.sql
        // user_id is REQUIRED on every row; RLS enforces it on writes.

        async getWallets() {
            const userId = _uid();
            if (!SUPABASE_READY) {
                // localStorage fallback: user-scoped key
                try { return JSON.parse(localStorage.getItem(`tcmd_wallets_${userId}`) || '[]'); }
                catch { return []; }
            }
            try {
                return await sbGet('watched_wallets', `user_id=eq.${userId}&order=created_at.desc`);
            } catch { return []; }
        },

        async addWallet({ chain, address, label }) {
            const userId = _uid();
            if (!SUPABASE_READY) {
                const wallets = JSON.parse(localStorage.getItem(`tcmd_wallets_${userId}`) || '[]');
                const entry = { id: Date.now().toString(), user_id: userId, chain, address, label, created_at: new Date().toISOString() };
                if (!wallets.find(w => w.address === address && w.chain === chain)) {
                    wallets.unshift(entry);
                    localStorage.setItem(`tcmd_wallets_${userId}`, JSON.stringify(wallets));
                }
                return entry;
            }
            try {
                return await sbPost('watched_wallets', { chain, address, label, user_id: userId });
            } catch { return null; }
        },

        async deleteWallet(id) {
            const userId = _uid();
            if (!SUPABASE_READY) {
                const wallets = JSON.parse(localStorage.getItem(`tcmd_wallets_${userId}`) || '[]')
                    .filter(w => w.id !== id);
                localStorage.setItem(`tcmd_wallets_${userId}`, JSON.stringify(wallets));
                return true;
            }
            try {
                // Include user_id in the predicate so a user can only delete their own wallets
                await sbDelete('watched_wallets', `id=eq.${id}&user_id=eq.${userId}`);
                return true;
            } catch { return false; }
        }
    };
})();
