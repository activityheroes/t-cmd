/* ============================================================
   T-CMD — CoinGecko Pricing Service
   Centralized CoinGecko Demo API pricing with:
     • Aggressive localStorage + in-memory caching
     • Request deduplication by (asset, date)
     • Rate-limit throttling (configurable)
     • Contract-address lookups (mint-based, not symbol)
     • Full source metadata on every PriceResult
   ============================================================ */

const CoinGeckoPricing = (() => {
  // ── Constants ────────────────────────────────────────────────
  const CACHE_NS = 'tcmd_cgp_';   // localStorage cache namespace
  const MEM_CACHE = new Map();     // in-memory cache for current session
  const INFLIGHT = new Map();      // dedup in-flight requests
  const THROTTLE_MS = 2500;        // ms between requests (≈24 req/min, safe for Demo)
  let _lastReqTs = 0;

  // Platform mapping for contract-address lookups
  const CG_PLATFORM_MAP = {
    solana:   'solana',
    sol:      'solana',
    ethereum: 'ethereum',
    eth:      'ethereum',
    base:     'base',
    bsc:      'binance-smart-chain',
    bnb:      'binance-smart-chain',
    arbitrum: 'arbitrum-one',
    polygon:  'polygon-pos',
    avax:     'avalanche',
  };

  // ── Throttle helper ─────────────────────────────────────────
  async function throttle() {
    const now = Date.now();
    const elapsed = now - _lastReqTs;
    if (elapsed < THROTTLE_MS) {
      await new Promise(r => setTimeout(r, THROTTLE_MS - elapsed));
    }
    _lastReqTs = Date.now();
  }

  // ── Cache helpers ───────────────────────────────────────────
  function cacheKey(type, id, dateStr) {
    return `${type}:${id}:${dateStr}`;
  }

  function getFromCache(key) {
    // 1. In-memory (fastest)
    if (MEM_CACHE.has(key)) return MEM_CACHE.get(key);
    // 2. localStorage
    try {
      const raw = localStorage.getItem(CACHE_NS + key);
      if (raw) {
        const parsed = JSON.parse(raw);
        MEM_CACHE.set(key, parsed); // promote to memory
        return parsed;
      }
    } catch { /* corrupted entry */ }
    return null;
  }

  function setCache(key, result) {
    MEM_CACHE.set(key, result);
    try {
      localStorage.setItem(CACHE_NS + key, JSON.stringify(result));
    } catch { /* quota exceeded — memory cache still works */ }
  }

  // ── Build PriceResult ───────────────────────────────────────
  function makePriceResult(priceUSD, lookupType, dateRequested, dateReturned, cacheHit) {
    const dist = dateReturned
      ? Math.abs(new Date(dateRequested).getTime() - new Date(dateReturned).getTime()) / 86400000
      : 0;
    let confidence = 'high';
    if (dist > 3) confidence = 'low';
    else if (dist > 1) confidence = 'medium';

    return {
      priceUSD,
      source: 'coingecko_demo',
      lookupType,         // 'coin_id' | 'contract_address'
      timestampRequested: dateRequested,
      timestampReturned:  dateReturned || dateRequested,
      confidence,
      cacheHit: !!cacheHit,
    };
  }

  // ── Core: fetch price by CoinGecko coin ID ─────────────────
  async function fetchByCoinId(coinId, dateStr) {
    if (!coinId || !dateStr) return null;
    const key = cacheKey('cid', coinId, dateStr);

    // Cache check
    const cached = getFromCache(key);
    if (cached) return makePriceResult(cached.priceUSD, 'coin_id', dateStr, cached.dateReturned, true);

    // Dedup
    if (INFLIGHT.has(key)) return INFLIGHT.get(key);

    const promise = (async () => {
      try {
        await throttle();
        const result = await ChainAPIs.cgHistoricalPrice(coinId, dateStr);
        if (!result || !result.priceUSD) return null;

        const entry = { priceUSD: result.priceUSD, dateReturned: result.date };
        setCache(key, entry);
        return makePriceResult(result.priceUSD, 'coin_id', dateStr, result.date, false);
      } catch (e) {
        console.warn(`[CoinGeckoPricing] fetchByCoinId(${coinId}, ${dateStr}):`, e.message);
        return null;
      } finally {
        INFLIGHT.delete(key);
      }
    })();

    INFLIGHT.set(key, promise);
    return promise;
  }

  // ── Core: fetch price by contract address ──────────────────
  // DISABLED: The CoinGecko endpoint /coins/{platform}/contract/{address}/market_chart/range
  // requires a paid CoinGecko plan. The Demo API key always returns HTTP 401 for this
  // endpoint. Tokens without a CoinGecko coin ID should be priced via the GeckoTerminal
  // OHLCV path (pool discovery → OHLCV) instead, which IS supported on the Demo key.
  // eslint-disable-next-line no-unused-vars
  async function fetchByContract(_platform, _contractAddress, _dateStr) {
    return null; // always 401 on Demo key — see comment above
  }

  // ── Batch fetch for a set of price requests ────────────────
  // Each request: { coinId?, contractAddress?, platform?, dateStr }
  // Returns Map<requestKey, PriceResult>
  async function fetchBatch(requests, onProgress) {
    if (!requests?.length) return new Map();
    const results = new Map();
    let done = 0;

    for (const req of requests) {
      let result = null;

      // Try coin ID first (more reliable, lower latency)
      if (req.coinId) {
        result = await fetchByCoinId(req.coinId, req.dateStr);
      }

      // Fallback: contract address lookup
      if (!result && req.contractAddress && req.platform) {
        result = await fetchByContract(req.platform, req.contractAddress, req.dateStr);
      }

      const key = `${req.coinId || req.contractAddress}|${req.dateStr}`;
      if (result) results.set(key, result);

      done++;
      if (onProgress) {
        onProgress({
          step: 'coingecko',
          done,
          total: requests.length,
          pct: Math.round((done / requests.length) * 100),
          msg: `CoinGecko: ${done}/${requests.length}${result ? ' ✓' : ' —'}`,
        });
      }
    }

    return results;
  }

  // ── Check if CoinGecko key is configured ───────────────────
  function isConfigured() {
    return !!(ChainAPIs.getKeys().coingecko);
  }

  // ── Clean expired cache entries ────────────────────────────
  function clearCache() {
    MEM_CACHE.clear();
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(CACHE_NS)) keysToRemove.push(k);
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
    console.log(`[CoinGeckoPricing] Cleared ${keysToRemove.length} cached entries`);
  }

  // ── Stats ──────────────────────────────────────────────────
  function getCacheStats() {
    let lsCount = 0;
    for (let i = 0; i < localStorage.length; i++) {
      if (localStorage.key(i)?.startsWith(CACHE_NS)) lsCount++;
    }
    return {
      memoryEntries: MEM_CACHE.size,
      localStorageEntries: lsCount,
      inflightRequests: INFLIGHT.size,
    };
  }

  return {
    fetchByCoinId,
    fetchByContract,
    fetchBatch,
    isConfigured,
    clearCache,
    getCacheStats,
    CG_PLATFORM_MAP,
  };
})();
