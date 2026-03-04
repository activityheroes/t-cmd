/* ============================================================
   T-CMD — API Integration Module
   Primary: Binance (full CORS support, no key needed)
   Fallback: CoinCap, DexScreener, Alternative.me
   ============================================================ */

const API = (() => {
    const BINANCE = 'https://api.binance.com/api/v3';
    const COINCAP = 'https://api.coincap.io/v2';
    const DEXSCREENER = 'https://api.dexscreener.com/latest';
    const DEXSCREENER_BOOSTS = 'https://api.dexscreener.com/token-boosts';
    const FEAR_GREED = 'https://api.alternative.me/fng/?limit=1';

    // ── Cache ──────────────────────────────────────────────
    const cache = {};
    const TTL_PRICES = 45_000;   // 45s
    const TTL_OHLCV = 120_000;  // 2 min
    const TTL_TOKENS = 90_000;   // 90s

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

    // ── Symbol mappings ────────────────────────────────────
    // Binance uses BTCUSDT style symbols
    const BINANCE_PAIRS = {
        'BTC': 'BTCUSDT', 'ETH': 'ETHUSDT', 'SOL': 'SOLUSDT',
        'BNB': 'BNBUSDT', 'XRP': 'XRPUSDT', 'ADA': 'ADAUSDT',
        'DOGE': 'DOGEUSDT', 'AVAX': 'AVAXUSDT', 'LINK': 'LINKUSDT',
        'DOT': 'DOTUSDT', 'MATIC': 'MATICUSDT', 'UNI': 'UNIUSDT',
        'ATOM': 'ATOMUSDT', 'LTC': 'LTCUSDT', 'NEAR': 'NEARUSDT',
        'APT': 'APTUSDT', 'SUI': 'SUIUSDT', 'INJ': 'INJUSDT',
        'OP': 'OPUSDT', 'ARB': 'ARBUSDT'
    };

    // CoinGecko IDs (kept for compatibility but not used for API calls)
    const COIN_IDS = {
        'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana',
        'BNB': 'binancecoin', 'XRP': 'ripple', 'ADA': 'cardano',
        'DOGE': 'dogecoin', 'AVAX': 'avalanche-2', 'LINK': 'chainlink',
        'DOT': 'polkadot', 'MATIC': 'matic-network', 'UNI': 'uniswap',
        'ATOM': 'cosmos', 'LTC': 'litecoin', 'NEAR': 'near',
        'APT': 'aptos', 'SUI': 'sui', 'INJ': 'injective-protocol',
        'OP': 'optimism', 'ARB': 'arbitrum'
    };

    function cgId(symbol) { return COIN_IDS[symbol.toUpperCase()] || symbol.toLowerCase(); }

    // ── Binance ────────────────────────────────────────────
    // getPrices returns a CoinGecko-compatible shape so the rest of the
    // app doesn't need to change.
    const CoinGecko = {
        async getPrices(symbols) {
            const pairs = symbols.map(s => BINANCE_PAIRS[s]).filter(Boolean);
            if (!pairs.length) return {};

            return cached(`prices_${pairs.join(',')}`, TTL_PRICES, async () => {
                // Batch ticker request
                const encoded = encodeURIComponent(JSON.stringify(pairs));
                const data = await fetchJSON(`${BINANCE}/ticker/24hr?symbols=${encoded}`);
                const result = {};
                for (const t of data) {
                    const sym = Object.entries(BINANCE_PAIRS).find(([, p]) => p === t.symbol)?.[0];
                    if (!sym) continue;
                    const id = COIN_IDS[sym] || sym.toLowerCase();
                    result[id] = {
                        usd: parseFloat(t.lastPrice),
                        usd_24h_change: parseFloat(t.priceChangePercent),
                        usd_market_cap: 0,  // not available without extra call
                        usd_24h_vol: parseFloat(t.quoteVolume)
                    };
                }
                return result;
            });
        },

        // Returns Binance daily klines in CoinGecko market_chart compatible shape
        async getOHLCV(symbol, days = 90) {
            const pair = BINANCE_PAIRS[symbol];
            if (!pair) throw new Error(`No Binance pair for ${symbol}`);
            return cached(`ohlcv_${pair}_${days}`, TTL_OHLCV, async () => {
                const limit = Math.min(days, 1000);
                const data = await fetchJSON(
                    `${BINANCE}/klines?symbol=${pair}&interval=1d&limit=${limit}`
                );
                // Convert to CoinGecko market_chart format: { prices: [[ts,close],...], total_volumes: [[ts,vol],...] }
                const prices = data.map(k => [k[0], parseFloat(k[4])]);          // [openTime, close]
                const total_volumes = data.map(k => [k[0], parseFloat(k[5])]);   // [openTime, baseVolume]
                return { prices, total_volumes };
            });
        },

        async getMarket(symbol) {
            const prices = await this.getPrices([symbol]);
            const id = COIN_IDS[symbol] || symbol.toLowerCase();
            return { market_data: { current_price: { usd: prices[id]?.usd || 0 } } };
        },

        async getTopCoins(limit = 50) {
            // Return empty array — not critical for main functionality
            return [];
        }
    };

    // ── CoinCap (fallback for non-Binance coins) ──────────
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
        async getTrending() {
            return cached('dex_trending', TTL_TOKENS, () =>
                fetchJSON(`${DEXSCREENER}/dex/search?q=sol&chain=solana`).then(r => r.pairs || [])
            );
        },
        async getBoostedTokens() {
            return cached('dex_boosted', TTL_TOKENS, () =>
                fetchJSON(`${DEXSCREENER_BOOSTS}/latest/v1`).then(r => Array.isArray(r) ? r : [])
            );
        },
        async getTopBoostedTokens() {
            return cached('dex_top_boosted', TTL_TOKENS, () =>
                fetchJSON(`${DEXSCREENER_BOOSTS}/top/v1`).then(r => Array.isArray(r) ? r : [])
            );
        },
        async getTokenPairs(chainId, tokenAddress) {
            return cached(`dex_pair_${chainId}_${tokenAddress}`, TTL_TOKENS, () =>
                fetchJSON(`${DEXSCREENER}/dex/tokens/${tokenAddress}`).then(r => r.pairs || [])
            );
        },
        async getTokenProfiles() {
            return cached('dex_profiles', TTL_TOKENS, () =>
                fetchJSON('https://api.dexscreener.com/token-profiles/latest/v1').then(r => Array.isArray(r) ? r : [])
            );
        },
        async search(query) {
            return fetchJSON(`${DEXSCREENER}/dex/search?q=${encodeURIComponent(query)}`).then(r => r.pairs || []);
        }
    };

    // ── Fear & Greed Index ─────────────────────────────────
    const FearGreed = {
        async get() {
            return cached('fear_greed', 300_000, () =>
                fetchJSON(FEAR_GREED).then(r => {
                    const d = r.data?.[0] || {};
                    return { value: parseInt(d.value || 50), classification: d.value_classification || 'Neutral' };
                }).catch(() => ({ value: 50, classification: 'Neutral' }))
            );
        }
    };

    // ── LunarCrush (free public API) ───────────────────────
    const LunarCrush = {
        async getSentiment(symbol) {
            const sym = symbol.toLowerCase();
            return cached(`lc_${sym}`, 300_000, async () => {
                try {
                    // Try v4 public endpoint (no key needed for basic data)
                    const data = await fetchJSON(
                        `https://lunarcrush.com/api4/public/coins/${sym}/v1`
                    );
                    const d = data?.data || {};
                    const bullish = d.sentiment ? Math.round(d.sentiment * 100) : 50;
                    return {
                        bullish,
                        bearish: 100 - bullish,
                        sentiment: bullish >= 60 ? 'Bullish' : bullish <= 40 ? 'Bearish' : 'Neutral',
                        galaxyScore: d.galaxy_score || 0,
                        posts24h: d.social_volume_24h || d.posts_24h || null,
                        interactions24h: d.social_engagement_24h || null,
                        socialVolumeScore: Math.min(100, Math.round((d.social_dominance || 0) * 200))
                    };
                } catch {
                    return null; // gracefully return null if API unavailable
                }
            });
        }
    };

    // ── Normalizer (keeps compatibility with existing app code) ─
    function normalizeCGPrice(id, priceObj) {
        const d = priceObj[id] || {};
        return {
            price: d.usd || 0,
            change24h: d.usd_24h_change || 0,
            marketCap: d.usd_market_cap || 0,
            volume24h: d.usd_24h_vol || 0
        };
    }

    function buildOHLCVFromChart(chartData) {
        const prices = chartData.prices || [];
        const volumes = chartData.total_volumes || [];
        return prices.map((p, i) => ({
            ts: p[0],
            close: p[1],
            volume: volumes[i] ? volumes[i][1] : 0
        }));
    }

    return { CoinGecko, CoinCap, DexScreener, FearGreed, LunarCrush, normalizeCGPrice, buildOHLCVFromChart, cgId, COIN_IDS };
})();
