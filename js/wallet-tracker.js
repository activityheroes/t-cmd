/* ============================================================
   T-CMD — Wallet Tracker
   Track smart money wallets across SOL, ETH, BASE, BSC
   Per-user persistence via SupabaseDB
   ============================================================ */

const WalletTracker = (() => {

    // ── CRUD ─────────────────────────────────────────────────────
    async function getWallets() {
        if (typeof SupabaseDB !== 'undefined' && SUPABASE_READY) {
            const data = await SupabaseDB.getWallets();
            if (Array.isArray(data)) return data;
        }
        return [];
    }

    async function addWallet(chain, address, label) {
        const trimmed = address.trim();
        const lbl = label || trimmed.slice(0, 8) + '…';
        if (typeof SupabaseDB !== 'undefined' && SUPABASE_READY) {
            const result = await SupabaseDB.addWallet({ chain, address: trimmed, label: lbl });
            if (result) return true;
        }
        return false;
    }

    async function removeWallet(id, address) {
        if (typeof SupabaseDB !== 'undefined' && SUPABASE_READY) {
            await SupabaseDB.deleteWallet(id);
        }
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

    // ── EVM activity (Etherscan/Basescan/BSCScan) ─────────────────
    // API key now comes from centralized ChainAPIs.getKeys().etherscan
    const EVM_API = {
        ETH: { base: 'https://api.etherscan.io/api' },
        BASE: { base: 'https://api.basescan.org/api' },
        BSC: { base: 'https://api.bscscan.com/api' }
    };

    function _getEvmKey() {
        // Use centralized key from Supabase/ChainAPIs
        return (typeof ChainAPIs !== 'undefined') ? (ChainAPIs.getKeys().etherscan || '') : '';
    }

    async function fetchEvmActivity(address, chain) {
        const cfg = EVM_API[chain];
        if (!cfg) return { txCount: 0, recent: [], error: 'Unknown chain' };
        const evmKey = _getEvmKey();
        if (!evmKey) return { txCount: 0, recent: [], error: 'No API key — admin must add one in Admin → API Keys' };
        try {
            const url = `${cfg.base}?module=account&action=tokentx&address=${address}&sort=desc&offset=5&page=1&apikey=${evmKey}`;
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
        CHAIN_CONFIG
    };
})();
