/* ============================================================
   T-CMD — API Integration Module
   All methods return normalized data. No API keys required.
   ============================================================ */

const API = (() => {
    const COINGECKO = 'https://api.coingecko.com/api/v3';
    const COINCAP = 'https://api.coincap.io/v2';
    const DEXSCREENER = 'https://api.dexscreener.com/latest';
    const DEXSCREENER_BOOSTS = 'https://api.dexscreener.com/token-boosts';
    const PAPRIKA = 'https://api.coinpaprika.com/v1';
    const FEAR_GREED = 'https://api.alternative.me/fng/?limit=1';

    // ── Cache ──────────────────────────────────────────────
    const cache = {};
    const TTL_PRICES = 30_000;  // 30s
    const TTL_OHLCV = 60_000;  // 1 min
    const TTL_TOKENS = 90_000;  // 90s

    function cached(key, ttl, fn) {
        const now = Date.now();
        if (cache[key] && (now - cache[key].ts) < ttl) return Promise.resolve(cache[key].data);
        return fn().then(data => { cache[key] = { data, ts: now }; return data; });
    }

    async function fetchJSON(url, opts = {}) {
        const resp = await fetch(url, { ...opts, headers: { 'Accept': 'application/json', ...(opts.headers || {}) } });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
        return resp.json();
    }

    // ── Coin ID mappings ───────────────────────────────────
    const COIN_IDS = {
        'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana',
        'BNB': 'binancecoin', 'XRP': 'ripple', 'ADA': 'cardano',
        'DOGE': 'dogecoin', 'AVAX': 'avalanche-2', 'LINK': 'chainlink',
        'DOT': 'polkadot', 'MATIC': 'matic-network', 'UNI': 'uniswap',
        'ATOM': 'cosmos', 'LTC': 'litecoin', 'NEAR': 'near',
        'APT': 'aptos', 'SUI': 'sui', 'INJ': 'injective-protocol',
        'OP': 'optimism', 'ARB': 'arbitrum', 'TIA': 'celestia',
        'SEI': 'sei-network', 'JTO': 'jito-governance-token'
    };

    function cgId(symbol) { return COIN_IDS[symbol.toUpperCase()] || symbol.toLowerCase(); }

    // ── CoinGecko ──────────────────────────────────────────
    const CoinGecko = {
        // Live prices for multiple coins
        async getPrices(symbols) {
            const ids = symbols.map(s => cgId(s)).join(',');
            return cached(`prices_${ids}`, TTL_PRICES, () =>
                fetchJSON(`${COINGECKO}/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`)
            );
        },

        // Market data for one coin
        async getMarket(symbol) {
            const id = cgId(symbol);
            return cached(`market_${id}`, TTL_PRICES, () =>
                fetchJSON(`${COINGECKO}/coins/${id}?localization=false&tickers=false&community_data=false&developer_data=false`)
            );
        },

        // OHLCV for technical analysis (days=1 gives hourly, days=90 gives daily)
        async getOHLCV(symbol, days = 90) {
            const id = cgId(symbol);
            return cached(`ohlcv_${id}_${days}`, TTL_OHLCV, () =>
                fetchJSON(`${COINGECKO}/coins/${id}/market_chart?vs_currency=usd&days=${days}`)
            );
        },

        // Top coins by market cap
        async getTopCoins(limit = 50) {
            return cached(`top_coins_${limit}`, TTL_PRICES, () =>
                fetchJSON(`${COINGECKO}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&sparkline=false&price_change_percentage=24h`)
            );
        }
    };

    // ── CoinCap ────────────────────────────────────────────
    const CoinCap = {
        async getAsset(symbol) {
            const id = symbol.toLowerCase();
            return cached(`cc_${id}`, TTL_PRICES, () =>
                fetchJSON(`${COINCAP}/assets/${id}`).then(r => r.data)
            );
        },
        async getHistory(symbol, interval = 'h1', start, end) {
            const id = symbol.toLowerCase();
            const s = start || Date.now() - 7 * 24 * 3600 * 1000;
            const e = end || Date.now();
            return cached(`cc_hist_${id}_${interval}`, TTL_OHLCV, () =>
                fetchJSON(`${COINCAP}/assets/${id}/history?interval=${interval}&start=${s}&end=${e}`).then(r => r.data)
            );
        }
    };

    // ── DexScreener ───────────────────────────────────────
    const DexScreener = {
        // Trending tokens on Solana
        async getTrending() {
            return cached('dex_trending', TTL_TOKENS, () =>
                fetchJSON(`${DEXSCREENER}/dex/search?q=sol&chain=solana`).then(r => r.pairs || [])
            );
        },

        // Boosted tokens (paid boosts = social signal)
        async getBoostedTokens() {
            return cached('dex_boosted', TTL_TOKENS, () =>
                fetchJSON(`${DEXSCREENER_BOOSTS}/latest/v1`).then(r => Array.isArray(r) ? r : [])
            );
        },

        // Top boosted tokens
        async getTopBoostedTokens() {
            return cached('dex_top_boosted', TTL_TOKENS, () =>
                fetchJSON(`${DEXSCREENER_BOOSTS}/top/v1`).then(r => Array.isArray(r) ? r : [])
            );
        },

        // Token pair data by address
        async getTokenPairs(chainId, tokenAddress) {
            return cached(`dex_pair_${chainId}_${tokenAddress}`, TTL_TOKENS, () =>
                fetchJSON(`${DEXSCREENER}/dex/tokens/${tokenAddress}`).then(r => r.pairs || [])
            );
        },

        // Latest token profiles
        async getTokenProfiles() {
            return cached('dex_profiles', TTL_TOKENS, () =>
                fetchJSON('https://api.dexscreener.com/token-profiles/latest/v1').then(r => Array.isArray(r) ? r : [])
            );
        },

        // Search by query
        async search(query) {
            return fetchJSON(`${DEXSCREENER}/dex/search?q=${encodeURIComponent(query)}`).then(r => r.pairs || []);
        }
    };

    // ── Fear & Greed Index ─────────────────────────────────
    const FearGreed = {
        async get() {
            return cached('fear_greed', 300_000, () =>  // 5 min cache
                fetchJSON(FEAR_GREED).then(r => {
                    const d = r.data?.[0] || {};
                    return { value: parseInt(d.value || 50), classification: d.value_classification || 'Neutral' };
                }).catch(() => ({ value: 50, classification: 'Neutral' }))
            );
        }
    };

    // ── CoinPaprika ───────────────────────────────────────
    const CoinPaprika = {
        async getCoin(id) {
            return cached(`pap_${id}`, TTL_PRICES, () => fetchJSON(`${PAPRIKA}/coins/${id}`));
        },
        async getOHLCV(id, days = 30) {
            const end = new Date().toISOString().slice(0, 10);
            const start = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
            return cached(`pap_ohlcv_${id}_${days}`, TTL_OHLCV, () =>
                fetchJSON(`${PAPRIKA}/coins/${id}/ohlcv/historical?start=${start}&end=${end}`)
            );
        }
    };

    // ── Normalizers ────────────────────────────────────────
    function normalizeCGPrice(id, priceObj) {
        const d = priceObj[id] || {};
        return {
            price: d.usd || 0,
            change24h: d.usd_24h_change || 0,
            marketCap: d.usd_market_cap || 0,
            volume24h: d.usd_24h_vol || 0
        };
    }

    // ── Build OHLCV array from CoinGecko chart data ────────
    function buildOHLCVFromChart(chartData) {
        // chartData.prices: [[ts, price], ...]
        // chartData.total_volumes: [[ts, vol], ...]
        const prices = chartData.prices || [];
        const volumes = chartData.total_volumes || [];
        return prices.map((p, i) => ({
            ts: p[0],
            close: p[1],
            volume: volumes[i] ? volumes[i][1] : 0
        }));
    }

    // Public
    return { CoinGecko, CoinCap, DexScreener, FearGreed, CoinPaprika, normalizeCGPrice, buildOHLCVFromChart, cgId, COIN_IDS };
})();
