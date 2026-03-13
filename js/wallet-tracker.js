/* ============================================================
   T-CMD — Wallet Tracker
   Track smart money wallets across SOL, ETH, BASE, BSC
   ============================================================ */

const WalletTracker = (() => {
    // localStorage key is user-scoped — SupabaseDB.getWallets() handles the scoping
    // for Supabase-backed mode; for localStorage-only mode we scope here too.
    function _lsKey() {
        const uid = (typeof SupabaseDB !== 'undefined') ? SupabaseDB.getCurrentUserId?.() || 'anon' : 'anon';
        return `tcmd_wallets_${uid}`;
    }

    // ── Storage helpers ─────────────────────────────────────────
    function _loadLocal() {
        try { return JSON.parse(localStorage.getItem(_lsKey()) || '[]'); } catch { return []; }
    }
    function _saveLocal(wallets) {
        localStorage.setItem(_lsKey(), JSON.stringify(wallets));
    }

    // ── CRUD ─────────────────────────────────────────────────────
    async function getWallets() {
        // SupabaseDB.getWallets() already scopes by user_id
        if (typeof SupabaseDB !== 'undefined' && SUPABASE_READY) {
            const data = await SupabaseDB.getWallets();
            if (Array.isArray(data)) return data;
        }
        return _loadLocal();
    }

    async function addWallet(chain, address, label) {
        const trimmed = address.trim();
        const lbl = label || trimmed.slice(0, 8) + '…';
        // SupabaseDB.addWallet() now includes user_id automatically
        if (typeof SupabaseDB !== 'undefined' && SUPABASE_READY) {
            const result = await SupabaseDB.addWallet({ chain, address: trimmed, label: lbl });
            if (result) return true;
        }
        const entry = { id: Date.now().toString(), chain, address: trimmed, label: lbl, created_at: new Date().toISOString() };
        const wallets = _loadLocal();
        if (!wallets.find(w => w.address === trimmed && w.chain === chain)) {
            wallets.unshift(entry); _saveLocal(wallets);
        }
        return true;
    }

    async function removeWallet(id, address) {
        if (typeof SupabaseDB !== 'undefined' && SUPABASE_READY) {
            // SupabaseDB.deleteWallet() includes user_id in the predicate
            await SupabaseDB.deleteWallet(id);
        }
        // Also clean local cache
        const wallets = _loadLocal().filter(w => w.id !== id && w.address !== address);
        _saveLocal(wallets);
    }

    // ── Chain configs ─────────────────────────────────────────────
    const CHAIN_CONFIG = {
        SOL: { label: 'Solana', icon: '◎', color: '#9945FF', explorer: a => `https://solscan.io/account/${a}` },
        ETH: { label: 'Ethereum', icon: 'Ξ', color: '#627EEA', explorer: a => `https://etherscan.io/address/${a}` },
        BASE: { label: 'Base', icon: 'B', color: '#0052FF', explorer: a => `https://basescan.org/address/${a}` },
        BSC: { label: 'BSC', icon: 'B', color: '#F0B90B', explorer: a => `https://bscscan.com/address/${a}` }
    };

    // ── Solana activity (Solana public mainnet RPC — free, no key) ─
    async function fetchSolanaActivity(address, limit = 5) {
        try {
            const rpc = 'https://api.mainnet-beta.solana.com';
            // Get recent transaction signatures
            const sigRes = await fetch(rpc, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
                    params: [address, { limit }]
                })
            });
            const sigData = await sigRes.json();
            const sigs = (sigData.result || []).slice(0, limit);
            if (!sigs.length) return { txCount: 0, recent: [] };

            return {
                txCount: sigs.length,
                recent: sigs.map(s => ({
                    sig: s.signature,
                    time: s.blockTime ? new Date(s.blockTime * 1000).toLocaleString() : 'Unknown',
                    timeAgo: s.blockTime ? _timeAgo(s.blockTime * 1000) : '?',
                    url: `https://solscan.io/tx/${s.signature}`
                }))
            };
        } catch (e) {
            return { txCount: 0, recent: [], error: 'RPC unavailable' };
        }
    }

    // Fetch tokens held by a Solana wallet via Helius/DexScreener approach
    async function fetchSolanaTokenHoldings(address) {
        try {
            const rpc = 'https://api.mainnet-beta.solana.com';
            const res = await fetch(rpc, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner',
                    params: [address, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
                        { encoding: 'jsonParsed', commitment: 'confirmed' }]
                })
            });
            const data = await res.json();
            const accounts = data.result?.value || [];
            return accounts
                .map(a => ({
                    mint: a.account.data.parsed.info.mint,
                    amount: parseFloat(a.account.data.parsed.info.tokenAmount.uiAmountString || 0)
                }))
                .filter(t => t.amount > 0)
                .sort((a, b) => b.amount - a.amount)
                .slice(0, 20);
        } catch { return []; }
    }

    // ── EVM activity (Etherscan/Basescan/BSCScan — free tier) ─────
    const EVM_API = {
        ETH: { base: 'https://api.etherscan.io/api', key: '' },
        BASE: { base: 'https://api.basescan.org/api', key: '' },
        BSC: { base: 'https://api.bscscan.com/api', key: '' }
    };

    // Call this from admin panel once user provides keys
    function setApiKey(chain, key) {
        if (EVM_API[chain]) EVM_API[chain].key = key;
        const keys = JSON.parse(localStorage.getItem('tcmd_evm_keys') || '{}');
        keys[chain] = key;
        localStorage.setItem('tcmd_evm_keys', JSON.stringify(keys));
    }

    function _loadEvmKeys() {
        try {
            const k = JSON.parse(localStorage.getItem('tcmd_evm_keys') || '{}');
            for (const chain of ['ETH', 'BASE', 'BSC']) {
                if (k[chain]) EVM_API[chain].key = k[chain];
            }
        } catch { }
    }
    _loadEvmKeys();

    async function fetchEvmActivity(address, chain) {
        const cfg = EVM_API[chain];
        if (!cfg) return { txCount: 0, recent: [], error: 'Unknown chain' };
        if (!cfg.key) return { txCount: 0, recent: [], error: 'No API key — add one in Admin → Wallet Tracker' };
        try {
            const url = `${cfg.base}?module=account&action=tokentx&address=${address}&sort=desc&offset=5&page=1&apikey=${cfg.key}`;
            const res = await fetch(url);
            const data = await res.json();
            if (data.status !== '1') return { txCount: 0, recent: [] };
            return {
                txCount: data.result.length,
                recent: data.result.slice(0, 5).map(tx => ({
                    token: tx.tokenSymbol,
                    amount: (parseFloat(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal || 18))).toFixed(4),
                    timeAgo: _timeAgo(parseInt(tx.timeStamp) * 1000),
                    type: parseInt(tx.to.toLowerCase() === address.toLowerCase()) ? 'BUY' : 'SELL',
                    url: cfg.base.replace('/api', '') + '/tx/' + tx.hash
                }))
            };
        } catch { return { txCount: 0, recent: [], error: 'Fetch failed' }; }
    }

    // ── Check if tracked wallets hold a specific token ──────────────
    async function checkWalletHoldings(tokenMint) {
        const wallets = await getWallets();
        const solWallets = wallets.filter(w => w.chain === 'SOL');
        const results = [];
        for (const w of solWallets.slice(0, 5)) { // limit to avoid RPC rate limits
            const holdings = await fetchSolanaTokenHoldings(w.address);
            const match = holdings.find(h => h.mint === tokenMint);
            if (match) results.push({ wallet: w, holding: match });
        }
        return results;
    }

    // ── Holder analysis for TP prediction (Feature 3) ─────────────
    async function fetchTokenTopHolders(mint) {
        try {
            const rpc = 'https://api.mainnet-beta.solana.com';
            const res = await fetch(rpc, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0', id: 1, method: 'getTokenLargestAccounts',
                    params: [mint, { commitment: 'confirmed' }]
                })
            });
            const data = await res.json();
            return (data.result?.value || []).map(h => ({
                address: h.address,
                amount: parseFloat(h.uiAmountString || 0)
            }));
        } catch { return []; }
    }

    // ── Utility ────────────────────────────────────────────────────
    function _timeAgo(ts) {
        const diff = Date.now() - ts;
        const m = Math.floor(diff / 60000);
        if (m < 1) return 'just now';
        if (m < 60) return `${m}m ago`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h}h ago`;
        return `${Math.floor(h / 24)}d ago`;
    }

    return {
        getWallets, addWallet, removeWallet,
        fetchSolanaActivity, fetchEvmActivity, fetchSolanaTokenHoldings,
        fetchTokenTopHolders, checkWalletHoldings,
        setApiKey, CHAIN_CONFIG
    };
})();
