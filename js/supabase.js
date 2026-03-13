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

    // Upsert — POST with on-conflict merge
    async function sbUpsert(table, body, onConflict = '') {
        const h = { ...headers(), 'Prefer': 'return=representation,resolution=merge-duplicates' };
        const q = onConflict ? `on_conflict=${onConflict}` : '';
        const r = await fetch(url(table, q), {
            method: 'POST', headers: h, body: JSON.stringify(body)
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

    // ── Helper: get current user ID ──────────────────────────
    // CRITICAL: the session object uses 'userId' (not 'id').
    // setSession() stores: { userId: user.id, role, name, email, features }
    // Reading .id returned undefined for every user → everyone resolved to 'anon'
    // → all users shared identical tcmd_anon_* localStorage keys and
    //   the same tcmd_tax_anon IndexedDB → cross-user data leakage.
    function _uid() {
        try { return AuthManager.getUser()?.userId || 'anon'; } catch { return 'anon'; }
    }

    // ── Public API ────────────────────────────────────────────
    return {

        // Returns the authenticated user's ID (or 'anon').
        // Exposed so other modules (e.g. tax-engine.js) can scope their
        // own storage (IndexedDB) per user without importing AuthManager directly.
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

        // ══════════════════════════════════════════════════════
        // PER-USER DATA (key-value store)
        // ══════════════════════════════════════════════════════

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

        // ══════════════════════════════════════════════════════
        // TRADING POSITIONS
        // ══════════════════════════════════════════════════════

        async getPositions() {
            const userId = _uid();
            if (!SUPABASE_READY) {
                try { return JSON.parse(localStorage.getItem(`tcmd_pos_${userId}`) || '[]'); } catch { return []; }
            }
            try {
                const rows = await sbGet('user_positions', `user_id=eq.${userId}&order=opened_at.desc`);
                return rows.map(r => ({
                    id: r.id, symbol: r.symbol, direction: r.direction,
                    entry: r.entry, stopLoss: r.stop_loss, takeProfit: r.take_profit,
                    size: r.size, rr: r.rr, fromSignalId: r.from_signal,
                    openedAt: r.opened_at, currentPrice: r.current_price
                }));
            } catch { return []; }
        },

        async savePositions(positions) {
            const userId = _uid();
            if (!SUPABASE_READY) {
                localStorage.setItem(`tcmd_pos_${userId}`, JSON.stringify(positions));
                return;
            }
            try {
                // Delete all then re-insert (simple sync)
                await sbDelete('user_positions', `user_id=eq.${userId}`);
                if (positions.length) {
                    for (const p of positions) {
                        await sbPost('user_positions', {
                            id: p.id, user_id: userId, symbol: p.symbol,
                            direction: p.direction, entry: p.entry,
                            stop_loss: p.stopLoss, take_profit: p.takeProfit,
                            size: p.size, rr: p.rr, from_signal: p.fromSignalId,
                            opened_at: p.openedAt, current_price: p.currentPrice
                        });
                    }
                }
            } catch (e) {
                console.warn('[SupabaseDB] savePositions failed:', e.message);
                localStorage.setItem(`tcmd_pos_${userId}`, JSON.stringify(positions));
            }
        },

        async getClosedPositions() {
            const userId = _uid();
            if (!SUPABASE_READY) {
                try { return JSON.parse(localStorage.getItem(`tcmd_closed_${userId}`) || '[]'); } catch { return []; }
            }
            try {
                const rows = await sbGet('user_closed_positions', `user_id=eq.${userId}&order=closed_at.desc&limit=200`);
                return rows.map(r => ({
                    id: r.id, symbol: r.symbol, direction: r.direction,
                    entry: r.entry, stopLoss: r.stop_loss, takeProfit: r.take_profit,
                    size: r.size, rr: r.rr, fromSignalId: r.from_signal,
                    openedAt: r.opened_at, closePrice: r.close_price,
                    pnlPct: r.pnl_pct, closedAt: r.closed_at
                }));
            } catch { return []; }
        },

        async saveClosedPosition(pos) {
            const userId = _uid();
            if (!SUPABASE_READY) {
                const closed = JSON.parse(localStorage.getItem(`tcmd_closed_${userId}`) || '[]');
                closed.unshift(pos);
                if (closed.length > 200) closed.splice(200);
                localStorage.setItem(`tcmd_closed_${userId}`, JSON.stringify(closed));
                return;
            }
            try {
                await sbPost('user_closed_positions', {
                    id: pos.id, user_id: userId, symbol: pos.symbol,
                    direction: pos.direction, entry: pos.entry,
                    stop_loss: pos.stopLoss, take_profit: pos.takeProfit,
                    size: pos.size, rr: pos.rr, from_signal: pos.fromSignalId,
                    opened_at: pos.openedAt, close_price: pos.closePrice,
                    pnl_pct: pos.pnlPct, closed_at: pos.closedAt
                });
            } catch (e) {
                console.warn('[SupabaseDB] saveClosedPosition failed:', e.message);
            }
        },

        // ══════════════════════════════════════════════════════
        // TAX ACCOUNTS
        // ══════════════════════════════════════════════════════

        async getTaxAccounts() {
            const userId = _uid();
            if (!SUPABASE_READY) {
                try { return JSON.parse(localStorage.getItem(`tcmd_tax_acc_${userId}`) || '[]'); } catch { return []; }
            }
            try {
                const rows = await sbGet('user_tax_accounts', `user_id=eq.${userId}&order=created_at.asc`);
                return rows.map(r => ({ id: r.id, type: r.type, label: r.label, address: r.address, chain: r.chain, ...r.data }));
            } catch { return []; }
        },

        async saveTaxAccount(acc) {
            const userId = _uid();
            if (!SUPABASE_READY) {
                const accs = JSON.parse(localStorage.getItem(`tcmd_tax_acc_${userId}`) || '[]');
                accs.push(acc);
                localStorage.setItem(`tcmd_tax_acc_${userId}`, JSON.stringify(accs));
                return;
            }
            try {
                const { id, type, label, address, chain, ...rest } = acc;
                await sbPost('user_tax_accounts', { id, user_id: userId, type, label, address, chain, data: rest });
            } catch (e) {
                console.warn('[SupabaseDB] saveTaxAccount failed:', e.message);
            }
        },

        async deleteTaxAccount(accountId) {
            const userId = _uid();
            if (!SUPABASE_READY) {
                const accs = JSON.parse(localStorage.getItem(`tcmd_tax_acc_${userId}`) || '[]')
                    .filter(a => a.id !== accountId);
                localStorage.setItem(`tcmd_tax_acc_${userId}`, JSON.stringify(accs));
                return;
            }
            try {
                await sbDelete('user_tax_accounts', `user_id=eq.${userId}&id=eq.${accountId}`);
            } catch (e) { console.warn('[SupabaseDB] deleteTaxAccount failed:', e.message); }
        },

        // ══════════════════════════════════════════════════════
        // TAX TRANSACTIONS (bulk)
        // ══════════════════════════════════════════════════════

        async getTaxTransactions() {
            const userId = _uid();
            if (!SUPABASE_READY) {
                try { return JSON.parse(localStorage.getItem(`tcmd_tax_txns_${userId}`) || '[]'); } catch { return []; }
            }
            try {
                const rows = await sbGet('user_tax_transactions', `user_id=eq.${userId}&order=created_at.asc`);
                return rows.map(r => ({ ...r.data, id: r.id, accountId: r.account_id }));
            } catch { return []; }
        },

        async saveTaxTransactions(txns) {
            const userId = _uid();
            if (!SUPABASE_READY) {
                localStorage.setItem(`tcmd_tax_txns_${userId}`, JSON.stringify(txns));
                return;
            }
            try {
                // Delete existing, then bulk insert
                await sbDelete('user_tax_transactions', `user_id=eq.${userId}`);
                // Batch insert in chunks of 50
                for (let i = 0; i < txns.length; i += 50) {
                    const chunk = txns.slice(i, i + 50).map(t => ({
                        id: t.id, user_id: userId, account_id: t.accountId,
                        data: t
                    }));
                    const r = await fetch(url('user_tax_transactions'), {
                        method: 'POST', headers: headers(),
                        body: JSON.stringify(chunk)
                    });
                    if (!r.ok) throw new Error(`Bulk insert failed: ${r.status}`);
                }
            } catch (e) {
                console.warn('[SupabaseDB] saveTaxTransactions failed:', e.message);
                localStorage.setItem(`tcmd_tax_txns_${userId}`, JSON.stringify(txns));
            }
        },

        async deleteTaxTransactionsByAccount(accountId) {
            const userId = _uid();
            if (!SUPABASE_READY) {
                const txns = JSON.parse(localStorage.getItem(`tcmd_tax_txns_${userId}`) || '[]')
                    .filter(t => t.accountId !== accountId);
                localStorage.setItem(`tcmd_tax_txns_${userId}`, JSON.stringify(txns));
                return;
            }
            try {
                await sbDelete('user_tax_transactions', `user_id=eq.${userId}&account_id=eq.${accountId}`);
            } catch (e) { console.warn('[SupabaseDB] deleteTaxTransactionsByAccount:', e.message); }
        },

        // ══════════════════════════════════════════════════════
        // CENTRALIZED API KEYS
        // ══════════════════════════════════════════════════════

        async getApiKeys() {
            // API keys are app-wide (admin-managed) when Supabase is live.
            // When falling back to localStorage the keys are stored per-user so one
            // user cannot read another user's manually entered dev keys.
            const userId = _uid();
            const K = window.TCMD_KEYS || {};
            if (!SUPABASE_READY) {
                return {
                    helius:    localStorage.getItem(`tcmd_${userId}_helius_key`)    || K.helius    || '',
                    birdeye:   localStorage.getItem(`tcmd_${userId}_birdeye_key`)   || K.birdeye   || '',
                    etherscan: localStorage.getItem(`tcmd_${userId}_etherscan_key`) || K.etherscan || '',
                };
            }
            try {
                const rows = await sbGet('api_keys');
                const keys = {};
                for (const r of rows) keys[r.name] = r.value || '';
                return {
                    helius:    keys.helius    || K.helius    || '',
                    birdeye:   keys.birdeye   || K.birdeye   || '',
                    etherscan: keys.etherscan || K.etherscan || '',
                };
            } catch {
                return {
                    helius:    localStorage.getItem(`tcmd_${userId}_helius_key`)    || K.helius    || '',
                    birdeye:   localStorage.getItem(`tcmd_${userId}_birdeye_key`)   || K.birdeye   || '',
                    etherscan: localStorage.getItem(`tcmd_${userId}_etherscan_key`) || K.etherscan || '',
                };
            }
        },

        async setApiKey(name, value) {
            const userId = _uid();
            const val = (value || '').trim();
            if (!SUPABASE_READY) {
                // User-scoped key so dev keys entered by one user aren't visible to others
                localStorage.setItem(`tcmd_${userId}_${name}_key`, val);
                return;
            }
            try {
                await sbUpsert('api_keys', { name, value: val, updated_at: new Date().toISOString() }, 'name');
            } catch (e) {
                console.warn('[SupabaseDB] setApiKey failed, saving to localStorage:', e.message);
                localStorage.setItem(`tcmd_${userId}_${name}_key`, val);
            }
        },

        // ══════════════════════════════════════════════════════
        // WATCHED WALLETS — strictly scoped by authenticated user
        // ══════════════════════════════════════════════════════
        // SECURITY: Every query MUST include user_id=eq.{userId} so that
        // Row Level Security (RLS) on the Supabase side plus this client-side
        // guard give two independent layers of isolation.
        // ══════════════════════════════════════════════════════

        async getWallets() {
            const userId = _uid();
            if (!SUPABASE_READY) {
                // localStorage fallback — scoped per user
                try {
                    return JSON.parse(localStorage.getItem(`tcmd_wallets_${userId}`) || '[]');
                } catch { return []; }
            }
            try {
                // Always filter by the authenticated user's id
                return await sbGet('watched_wallets', `user_id=eq.${userId}&order=created_at.desc`);
            } catch { return []; }
        },

        async addWallet({ chain, address, label }) {
            const userId = _uid();
            if (!SUPABASE_READY) {
                const wallets = JSON.parse(localStorage.getItem(`tcmd_wallets_${userId}`) || '[]');
                const w = { id: 'w_' + Date.now(), chain, address, label, user_id: userId, created_at: new Date().toISOString() };
                wallets.push(w);
                localStorage.setItem(`tcmd_wallets_${userId}`, JSON.stringify(wallets));
                return w;
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
                // Include user_id in the delete predicate — only deletes wallet if it belongs
                // to the current user. This is a second security layer after Supabase RLS.
                await sbDelete('watched_wallets', `id=eq.${id}&user_id=eq.${userId}`);
                return true;
            } catch { return false; }
        }
    };
})();
