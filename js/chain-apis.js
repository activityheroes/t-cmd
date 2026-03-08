/**
 * ChainAPIs — DexScreener · Birdeye · Helius integration layer
 * T-CMD Rug Checker & Cluster Detector
 *
 * DexScreener : free, no auth
 * Birdeye     : requires API key (tcmd_birdeye_key in localStorage)
 * Helius      : Solana only, requires API key (tcmd_helius_key in localStorage)
 */
const ChainAPIs = (() => {
  const DS_BASE = 'https://api.dexscreener.com';
  const BE_BASE = 'https://public-api.birdeye.so';
  const HL_BASE = 'https://api.helius.xyz/v0';
  const HL_RPC  = 'https://mainnet.helius-rpc.com';

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
  // Priority: localStorage (admin panel) > js/keys.js (local config) > empty
  function getKeys() {
    const K = window.TCMD_KEYS || {};
    return {
      birdeye: localStorage.getItem('tcmd_birdeye_key') || K.birdeye || '',
      helius:  localStorage.getItem('tcmd_helius_key')  || K.helius  || ''
    };
  }
  function setKey(name, value) {
    localStorage.setItem(`tcmd_${name}_key`, (value || '').trim());
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
      'X-Chain':   beChainStr(chain),
      'accept':    'application/json'
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
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ transactions: signatures.slice(0, 100) })
    });
  }

  /** Token metadata (name, symbol, image, decimals) for a list of mints */
  async function heliusTokenMeta(mintAddresses) {
    const key = hlKey();
    if (!key || !mintAddresses?.length) return null;
    return apiFetch(`${HL_BASE}/token-metadata?api-key=${key}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ mintAccounts: mintAddresses, includeOffChain: true, disableCache: false })
    });
  }

  /** Raw JSON-RPC call to Helius RPC */
  async function heliusRPC(method, params = []) {
    const key = hlKey();
    if (!key) return null;
    return apiFetch(`${HL_RPC}/?api-key=${key}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
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
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth', params: [] })
    }, 8000);
    return res?.result === 'ok';
  }

  return {
    // Config
    getKeys, setKey,
    // DexScreener
    dsToken, dsPair, dsSearch, getMainPair,
    // Birdeye
    beTokenSecurity, beTokenOverview, beTopHolders, beTrades, bePriceHistory,
    // Helius
    heliusTxns, heliusTxn, heliusTokenMeta, heliusRPC, getSolanaTokenCreator,
    // Helpers
    isBurnAddress, isLockerContract, isSafeLP,
    // Key testing
    testBirdeyeKey, testHeliusKey
  };
})();
