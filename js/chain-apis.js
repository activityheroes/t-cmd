/**
 * ChainAPIs — DexScreener · Birdeye · Helius integration layer
 * T-CMD Rug Checker & Cluster Detector
 *
 * DexScreener : free, no auth
 * Birdeye     : requires API key (centralized in Supabase api_keys table)
 * Helius      : Solana only, requires API key (centralized in Supabase)
 */
const ChainAPIs = (() => {
  const DS_BASE = 'https://api.dexscreener.com';
  const BE_BASE = 'https://public-api.birdeye.so';
  const HL_BASE = 'https://api.helius.xyz/v0';
  const HL_RPC = 'https://mainnet.helius-rpc.com';
  const CG_BASE = 'https://api.coingecko.com/api/v3';

  // Birdeye chain identifiers
  const BE_CHAIN_MAP = {
    solana: 'solana', sol: 'solana',
    ethereum: 'ethereum', eth: 'ethereum',
    bsc: 'bsc', bnb: 'bsc', binance: 'bsc',
    base: 'base',
    arbitrum: 'arbitrum', arb: 'arbitrum',
    polygon: 'polygon', matic: 'polygon',
    avalanche: 'avax', avax: 'avax'
  };

  // Known burn / zero addresses (cross-chain)
  const BURN_ADDRESSES = new Set([
    '0x000000000000000000000000000000000000dead',
    '0x0000000000000000000000000000000000000000',
    '11111111111111111111111111111111',
    '1nc1nerator11111111111111111111111111111111',
    'burnAddressHere111111111111111111111111111'
  ].map(a => a.toLowerCase()));

  // Known LP locker contract addresses
  const LOCKER_ADDRESSES = new Set([
    // Solana
    'vau1zxA2LbssAUEF7Gpw91zMM1LvXrvpzJtmZ58rPsn',  // Meteora
    'CrX7kMhLC3cSsXJdT7JDgqrRVWGnUpX3gfEfxxPQwnt',  // Streamflow
    // EVM
    '0x663a5c229c09b049e36dcc11a9b0d4a8eb9db214',  // Unicrypt ETH
    '0xc765bddb93b0d1c1a88282ba0fa6b2d00e3e0c83',  // Team Finance
    '0x71b5759d73262fbb223956913ecf4ecc51057641',  // PinkLock
    '0x7ee058420ef182a236a34cb46c5c3c08aa8b17e4', // Mudra BSC
  ].map(a => a.toLowerCase()));

  // ── Key management ───────────────────────────────────────────
  // In-memory cache loaded from Supabase api_keys table.
  // loadKeys() pre-fetches on app init; getKeys() returns cached values synchronously.
  let _keysCache = null;

  function getKeys() {
    // Return cached keys if loaded, else fall back to localStorage/keys.js
    if (_keysCache) return { ..._keysCache };
    const K = window.TCMD_KEYS || {};
    return {
      birdeye: localStorage.getItem('tcmd_birdeye_key') || K.birdeye || '',
      helius: localStorage.getItem('tcmd_helius_key') || K.helius || '',
      etherscan: localStorage.getItem('tcmd_etherscan_key') || K.etherscan || '',
      coingecko: localStorage.getItem('tcmd_coingecko_key') || K.coingecko || '',
    };
  }

  async function loadKeys() {
    try {
      _keysCache = await SupabaseDB.getApiKeys();
    } catch (e) {
      console.warn('[ChainAPIs] loadKeys from Supabase failed:', e.message);
      _keysCache = getKeys(); // fall back to localStorage
    }
    return _keysCache;
  }

  async function setKey(name, value) {
    const val = (value || '').trim();
    await SupabaseDB.setApiKey(name, val);
    // Update local cache immediately
    if (!_keysCache) _keysCache = getKeys();
    _keysCache[name] = val;
  }

  // ── Generic fetch with timeout ───────────────────────────────
  async function apiFetch(url, opts = {}, timeoutMs = 12000) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        console.warn(`[ChainAPIs] HTTP ${res.status} — ${url.slice(0, 90)}`, txt.slice(0, 120));
        return null;
      }
      return await res.json();
    } catch (e) {
      if (e.name !== 'AbortError') console.warn('[ChainAPIs]', e.message, url.slice(0, 80));
      return null;
    }
  }

  // ── DexScreener ──────────────────────────────────────────────
  /** Get all pairs for a token address (any chain) */
  async function dsToken(address) {
    return apiFetch(`${DS_BASE}/latest/dex/tokens/${address}`);
  }

  /** Get a specific pair */
  async function dsPair(chain, pairAddress) {
    return apiFetch(`${DS_BASE}/latest/dex/pairs/${chain}/${pairAddress}`);
  }

  /** Text search across DexScreener */
  async function dsSearch(query) {
    return apiFetch(`${DS_BASE}/latest/dex/search?q=${encodeURIComponent(query)}`);
  }

  /** Auto-discover best liquidity pair for a token */
  async function getMainPair(tokenAddress) {
    const data = await dsToken(tokenAddress);
    if (!data?.pairs?.length) return null;
    return data.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  }

  // ── Birdeye ──────────────────────────────────────────────────
  function beChainStr(chain) {
    return BE_CHAIN_MAP[(chain || 'solana').toLowerCase()] || 'solana';
  }

  function beHeaders(chain) {
    const { birdeye } = getKeys();
    return {
      'X-API-KEY': birdeye,
      'X-Chain': beChainStr(chain),
      'accept': 'application/json'
    };
  }

  async function beGet(path, chain) {
    const { birdeye } = getKeys();
    if (!birdeye) return null;
    return apiFetch(`${BE_BASE}${path}`, { headers: beHeaders(chain) });
  }

  /**
   * Token security data — the core signal source.
   * Returns: mintAuthority, freezeAuthority, creatorAddress, creatorPercentage,
   *          top10HolderPercent, lpLockedPercentage, lpBurntPercentage,
   *          mutableMetadata, isToken2022, transferFeeData, etc.
   *
   * Tries v3 endpoint first (consistent with beTopHolders), falls back to legacy.
   */
  async function beTokenSecurity(address, chain = 'solana') {
    // v3 endpoint (preferred — consistent with beTopHolders)
    const v3 = await beGet(`/defi/v3/token/security?address=${address}`, chain);
    if (v3?.success) return v3;
    // Legacy endpoint fallback
    return beGet(`/defi/token_security?address=${address}`, chain);
  }

  /** Price, volume, liquidity, holder count, market cap */
  async function beTokenOverview(address, chain = 'solana') {
    // v3 endpoint first, then legacy
    const v3 = await beGet(`/defi/v3/token/market-data?address=${address}`, chain);
    if (v3?.success) return v3;
    return beGet(`/defi/token_overview?address=${address}`, chain);
  }

  /** Top N token holders */
  async function beTopHolders(address, chain = 'solana', limit = 20) {
    return beGet(`/defi/v3/token/holder?address=${address}&offset=0&limit=${limit}`, chain);
  }

  /** Recent swap transactions (buyer wallets, amounts, timestamps) */
  async function beTrades(address, chain = 'solana', limit = 100) {
    return beGet(`/defi/txs/token?address=${address}&offset=0&limit=${limit}&tx_type=swap`, chain);
  }

  /** 1-minute OHLCV price history between two Unix timestamps */
  async function bePriceHistory(address, chain = 'solana', timeFrom, timeTo) {
    return beGet(
      `/defi/history_price?address=${address}&address_type=token&type=1m&time_from=${timeFrom}&time_to=${timeTo}`,
      chain
    );
  }

  // ── Helius (Solana only) ─────────────────────────────────────
  function hlKey() { return getKeys().helius; }

  /** Enhanced transaction history for an address */
  async function heliusTxns(address, limit = 100, type = '') {
    const key = hlKey();
    if (!key) return null;
    const typeQ = type ? `&type=${type}` : '';
    return apiFetch(`${HL_BASE}/addresses/${address}/transactions?api-key=${key}&limit=${limit}${typeQ}`);
  }

  /** Fetch full parsed transactions by signature(s) */
  async function heliusTxn(signatures) {
    const key = hlKey();
    if (!key || !signatures?.length) return null;
    return apiFetch(`${HL_BASE}/transactions?api-key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: signatures.slice(0, 100) })
    });
  }

  /** Token metadata (name, symbol, image, decimals) for a list of mints */
  async function heliusTokenMeta(mintAddresses) {
    const key = hlKey();
    if (!key || !mintAddresses?.length) return null;
    return apiFetch(`${HL_BASE}/token-metadata?api-key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mintAccounts: mintAddresses, includeOffChain: true, disableCache: false })
    });
  }

  /** Raw JSON-RPC call to Helius RPC */
  async function heliusRPC(method, params = []) {
    const key = hlKey();
    if (!key) return null;
    return apiFetch(`${HL_RPC}/?api-key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
  }

  /** Find the creator/deployer of a Solana token mint */
  async function getSolanaTokenCreator(mintAddress) {
    const key = hlKey();
    if (!key) return null;

    // Get signatures for the mint (oldest = creation tx)
    const sigsRes = await heliusRPC('getSignaturesForAddress', [
      mintAddress,
      { limit: 10, commitment: 'confirmed' }
    ]);
    const sigs = sigsRes?.result;
    if (!sigs?.length) return null;

    // Oldest signature is last in the array (Solana returns newest-first)
    const oldestSig = sigs[sigs.length - 1]?.signature;
    if (!oldestSig) return null;

    const txnData = await heliusTxn([oldestSig]);
    if (!Array.isArray(txnData) || !txnData[0]) return null;
    return txnData[0].feePayer || txnData[0].source || null;
  }

  // ── Address classification helpers ───────────────────────────
  function isBurnAddress(addr) {
    return addr ? BURN_ADDRESSES.has(addr.toLowerCase()) : false;
  }
  function isLockerContract(addr) {
    return addr ? LOCKER_ADDRESSES.has(addr.toLowerCase()) : false;
  }
  function isSafeLP(addr) {
    return isBurnAddress(addr) || isLockerContract(addr);
  }

  // ── Convenience: test API key validity ───────────────────────
  async function testBirdeyeKey(key) {
    const res = await apiFetch(`${BE_BASE}/defi/token_overview?address=So11111111111111111111111111111111111111112`, {
      headers: { 'X-API-KEY': key, 'X-Chain': 'solana', 'accept': 'application/json' }
    }, 8000);
    return res?.success === true;
  }

  async function testHeliusKey(key) {
    const res = await apiFetch(`${HL_RPC}/?api-key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth', params: [] })
    }, 8000);
    return res?.result === 'ok';
  }

  // ── CoinGecko Demo API ──────────────────────────────────────
  function cgKey() { return getKeys().coingecko; }

  /**
   * Build a CoinGecko URL with the API key as a query parameter.
   * Using a query param avoids CORS preflight (custom headers trigger OPTIONS).
   */
  function cgUrl(path, key) {
    const k = key || cgKey();
    const sep = path.includes('?') ? '&' : '?';
    return `${CG_BASE}${path}${sep}x_cg_demo_api_key=${encodeURIComponent(k)}`;
  }

  /** Authenticated GET request to CoinGecko Demo API */
  async function cgGet(path, overrideKey) {
    const key = overrideKey || cgKey();
    if (!key) return null;
    return apiFetch(cgUrl(path, key), { headers: { 'accept': 'application/json' } }, 12000);
  }

  /**
   * Test a CoinGecko Demo API key.
   * Returns { valid, error?, usage? }
   */
  async function testCoinGeckoKey(key) {
    if (!key) return { valid: false, error: 'No key provided' };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(cgUrl('/ping', key), {
        headers: { 'accept': 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status === 401 || res.status === 403) {
        return { valid: false, error: 'Invalid API key or insufficient permissions' };
      }
      if (res.status === 429) {
        return { valid: true, error: 'Key is valid but rate-limited — try again later' };
      }
      if (!res.ok) {
        return { valid: false, error: `HTTP ${res.status}: ${res.statusText}` };
      }

      const data = await res.json();
      // Extract rate-limit headers if available
      const remaining = res.headers.get('x-ratelimit-remaining');
      const limit = res.headers.get('x-ratelimit-limit');
      const usage = remaining != null ? { remaining: parseInt(remaining), limit: parseInt(limit) } : null;

      return {
        valid: data?.gecko_says != null,
        usage,
      };
    } catch (e) {
      if (e.name === 'AbortError') return { valid: false, error: 'Request timed out' };
      return { valid: false, error: e.message || 'Network error' };
    }
  }

  /**
   * Historical price by CoinGecko coin ID for a specific date.
   * @param {string} coinId — e.g. 'bitcoin', 'solana'
   * @param {string} dateStr — 'YYYY-MM-DD'
   * @returns {{ priceUSD: number, date: string } | null}
   */
  async function cgHistoricalPrice(coinId, dateStr) {
    if (!coinId || !dateStr) return null;
    // CoinGecko /coins/{id}/history expects dd-mm-yyyy
    const [y, m, d] = dateStr.split('-');
    const cgDate = `${d}-${m}-${y}`;
    const data = await cgGet(`/coins/${coinId}/history?date=${cgDate}&localization=false`);
    const usd = data?.market_data?.current_price?.usd;
    return usd > 0 ? { priceUSD: usd, date: dateStr } : null;
  }

  /**
   * Historical price by contract address using CoinGecko's /coins/{platform}/contract/{address}/market_chart/range.
   * @param {string} platform — 'solana', 'ethereum', 'base', 'binance-smart-chain'
   * @param {string} contractAddress — token mint/contract address
   * @param {string} dateStr — 'YYYY-MM-DD'
   * @returns {{ priceUSD: number, date: string, timestampReturned: string } | null}
   */
  async function cgHistoricalByContract(platform, contractAddress, dateStr) {
    if (!platform || !contractAddress || !dateStr) return null;
    // Request a 48h window around the target date to ensure we get data
    const targetTs = Math.floor(new Date(dateStr + 'T12:00:00Z').getTime() / 1000);
    const from = targetTs - 86400;
    const to = targetTs + 86400;
    const data = await cgGet(
      `/coins/${platform}/contract/${contractAddress}/market_chart/range?vs_currency=usd&from=${from}&to=${to}`
    );
    const prices = data?.prices;
    if (!Array.isArray(prices) || !prices.length) return null;
    // Find closest data point to target
    let best = prices[0], bestDist = Math.abs(prices[0][0] / 1000 - targetTs);
    for (const p of prices) {
      const dist = Math.abs(p[0] / 1000 - targetTs);
      if (dist < bestDist) { best = p; bestDist = dist; }
    }
    if (!best || best[1] <= 0) return null;
    return {
      priceUSD: best[1],
      date: dateStr,
      timestampReturned: new Date(best[0]).toISOString(),
    };
  }

  /**
   * Batch current prices for multiple coin IDs.
   * @param {string[]} coinIds — e.g. ['bitcoin','solana']
   * @returns {Object} — { bitcoin: { usd: 65000 }, ... } or null
   */
  async function cgSimplePrice(coinIds) {
    if (!coinIds?.length) return null;
    return cgGet(`/simple/price?ids=${coinIds.join(',')}&vs_currencies=usd`);
  }

  return {
    // Config
    getKeys, setKey, loadKeys,
    // DexScreener
    dsToken, dsPair, dsSearch, getMainPair,
    // Birdeye
    beTokenSecurity, beTokenOverview, beTopHolders, beTrades, bePriceHistory,
    // Helius
    heliusTxns, heliusTxn, heliusTokenMeta, heliusRPC, getSolanaTokenCreator,
    // CoinGecko Demo
    cgGet, cgHistoricalPrice, cgHistoricalByContract, cgSimplePrice,
    // Helpers
    isBurnAddress, isLockerContract, isSafeLP,
    // Key testing
    testBirdeyeKey, testHeliusKey, testCoinGeckoKey,
  };
})();
