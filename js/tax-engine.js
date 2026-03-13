/* ============================================================
   T-CMD — Swedish Crypto Tax Engine v2
   Full pipeline: import → classify → match transfers →
     fetch SEK prices → compute tax → K4 export
   Implements Genomsnittsmetoden per Skatteverket.
   ============================================================ */

const TaxEngine = (() => {

  // ── Swedish Tax Rules ─────────────────────────────────────
  const TAX_RATE          = 0.30;
  const LOSS_DEDUCTION    = 0.70;
  const ROWS_PER_K4_FORM  = 7;

  // ── Stablecoins (treated as SEK-proxies at 1 USD ≈ current rate) ──
  const STABLES = new Set(['USDT','USDC','BUSD','DAI','TUSD','USDP','EUROC','EURC','USDS']);
  // Approx SEK per USD / EUR  (used when CoinGecko is unavailable for stablecoins)
  const STABLE_SEK = { USD: 10.4, EUR: 11.2 };

  // ── CoinCap asset ID mapping (api.coincap.io) — CORS-friendly ───
  const CC_IDS = {
    BTC:'bitcoin',ETH:'ethereum',SOL:'solana',BNB:'binance-coin',
    ADA:'cardano',DOT:'polkadot',AVAX:'avalanche',MATIC:'polygon',
    LINK:'chainlink',UNI:'uniswap',ATOM:'cosmos',NEAR:'near-protocol',
    OP:'optimism',ARB:'arbitrum',INJ:'injective',APT:'aptos',
    SUI:'sui',DOGE:'dogecoin',LTC:'litecoin',XRP:'xrp',
    SHIB:'shiba-inu',PEPE:'pepe',WIF:'dogwifhat',BONK:'bonk',
    JUP:'jupiter',PYTH:'pyth-network',SEI:'sei',TIA:'celestia',
    STRK:'starknet',TON:'toncoin', // TRUMP/FARTCOIN not on CoinCap → manual price required
    USDT:'tether',USDC:'usd-coin',BUSD:'binance-usd',DAI:'dai',
    WETH:'weth',WBTC:'wrapped-bitcoin',WSOL:'solana',
    ALGO:'algorand',FTM:'fantom',SAND:'the-sandbox',MANA:'decentraland',
    CRV:'curve-dao-token',AAVE:'aave',COMP:'compound',
    SNX:'synthetix-network-token',MKR:'maker',LDO:'lido-dao',RPL:'rocket-pool',
    RUNE:'thorchain',GRT:'the-graph',FIL:'filecoin',ICP:'internet-computer',
    VET:'vechain',HBAR:'hedera-hashgraph',ETC:'ethereum-classic',
    BCH:'bitcoin-cash',EOS:'eos',ZEC:'zcash',XMR:'monero',
  };

  // ── Transaction Categories ────────────────────────────────
  const CAT = {
    BUY:'buy', SELL:'sell', TRADE:'trade',
    RECEIVE:'receive', SEND:'send', INCOME:'income',
    FEE:'fee', TRANSFER_IN:'transfer_in', TRANSFER_OUT:'transfer_out',
    SPAM:'spam', APPROVAL:'approval',
  };

  // ── Storage Keys ──────────────────────────────────────────
  const LS = {
    ACCOUNTS:     'tcmd_tax_accounts',
    TRANSACTIONS: 'tcmd_tax_txns',
    SETTINGS:     'tcmd_tax_settings',
    PRICES:       'tcmd_tax_prices',
    IMPORT_STATUS:'tcmd_tax_import_status',
  };

  // ── Pipeline Event Emitter ────────────────────────────────
  const _listeners = {};
  const Events = {
    on(ev, fn)   { (_listeners[ev] = _listeners[ev] || []).push(fn); },
    off(ev, fn)  { _listeners[ev] = (_listeners[ev]||[]).filter(f=>f!==fn); },
    emit(ev, d)  { (_listeners[ev]||[]).forEach(fn => { try { fn(d); } catch{} }); },
  };

  // ── Settings ──────────────────────────────────────────────
  function getSettings() {
    const def = {
      currency: 'SEK', taxYear: new Date().getFullYear()-1,
      country: 'SE', method: 'genomsnittsmetoden',
      userName:     '',   // Namn — shown in K4 PDF header
      personnummer: '',   // Personnummer YYYYMMDD-XXXX — shown in K4 PDF header
    };
    try { return { ...def, ...JSON.parse(localStorage.getItem(LS.SETTINGS)||'{}') }; }
    catch { return def; }
  }
  function saveSettings(s) { localStorage.setItem(LS.SETTINGS, JSON.stringify(s)); }

  // ── Accounts ──────────────────────────────────────────────
  function getAccounts()    { try { return JSON.parse(localStorage.getItem(LS.ACCOUNTS)||'[]'); } catch { return []; } }
  function saveAccounts(a)  { localStorage.setItem(LS.ACCOUNTS, JSON.stringify(a)); }
  function addAccount(acc)  {
    const accs = getAccounts();
    const id = 'acc_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
    const n = { id, addedAt: new Date().toISOString(), syncStatus:'never_synced', ...acc };
    accs.push(n); saveAccounts(accs); return n;
  }
  function removeAccount(id) {
    saveAccounts(getAccounts().filter(a => a.id !== id));
    saveTransactions(getTransactions().filter(t => t.accountId !== id));
    setImportStatus(id, null);
  }
  function updateAccount(id, data) {
    saveAccounts(getAccounts().map(a => a.id === id ? {...a, ...data} : a));
  }

  // ── Import Status ─────────────────────────────────────────
  function getImportStatuses() { try { return JSON.parse(localStorage.getItem(LS.IMPORT_STATUS)||'{}'); } catch { return {}; } }
  function setImportStatus(accountId, status) {
    const all = getImportStatuses();
    if (status === null) { delete all[accountId]; }
    else { all[accountId] = { ...all[accountId], ...status, updatedAt: new Date().toISOString() }; }
    localStorage.setItem(LS.IMPORT_STATUS, JSON.stringify(all));
  }
  function getImportStatus(accountId) { return getImportStatuses()[accountId] || { status:'never_synced' }; }

  // ── IndexedDB helpers (no 5 MB quota limit) ───────────────
  const IDB_NAME    = 'tcmd_tax';
  const IDB_STORE   = 'transactions';
  const IDB_VERSION = 1;

  function idbOpen() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE))
          db.createObjectStore(IDB_STORE, { keyPath: 'id' });
      };
      req.onsuccess = e => res(e.target.result);
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function idbSaveAll(txns) {
    try {
      const db    = await idbOpen();
      const tx    = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      store.clear();
      for (const t of txns) store.put(t);
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    } catch (e) {
      // Fallback: try localStorage (may fail for large datasets)
      console.warn('[TaxEngine] IDB write failed, trying localStorage:', e.message);
      try { localStorage.setItem(LS.TRANSACTIONS, JSON.stringify(txns)); } catch {}
    }
  }

  async function idbLoadAll() {
    try {
      const db    = await idbOpen();
      const tx    = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      return await new Promise((res, rej) => {
        const req = store.getAll();
        req.onsuccess = () => res(req.result || []);
        req.onerror   = () => rej(req.error);
      });
    } catch (e) {
      console.warn('[TaxEngine] IDB read failed, falling back to localStorage:', e.message);
      try { return JSON.parse(localStorage.getItem(LS.TRANSACTIONS)||'[]'); } catch { return []; }
    }
  }

  // ── Transactions (in-memory cache backed by IndexedDB) ────
  let _txCache = null;  // null = not yet loaded

  function getTransactions() { return _txCache || []; }

  function saveTransactions(txns) {
    _txCache = txns;
    idbSaveAll(txns).catch(e => console.warn('[TaxEngine] saveTransactions error:', e));
  }

  async function loadTransactions() {
    if (_txCache !== null) return;  // already loaded
    _txCache = await idbLoadAll();
    // One-time migration: if IDB is empty, check localStorage
    if (!_txCache.length) {
      try {
        const raw = localStorage.getItem(LS.TRANSACTIONS);
        if (raw) {
          _txCache = JSON.parse(raw);
          await idbSaveAll(_txCache);
          localStorage.removeItem(LS.TRANSACTIONS);  // free up space
          console.log('[TaxEngine] Migrated', _txCache.length, 'transactions from localStorage to IDB');
        }
      } catch {}
    }
  }

  function addTransactions(newTxns) {
    const existing = getTransactions();
    const seen = new Set(existing.map(t => `${t.txHash}|${t.accountId}`));
    let added = 0;
    for (const t of newTxns) {
      const key = `${t.txHash}|${t.accountId}`;
      if (!seen.has(key)) { seen.add(key); existing.push(t); added++; }
    }
    saveTransactions(existing);
    return added;
  }

  function deleteTransaction(id)      { saveTransactions(getTransactions().filter(t => t.id !== id)); }
  function updateTransaction(id, data) { saveTransactions(getTransactions().map(t => t.id===id ? {...t,...data} : t)); }

  function mkId()  { return 'txn_'+Date.now()+'_'+Math.random().toString(36).slice(2,8); }

  // ── Normalise raw → standard transaction ─────────────────
  function normalizeTransaction(raw, accountId, source) {
    // Promote rawType from the source record so classification works
    // after storage reload without needing the full raw object.
    const rawType = (raw.type || raw.side || raw.category || raw.transactionType || '').toLowerCase();
    return {
      id:             raw.id || mkId(),
      accountId,
      source,
      txHash:         raw.txHash || raw.hash || raw.id || ('manual_'+Date.now()),
      date:           parseDate(raw.date || raw.timestamp) || new Date().toISOString(),
      category:       raw.category || CAT.RECEIVE,
      autoClassified: false,
      isInternalTransfer: false,
      assetSymbol:    (raw.assetSymbol || raw.symbol || raw.asset || '').toUpperCase(),
      assetName:      raw.assetName || '',
      coinGeckoId:    raw.coinGeckoId || CC_IDS[(raw.assetSymbol||'').toUpperCase()] || null,
      amount:         Math.abs(parseFloat(raw.amount || 0)),
      inAsset:        (raw.inAsset || '').toUpperCase(),
      inAmount:       Math.abs(parseFloat(raw.inAmount || 0)),
      priceSEKPerUnit: parseFloat(raw.priceSEKPerUnit || 0),
      costBasisSEK:   parseFloat(raw.costBasisSEK || 0),
      feeSEK:         parseFloat(raw.feeSEK || 0),
      priceSource:    raw.priceSource || null,
      needsReview:    raw.needsReview !== undefined ? raw.needsReview : true,
      reviewReason:   raw.reviewReason || null,
      notes:          raw.notes || '',
      rawType,        // stored for re-classification; no full _raw object saved
    };
  }

  function parseDate(d) {
    if (!d) return null;
    const dt = new Date(d);
    return isNaN(dt.getTime()) ? null : dt.toISOString();
  }

  // ════════════════════════════════════════════════════════════
  // AUTO-CLASSIFICATION ENGINE
  // ════════════════════════════════════════════════════════════

  const SPAM_PATTERNS = [/airdrop.*claim/i, /free.*token/i, /visit.*to.*claim/i, /reward.*claim/i];

  function autoClassifyAll(txns) {
    return txns.map(t => {
      if (t.manualCategory) return t; // Never override user edits
      const cat = detectCategory(t);
      const needsReview = shouldReview(t, cat);
      return {
        ...t,
        category:      cat,
        autoClassified: true,
        needsReview,
        reviewReason:  needsReview ? getReviewReason(t, cat) : null,
      };
    });
  }

  function detectCategory(t) {
    const rawType = (t.rawType || '').toLowerCase();
    const sym     = (t.assetSymbol || '').toUpperCase();
    const notes   = (t.notes || '').toLowerCase();
    const amount  = t.amount || 0;

    // ── Exchange-reported types (most reliable) ────────────
    if (rawType.match(/^buy$/))          return CAT.BUY;
    if (rawType.match(/^sell$/))         return CAT.SELL;
    if (rawType.match(/swap|convert|exchange/))  return CAT.TRADE;
    if (rawType.match(/staking|earn|reward|interest|cashback|referral/)) return CAT.INCOME;
    if (rawType.match(/^deposit$/))      return CAT.TRANSFER_IN;   // May be reclassified as RECEIVE
    if (rawType.match(/^withdrawal?$/))  return CAT.TRANSFER_OUT;
    if (rawType.match(/airdrop/))        return CAT.RECEIVE;
    if (rawType.match(/fee/))            return CAT.FEE;
    if (rawType.match(/mining/))         return CAT.INCOME;
    if (rawType.match(/approval/))       return CAT.APPROVAL;

    // ── Blockchain heuristics ──────────────────────────────
    if (t.inAsset && t.inAmount > 0)     return CAT.TRADE;

    // Spam detection
    if (SPAM_PATTERNS.some(p => p.test(notes))) return CAT.SPAM;
    if (amount > 0 && amount < 0.000001 && !['BTC','ETH','SOL'].includes(sym)) return CAT.SPAM;

    // Tiny amounts = likely fees
    if (amount < 0.0001 && ['ETH','SOL','BNB'].includes(sym)) return CAT.FEE;

    return t.category || CAT.RECEIVE;
  }

  // Returns true only for genuine exceptions (review queue)
  function shouldReview(t, cat) {
    if (t.userReviewed) return false;  // user explicitly dismissed — never re-flag
    if (cat === CAT.SPAM || cat === CAT.APPROVAL || cat === CAT.FEE) return false;
    if (t.isInternalTransfer) return false;
    // Missing SEK price on taxable event
    if (isTaxableCategory(cat) && !t.priceSEKPerUnit && !t.costBasisSEK) return true;
    // Unknown asset in taxable event
    if (isTaxableCategory(cat) && !t.coinGeckoId && !STABLES.has(t.assetSymbol)) return true;
    return false;
  }

  function isTaxableCategory(cat) {
    return [CAT.SELL, CAT.TRADE, CAT.RECEIVE, CAT.INCOME, CAT.BUY].includes(cat);
  }

  function getReviewReason(t, cat) {
    if (!t.priceSEKPerUnit && !t.costBasisSEK) return 'missing_sek_price';
    if (!t.coinGeckoId && !STABLES.has(t.assetSymbol)) return 'unknown_asset';
    return 'unclassified';
  }

  // ════════════════════════════════════════════════════════════
  // TRANSFER MATCHING
  // ════════════════════════════════════════════════════════════
  const MATCH_WINDOW_MS  = 24 * 60 * 60 * 1000; // 24 h
  const AMOUNT_TOLERANCE = 0.02;                  // 2%

  function matchTransfers(txns) {
    // Only try to match transactions across accounts the user owns
    const byId = new Map(txns.map(t => [t.id, t]));
    const outgoing = txns.filter(t =>
      !t.isInternalTransfer &&
      (t.category === CAT.TRANSFER_OUT || t.category === CAT.SEND)
    );
    const incoming = txns.filter(t =>
      !t.isInternalTransfer &&
      (t.category === CAT.TRANSFER_IN || t.category === CAT.RECEIVE)
    );

    const matched = new Set();

    for (const out of outgoing) {
      if (matched.has(out.id)) continue;
      const outDate = new Date(out.date).getTime();

      const candidates = incoming
        .filter(inc => {
          if (matched.has(inc.id)) return false;
          if (inc.accountId === out.accountId) return false; // same account
          if (inc.assetSymbol !== out.assetSymbol) return false;
          const timeDiff = Math.abs(new Date(inc.date).getTime() - outDate);
          if (timeDiff > MATCH_WINDOW_MS) return false;
          const amtDiff = Math.abs(inc.amount - out.amount) / (out.amount || 1);
          if (amtDiff > AMOUNT_TOLERANCE) return false;
          return true;
        })
        .sort((a,b) => {
          const ta = Math.abs(new Date(a.date).getTime() - outDate);
          const tb = Math.abs(new Date(b.date).getTime() - outDate);
          return ta - tb;
        });

      if (candidates.length > 0) {
        const best = candidates[0];
        out.isInternalTransfer = true;
        out.matchedTxId        = best.id;
        out.needsReview        = false;
        best.isInternalTransfer = true;
        best.matchedTxId        = out.id;
        best.needsReview        = false;
        matched.add(out.id);
        matched.add(best.id);
      }
    }

    return txns;
  }

  // ════════════════════════════════════════════════════════════
  // SEK PRICE PIPELINE  (CoinCap + Frankfurter — CORS-friendly)
  // CoinCap:     api.coincap.io  — daily USD prices, batch by date range
  // Frankfurter: api.frankfurter.app — ECB FX rates USD→SEK, batch by year
  // No API key required. ~5–10 total requests regardless of tx count.
  // ════════════════════════════════════════════════════════════

  function getPriceCache() { try { return JSON.parse(localStorage.getItem(LS.PRICES)||'{}'); } catch { return {}; } }
  function savePriceCache(c) { try { localStorage.setItem(LS.PRICES, JSON.stringify(c)); } catch {} }

  function cacheKey(coinId, isoDate) {
    return `${coinId}_${isoDate.slice(0,10)}`;
  }

  function stableSEKPrice(sym) {
    const EUR = ['EUROC','EURC','EURT','EURS'];
    if (EUR.includes(sym)) return STABLE_SEK.EUR;
    return STABLE_SEK.USD;
  }

  // Fetch with a hard timeout — avoids hanging the tab if API is slow/rate-limiting
  async function fetchWithTimeout(url, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(tid);
      return r;
    } catch (e) {
      clearTimeout(tid);
      return null; // timeout or network error → treat as missing price
    }
  }

  // Fetch one year of daily USD prices from CoinCap (single CORS-friendly request)
  // Returns Map<YYYY-MM-DD, usdPrice>
  async function fetchCoinCapYear(ccId, year) {
    const startMs = Date.UTC(year, 0, 1);
    const endMs   = Date.UTC(year, 11, 31, 23, 59, 59);
    try {
      const url = `https://api.coincap.io/v2/assets/${ccId}/history?interval=d1&start=${startMs}&end=${endMs}`;
      const r = await fetchWithTimeout(url, 10000);
      if (!r || !r.ok) return null;
      const data = await r.json();
      const map = new Map();
      for (const pt of (data.data || [])) {
        const d = new Date(pt.time);
        map.set(d.toISOString().slice(0,10), parseFloat(pt.priceUsd));
      }
      return map;
    } catch { return null; }
  }

  // Fetch one year of USD→SEK FX rates from Frankfurter (single CORS-friendly request)
  // Returns Map<YYYY-MM-DD, sekPerUsd>
  async function fetchFXYear(year) {
    try {
      const url = `https://api.frankfurter.app/${year}-01-01..${year}-12-31?from=USD&to=SEK`;
      const r = await fetchWithTimeout(url, 10000);
      if (!r || !r.ok) return null;
      const data = await r.json();
      // data.rates = { "2024-01-02": { "SEK": 10.45 }, ... }
      const map = new Map();
      for (const [date, rates] of Object.entries(data.rates || {})) {
        if (rates.SEK) map.set(date, rates.SEK);
      }
      return map;
    } catch { return null; }
  }

  // Walk backwards up to N days to find closest available rate (covers weekends/holidays)
  function nearestMapValue(map, dateStr, maxDays = 5) {
    if (!map) return null;
    if (map.has(dateStr)) return map.get(dateStr);
    const d = new Date(dateStr);
    for (let i = 1; i <= maxDays; i++) {
      d.setUTCDate(d.getUTCDate() - 1);
      const k = d.toISOString().slice(0,10);
      if (map.has(k)) return map.get(k);
    }
    return null;
  }

  // Stamp cached SEK prices onto transactions (pure helper)
  function stampPrices(txns, cache) {
    return txns.map(t => {
      if (t.priceSEKPerUnit > 0) return t;
      if (t.isInternalTransfer)  return t;

      let price = null, priceSource = null;

      if (STABLES.has(t.assetSymbol)) {
        price = stableSEKPrice(t.assetSymbol);
        priceSource = 'stable_approx';
      } else {
        const ccId = CC_IDS[t.assetSymbol]; // only valid CoinCap IDs
        if (ccId) {
          price       = cache[cacheKey(ccId, (t.date||'').slice(0,10))] || null;
          priceSource = price ? 'coincap' : null;
        }
      }

      if (!price) return t; // Still missing — goes to review

      return {
        ...t,
        priceSEKPerUnit: price,
        costBasisSEK:    price * (t.amount || 0),
        priceSource,
        needsReview:  false,
        reviewReason: null,
      };
    });
  }

  // Fetch all missing SEK prices — batched by (coin × year) for minimal requests
  async function fetchAllSEKPrices(txns, onProgress) {
    const cache = getPriceCache();

    // Collect unique (ccId, year) pairs that need fetching.
    // IMPORTANT: Only use CC_IDS[symbol] — never t.coinGeckoId, which may hold stale
    // CoinGecko IDs from old imports that are invalid CoinCap IDs (e.g. 'avalanche-2').
    const neededPairs = new Map(); // "ccId|year" → { ccId, year }
    const neededYears = new Set();
    const MAX_PAIRS   = 80; // safety cap: prevents browser freeze on huge wallets

    for (const t of txns) {
      if (t.isInternalTransfer) continue;
      if (!isTaxableCategory(t.category)) continue;
      if (t.priceSEKPerUnit > 0) continue;
      if (STABLES.has(t.assetSymbol)) continue;

      const ccId = CC_IDS[t.assetSymbol]; // only use known-valid CoinCap IDs
      if (!ccId) continue;

      const dateStr = (t.date || '').slice(0,10);
      if (!dateStr) continue;

      // Skip if already cached (keyed by CC ID + date)
      if (cache[cacheKey(ccId, dateStr)] !== undefined) continue;

      const year    = parseInt(dateStr.slice(0,4));
      const pairKey = `${ccId}|${year}`;
      if (!neededPairs.has(pairKey)) {
        neededPairs.set(pairKey, { ccId, year });
        neededYears.add(year);
      }
      if (neededPairs.size >= MAX_PAIRS) break; // process remaining on next pipeline run
    }

    const totalSteps = neededYears.size + neededPairs.size;

    if (totalSteps === 0) {
      if (onProgress) onProgress({ step:'price', pct:100, msg:'Prices up to date' });
      return stampPrices(txns, cache);
    }

    let stepsDone = 0;

    // Step 1: Fetch FX rates per year (1 request/year — e.g. 2023, 2024, 2025)
    const fxByYear = new Map();
    for (const year of neededYears) {
      const fxMap = await fetchFXYear(year);
      fxByYear.set(year, fxMap);
      stepsDone++;
      if (onProgress) onProgress({
        step: 'price',
        pct:  Math.round((stepsDone / totalSteps) * 100),
        msg:  `Fetching FX rates (${year})…`,
      });
    }

    // Step 2: Fetch coin price history per (coin × year) (1 request/coin/year)
    const updatedCache = { ...cache };
    for (const [, { ccId, year }] of neededPairs) {
      const priceMap = await fetchCoinCapYear(ccId, year);
      const fxMap    = fxByYear.get(year);

      if (priceMap) {
        for (const [date, usdPrice] of priceMap) {
          if (isNaN(usdPrice)) continue;
          const fx = fxMap ? nearestMapValue(fxMap, date) : null;
          if (fx) updatedCache[cacheKey(ccId, date)] = usdPrice * fx;
        }
      }

      stepsDone++;
      if (onProgress) onProgress({
        step: 'price',
        pct:  Math.round((stepsDone / totalSteps) * 100),
        msg:  `Fetching prices (${ccId} ${year})…`,
      });
    }

    savePriceCache(updatedCache);
    return stampPrices(txns, updatedCache);
  }

  // ════════════════════════════════════════════════════════════
  // FULL IMPORT PIPELINE
  // After every import: classify → match → price → recalculate
  // ════════════════════════════════════════════════════════════
  let _pipelineRunning = false;

  async function runPipeline(opts = {}) {
    if (_pipelineRunning) return;
    _pipelineRunning = true;
    Events.emit('pipeline:start', {});

    try {
      const emit = (step, pct, msg) => {
        Events.emit('pipeline:step', { step, pct, msg });
        if (opts.onProgress) opts.onProgress({ step, pct, msg });
      };

      // Step 1 – Auto-classify
      emit('classify', 10, 'Classifying transactions…');
      let txns = getTransactions();
      txns = autoClassifyAll(txns);
      await tick();

      // Step 2 – Match internal transfers
      emit('transfer', 25, 'Matching internal transfers…');
      txns = matchTransfers(txns);
      await tick();

      // Step 3 – Fetch missing SEK prices
      emit('price', 40, 'Fetching historical SEK prices…');
      txns = await fetchAllSEKPrices(txns, (p) => {
        emit('price', 40 + Math.round(p.pct * 0.3), p.msg);
      });

      // Step 4 – Save enriched transactions
      emit('save', 72, 'Saving…');
      saveTransactions(txns);
      await tick();

      // Step 5 – Compute tax for current year
      emit('tax', 80, 'Computing Swedish tax (Genomsnittsmetoden)…');
      const settings   = getSettings();
      const taxResult  = computeTaxYear(settings.taxYear, txns);
      const reviewIssues = getReviewIssues(txns);

      emit('done', 100, 'Done!');

      const result = {
        totalTxns:    txns.length,
        reviewIssues: reviewIssues.length,
        taxResult,
      };
      Events.emit('pipeline:done', result);
      return result;
    } catch (err) {
      Events.emit('pipeline:error', { message: err.message });
      throw err;
    } finally {
      _pipelineRunning = false;
    }
  }

  function tick() { return new Promise(r => setTimeout(r, 0)); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ════════════════════════════════════════════════════════════
  // REVIEW ISSUES — exceptions only
  // ════════════════════════════════════════════════════════════
  const REVIEW_DESCRIPTIONS = {
    missing_sek_price:   { label:'Missing SEK price',   icon:'💰', why:'Cannot calculate gain/loss without SEK value at time of transaction.', fix:'Enter the market price in SEK on the transaction date.' },
    unknown_asset:       { label:'Unknown asset',        icon:'❓', why:'No CoinGecko price feed found for this token.', fix:'Enter the price manually or mark as spam if worthless.' },
    unmatched_transfer:  { label:'Unmatched transfer',   icon:'🔗', why:'This transfer could not be matched to an incoming/outgoing in your other accounts. May cause incorrect cost basis.', fix:'Connect the other account or mark as external.' },
    negative_balance:    { label:'Negative balance',     icon:'⚠️', why:'More units sold than found in history — missing buy transactions.', fix:'Import the full history for this asset.' },
    duplicate:           { label:'Possible duplicate',   icon:'📋', why:'Very similar transaction already exists.', fix:'Review and delete one if duplicate.' },
    unclassified:        { label:'Unclassified',         icon:'🏷️', why:'Could not auto-classify this transaction type.', fix:'Select the correct category.' },
    ambiguous_swap:      { label:'Ambiguous swap',       icon:'↔️', why:'Outgoing amount found but incoming asset/amount unknown.', fix:'Enter the received asset and amount.' },
  };

  function getReviewIssues(txns) {
    if (!txns) txns = getTransactions();
    return txns.filter(t => t.needsReview && t.reviewReason)
      .map(t => ({
        txnId:       t.id,
        txn:         t,
        reason:      t.reviewReason,
        meta:        REVIEW_DESCRIPTIONS[t.reviewReason] || { label: t.reviewReason, icon:'⚠️', why:'', fix:'' },
      }));
  }

  // ════════════════════════════════════════════════════════════
  // SWEDISH TAX ENGINE — Genomsnittsmetoden
  // ════════════════════════════════════════════════════════════
  function computeTaxYear(year, txns) {
    if (!txns) txns = getTransactions();
    year = parseInt(year);

    // Process ALL history (including prior years) to get correct cost basis
    const allSorted = [...txns]
      .filter(t => new Date(t.date).getFullYear() <= year)
      .sort((a,b) => new Date(a.date) - new Date(b.date));

    const holdings  = {};   // sym → { totalQty, totalCostSEK }
    const disposals = [];   // in target year
    const income    = [];   // in target year

    function ensure(sym) {
      if (!holdings[sym]) holdings[sym] = { totalQty:0, totalCostSEK:0 };
    }
    function avg(sym) {
      const h = holdings[sym];
      return (h && h.totalQty > 0) ? h.totalCostSEK / h.totalQty : 0;
    }

    for (const t of allSorted) {
      const sym   = t.assetSymbol;
      if (!sym || t.isInternalTransfer) continue;
      if (t.category === CAT.SPAM || t.category === CAT.APPROVAL) continue;

      ensure(sym);
      const h          = holdings[sym];
      const inYear     = new Date(t.date).getFullYear() === year;
      const priceSEK   = t.priceSEKPerUnit || (t.costBasisSEK / (t.amount || 1)) || 0;
      const proceedsSEK = t.costBasisSEK || (priceSEK * (t.amount || 0));
      const feeSEK      = t.feeSEK || 0;

      switch (t.category) {

        case CAT.BUY:
        case CAT.TRANSFER_IN:
        case CAT.RECEIVE: {
          const cost = proceedsSEK + feeSEK;
          h.totalQty     += t.amount;
          h.totalCostSEK += cost;
          if (inYear && t.category === CAT.RECEIVE && t.source !== 'transfer') {
            // Gifts, airdrops received = income event
            income.push({ date:t.date, assetSymbol:sym, amount:t.amount, valueSEK:proceedsSEK, id:t.id, category:t.category });
          }
          break;
        }

        case CAT.INCOME: {
          const cost = proceedsSEK;
          h.totalQty     += t.amount;
          h.totalCostSEK += cost;
          if (inYear) income.push({ date:t.date, assetSymbol:sym, amount:t.amount, valueSEK:proceedsSEK, id:t.id, category:t.category });
          break;
        }

        case CAT.SELL:
        case CAT.SEND: {
          if (t.category === CAT.SEND && t.isInternalTransfer) break;
          const qty        = Math.min(t.amount, h.totalQty); // cap at available
          const costBasis  = avg(sym) * qty;
          const gainLoss   = proceedsSEK - feeSEK - costBasis;

          if (inYear && t.category === CAT.SELL) {
            disposals.push({
              date: t.date, assetSymbol: sym, assetName: t.assetName||sym,
              amountSold: qty, proceedsSEK, feeSEK, costBasisSEK: costBasis,
              gainLossSEK: gainLoss, avgCostAtSale: avg(sym),
              id: t.id, needsReview: t.needsReview,
            });
          }
          h.totalQty      = Math.max(0, h.totalQty - qty);
          h.totalCostSEK  = Math.max(0, h.totalCostSEK - costBasis);
          break;
        }

        case CAT.TRADE: {
          const outSym  = sym;
          const inSym   = t.inAsset;
          const outAmt  = t.amount;
          const outProc = proceedsSEK;

          ensure(outSym);
          const hOut       = holdings[outSym];
          const qty        = Math.min(outAmt, hOut.totalQty);
          const costBasis  = avg(outSym) * qty;
          const gainLoss   = outProc - feeSEK - costBasis;

          if (inYear) {
            disposals.push({
              date: t.date, assetSymbol: outSym, assetName: t.assetName||outSym,
              amountSold: qty, proceedsSEK: outProc, feeSEK, costBasisSEK: costBasis,
              gainLossSEK: gainLoss, avgCostAtSale: avg(outSym),
              id: t.id, isTrade: true, inAsset: inSym, inAmount: t.inAmount,
              needsReview: t.needsReview,
            });
          }
          hOut.totalQty     = Math.max(0, hOut.totalQty - qty);
          hOut.totalCostSEK = Math.max(0, hOut.totalCostSEK - costBasis);

          // Buy side of swap — cost basis = FMV of what was sold
          if (inSym && t.inAmount > 0) {
            ensure(inSym);
            holdings[inSym].totalQty     += t.inAmount;
            holdings[inSym].totalCostSEK += outProc;
          }
          break;
        }

        case CAT.TRANSFER_OUT:
        case CAT.SEND: {
          if (t.isInternalTransfer) break;
          // Non-matched outgoing: reduce holdings (no taxable event for transfers)
          const qty = Math.min(t.amount, h.totalQty);
          const cb  = avg(sym) * qty;
          h.totalQty      = Math.max(0, h.totalQty - qty);
          h.totalCostSEK  = Math.max(0, h.totalCostSEK - cb);
          break;
        }

        case CAT.FEE: {
          // Fees paid in crypto = disposal at market value
          if (!['ETH','SOL','BNB','MATIC','AVAX'].includes(sym)) break;
          const qty       = Math.min(t.amount, h.totalQty);
          const feeProc   = priceSEK * qty;
          const feeCb     = avg(sym) * qty;
          const feeGain   = feeProc - feeCb;
          if (inYear && Math.abs(feeGain) > 0.01) {
            disposals.push({
              date: t.date, assetSymbol: sym,
              amountSold: qty, proceedsSEK: feeProc, feeSEK: 0,
              costBasisSEK: feeCb, gainLossSEK: feeGain,
              id: t.id, isFee: true, needsReview: false,
            });
          }
          h.totalQty      = Math.max(0, h.totalQty - qty);
          h.totalCostSEK  = Math.max(0, h.totalCostSEK - feeCb);
          break;
        }
      }
    }

    // Summary
    const totalGains   = disposals.filter(d => d.gainLossSEK > 0).reduce((s,d) => s + d.gainLossSEK, 0);
    const totalLosses  = disposals.filter(d => d.gainLossSEK < 0).reduce((s,d) => s + Math.abs(d.gainLossSEK), 0);
    const netGainLoss  = totalGains - totalLosses;
    // Per Skatteverket: only 70% of losses are deductible against gains (SFL 42 kap. 26§)
    const deductLoss   = totalLosses * LOSS_DEDUCTION;
    const taxableGain  = Math.max(0, totalGains - deductLoss);
    const estimatedTax = taxableGain * TAX_RATE;
    const totalIncome  = income.reduce((s,i) => s + i.valueSEK, 0);

    // Target-year transactions only (for stats)
    const yearTxns = txns.filter(t => new Date(t.date).getFullYear() === year);

    // Current holdings — resolve display symbol/name so the UI always shows
    // human-readable tokens (JUPYIWRY → JUP "Jupiter", EPJFWDD5 → USDC, etc.)
    const currentHoldings = Object.entries(holdings)
      .filter(([,h]) => h.totalQty > 1e-9)
      .map(([sym, h]) => {
        const td = resolveTokenDisplay(sym);
        return {
          symbol:       td.symbol || sym,
          assetName:    td.name   || h.assetName || sym,
          quantity:     h.totalQty,
          avgCostSEK:   h.totalQty > 0 ? h.totalCostSEK / h.totalQty : 0,
          totalCostSEK: h.totalCostSEK,
        };
      })
      .sort((a,b) => b.totalCostSEK - a.totalCostSEK);

    // Aggregate proceeds / cost for declaration reference
    const totalProceeds   = disposals.reduce((s,d) => s + d.proceedsSEK, 0);
    const totalCostBasis  = disposals.reduce((s,d) => s + d.costBasisSEK, 0);

    return {
      year, disposals, income, currentHoldings,
      summary: {
        totalTransactions:  yearTxns.length,
        totalDisposals:     disposals.length,
        totalProceeds, totalCostBasis,
        totalGains, totalLosses, netGainLoss,
        taxableGain, deductibleLoss: deductLoss,
        estimatedTax, totalIncome,
      },
    };
  }

  // ════════════════════════════════════════════════════════════
  // K4 SECTION D EXPORT — SKV 2104
  // Simplified method: one row per asset per gain/loss side.
  // Per Skatteverket guidelines for crypto.
  // ════════════════════════════════════════════════════════════
  function generateK4Report(result, userInfo = {}) {
    const { disposals, year } = result;

    // Group by asset, then by gain/loss side
    const assetMap = {};
    for (const d of disposals) {
      if (!assetMap[d.assetSymbol]) assetMap[d.assetSymbol] = { gains:[], losses:[] };
      if (d.gainLossSEK >= 0) assetMap[d.assetSymbol].gains.push(d);
      else                    assetMap[d.assetSymbol].losses.push(d);
    }

    // Build K4 rows: max 2 per asset (gain row + loss row)
    const k4Rows = [];
    for (const [sym, { gains, losses }] of Object.entries(assetMap)) {
      // Resolve human-readable name for beteckning field
      const td          = resolveTokenDisplay(sym);
      const displayName = td.name
        ? `${td.name} (${td.symbol || sym})`
        : (td.symbol || sym);
      if (gains.length > 0) {
        const qty  = gains.reduce((s,d) => s + d.amountSold, 0);
        const proc = gains.reduce((s,d) => s + d.proceedsSEK, 0);
        const cost = gains.reduce((s,d) => s + d.costBasisSEK, 0);
        const gain = gains.reduce((s,d) => s + d.gainLossSEK, 0);
        k4Rows.push({ sym, displayName, side:'gain', qty, proc, cost, gain, loss:0 });
      }
      if (losses.length > 0) {
        const qty  = losses.reduce((s,d) => s + d.amountSold, 0);
        const proc = losses.reduce((s,d) => s + d.proceedsSEK, 0);
        const cost = losses.reduce((s,d) => s + d.costBasisSEK, 0);
        const loss = Math.abs(losses.reduce((s,d) => s + d.gainLossSEK, 0));
        k4Rows.push({ sym, displayName, side:'loss', qty, proc, cost, gain:0, loss });
      }
    }

    // Total sums
    const totalGains  = k4Rows.reduce((s,r) => s + r.gain, 0);
    const totalLosses = k4Rows.reduce((s,r) => s + r.loss, 0);

    return { k4Rows, totalGains, totalLosses, year, userInfo,
      formsNeeded: Math.max(1, Math.ceil(k4Rows.length / ROWS_PER_K4_FORM)) };
  }

  function generateK4CSV(result, userInfo = {}) {
    const k4 = generateK4Report(result, userInfo);
    const today = new Date().toLocaleDateString('sv-SE');
    const ROWS_PER_PAGE = ROWS_PER_K4_FORM;

    const lines = [];

    // ── Summary header ──────────────────────────────────────
    lines.push(
      `; ═══════════════════════════════════════════════════════════════`,
      `; SKV 2104 — Bilaga K4 — Sektion D (Kryptovalutor)`,
      `; Förenklad metod: en rad per tillgång och vinstsida`,
      `; Inkomstår:,${k4.year}`,
      `; Datum:,${today}`,
      userInfo.name ? `; Namn:,${userInfo.name}` : '',
      userInfo.personnummer ? `; Personnummer:,${userInfo.personnummer}` : '',
      `; `,
      `; TILL INKOMSTDEKLARATION 1:`,
      `; Summa vinst (Sektion D) → ruta 7.5:,${Math.round(k4.totalGains)} kr`,
      `; Summa förlust (Sektion D) → ruta 8.4:,${Math.round(k4.totalLosses)} kr`,
      `; Avdragsgill förlust (70%) → ruta 8.4:,${Math.round(k4.totalLosses * LOSS_DEDUCTION)} kr`,
      `; ═══════════════════════════════════════════════════════════════`,
      ``,
    );

    // ── K4 pages (7 rows each) ────────────────────────────
    for (let page = 0; page < k4.formsNeeded; page++) {
      const pageRows = k4.k4Rows.slice(page * ROWS_PER_PAGE, (page+1) * ROWS_PER_PAGE);
      lines.push(
        `; ─────────────────────────────────────────────────────────────`,
        `; K4 BLANKETT ${page+1} av ${k4.formsNeeded}  |  Inkomstår ${k4.year}`,
        `; D. Övriga värdepapper / andra tillgångar (kryptovalutor)`,
        `; ─────────────────────────────────────────────────────────────`,
        `Rad,Antal/Belopp,Beteckning/Valutakod,Försäljningspris (SEK),Omkostnadsbelopp (SEK),Vinst,Förlust`,
      );

      for (let row = 1; row <= ROWS_PER_PAGE; row++) {
        const r = pageRows[row-1];
        if (r) {
          const label      = r.displayName || r.sym;
          const beteckning = r.side === 'gain'
            ? `${label} kryptovaluta (vinst)`
            : `${label} kryptovaluta (förlust)`;
          lines.push([
            row,
            `"${r.qty.toFixed(8)}"`,
            `"${beteckning}"`,
            Math.round(r.proc),
            Math.round(r.cost),
            r.gain ? Math.round(r.gain) : '',
            r.loss ? Math.round(r.loss) : '',
          ].join(','));
        } else {
          lines.push(`${row},,,,,,`);
        }
      }

      const pageGain = pageRows.reduce((s,r) => s+r.gain, 0);
      const pageLoss = pageRows.reduce((s,r) => s+r.loss, 0);
      lines.push(
        ``,
        `; Summa vinst blankett ${page+1}:,,,,,${Math.round(pageGain)},`,
        `; Summa förlust blankett ${page+1}:,,,,,,${Math.round(pageLoss)}`,
        ``,
      );
    }

    lines.push(
      `; OBS! Genomsnittsmetoden (SFS 1999:1229 44 kap. 7§) har använts.`,
      `; Belopp avrundas till hela kronor per Skatteverkets anvisningar.`,
    );

    return lines.filter(l => l !== '').join('\n');
  }

  // ════════════════════════════════════════════════════════════
  // AUDIT / TRANSACTION LEDGER CSV EXPORT
  // Full transaction-level export for accountant review.
  // Sorted by date; includes all disposals + income events.
  // ════════════════════════════════════════════════════════════
  function generateAuditCSV(result) {
    const { disposals, income, year, summary } = result;
    const today = new Date().toLocaleDateString('sv-SE');
    const lines = [];

    lines.push(
      `; ════════════════════════════════════════════════════════════════`,
      `; T-CMD — Transaktionslogg (revision / audit trail)`,
      `; Inkomstår: ${year}  |  Skapad: ${today}`,
      `; Genomsnittsmetoden per SFS 1999:1229 44 kap. 7§`,
      `; ════════════════════════════════════════════════════════════════`,
      ``,
    );

    // ── Disposals ────────────────────────────────────────────
    lines.push(
      `; AVYTTRINGAR`,
      `Datum,Tillgång,Visningsnamn,Antal,Försäljningspris (SEK),Omkostnadsbelopp (SEK),Vinst/Förlust (SEK),Typ,Transaktions-ID`,
    );
    const sortedDisposals = [...disposals].sort((a,b) => a.date.localeCompare(b.date));
    for (const d of sortedDisposals) {
      const td = resolveTokenDisplay(d.assetSymbol);
      lines.push([
        new Date(d.date).toLocaleDateString('sv-SE'),
        `"${td.symbol || d.assetSymbol}"`,
        `"${td.name   || td.symbol || d.assetSymbol}"`,
        `"${(d.amountSold || 0).toFixed(8)}"`,
        Math.round(d.proceedsSEK),
        Math.round(d.costBasisSEK),
        Math.round(d.gainLossSEK),
        d.isFee ? 'avgift' : 'avyttring',
        `"${d.id || ''}"`,
      ].join(','));
    }

    // ── Income events ─────────────────────────────────────────
    if (income.length > 0) {
      lines.push(
        ``,
        `; INKOMSTER (staking / mining / airdrops / övrigt)`,
        `Datum,Tillgång,Visningsnamn,Antal,Värde (SEK),Typ,Transaktions-ID`,
      );
      const sortedIncome = [...income].sort((a,b) => a.date.localeCompare(b.date));
      for (const inc of sortedIncome) {
        const td = resolveTokenDisplay(inc.assetSymbol);
        lines.push([
          new Date(inc.date).toLocaleDateString('sv-SE'),
          `"${td.symbol || inc.assetSymbol}"`,
          `"${td.name   || td.symbol || inc.assetSymbol}"`,
          `"${(inc.amount || 0).toFixed(8)}"`,
          Math.round(inc.valueSEK || 0),
          `"${inc.type || 'inkomst'}"`,
          `"${inc.id || ''}"`,
        ].join(','));
      }
    }

    // ── Summary footer ────────────────────────────────────────
    lines.push(
      ``,
      `; ════════════════════════════════════════════════════════════════`,
      `; SUMMERING ${year}`,
      `; ════════════════════════════════════════════════════════════════`,
      `; Antal avyttringar:,${disposals.length}`,
      `; Totalt försäljningspris:,${Math.round(summary.totalProceeds || 0)} kr`,
      `; Totalt omkostnadsbelopp:,${Math.round(summary.totalCostBasis || 0)} kr`,
      `; `,
      `; Summa vinst → K4 Sektion D → ruta 7.5:,${Math.round(summary.totalGains)} kr`,
      `; Summa förlust → K4 Sektion D → ruta 8.4:,${Math.round(summary.totalLosses)} kr`,
      `; Avdragsgill förlust (70%) → ruta 8.4:,${Math.round(summary.deductibleLoss)} kr`,
      `; Skattepliktig vinst (netto):,${Math.round(summary.taxableGain)} kr`,
      `; Beräknad skatt (30%):,${Math.round(summary.estimatedTax)} kr`,
      summary.totalIncome > 0
        ? `; Inkomst (staking/mining):,${Math.round(summary.totalIncome)} kr`
        : '',
      `; ════════════════════════════════════════════════════════════════`,
      `; OBS! Genomsnittsmetoden har använts. Kontrollera med revisor.`,
    );

    return lines.filter(l => l !== undefined).join('\n');
  }

  // ════════════════════════════════════════════════════════════
  // CSV PARSERS (enhanced — auto-classify output)
  // ════════════════════════════════════════════════════════════
  function parseCSV(text) {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const header = splitCSVLine(lines[0]);
    return lines.slice(1).map(line => {
      const cols = splitCSVLine(line);
      const obj = {};
      header.forEach((h, i) => { obj[h.trim().replace(/"/g,'')] = (cols[i]||'').trim().replace(/"/g,''); });
      return obj;
    }).filter(row => Object.values(row).some(v => v));
  }

  function splitCSVLine(line) {
    const cols = []; let cur = ''; let inQ = false;
    for (const ch of line) {
      if (ch === '"')      { inQ = !inQ; }
      else if (ch === ',' && !inQ) { cols.push(cur); cur = ''; }
      else { cur += ch; }
    }
    cols.push(cur);
    return cols;
  }

  function parseBinanceCSV(text, accountId) {
    const rows = parseCSV(text);
    return rows.map(r => {
      const side   = (r['Side']||r['Type']||'').toUpperCase();
      const pair   = r['Pair']||r['Symbol']||'';
      const base   = pair.replace(/USDT$|BUSD$|EUR$|BTC$|ETH$|BNB$/, '').toUpperCase() || (r['Coin']||r['Asset']||'').toUpperCase();
      const qty    = parseFloat(r['Executed']||r['Amount']||r['Quantity']||0);
      const price  = parseFloat(r['Price']||r['Avg Trading Price']||0);
      const total  = parseFloat(r['Total']||r['Executed Amount (Quote)']||0);
      const fee    = parseFloat(r['Fee']||0);
      const date   = r['Date(UTC)']||r['Date']||r['Time']||'';
      return normalizeTransaction({
        txHash:   r['TxID']||r['Order ID']||r['OrderId']||`bnb_${date}_${base}_${qty}`,
        date, type: side === 'BUY' ? 'buy' : side === 'SELL' ? 'sell' : 'trade',
        assetSymbol: base, amount: qty,
        priceSEKPerUnit: 0, // Will be fetched
        costBasisSEK: 0,
        feeSEK: fee, needsReview: true,
        notes: `Binance ${side} ${base} at ${price} (quote)`,
      }, accountId, 'binance_csv');
    });
  }

  function parseKrakenCSV(text, accountId) {
    const rows = parseCSV(text);
    return rows.map(r => {
      const type  = (r['type']||'').toLowerCase();
      const asset = (r['asset']||'').replace(/^X(?=[A-Z]{2,4}$)/,'').replace(/Z?EUR$|Z?USD$|\.S$/,'').toUpperCase();
      return normalizeTransaction({
        txHash:      r['txid']||r['refid']||`krk_${r['time']}_${asset}`,
        date:        r['time'],
        type,
        assetSymbol: asset,
        amount:      parseFloat(r['vol']||r['amount']||0),
        feeSEK:      parseFloat(r['fee']||0),
        needsReview: true,
        notes:       `Kraken ${type} ${asset}`,
      }, accountId, 'kraken_csv');
    });
  }

  function parseBybitCSV(text, accountId) {
    const rows = parseCSV(text);
    return rows.map(r => {
      const side = (r['Side']||'').toUpperCase();
      const sym  = (r['Symbol']||r['Coin']||'').replace(/USDT$|USD$/,'').toUpperCase();
      return normalizeTransaction({
        txHash:      r['Order ID']||r['Trade ID']||`bybit_${r['Date']}_${sym}`,
        date:        r['Date']||r['Time'],
        type:        side === 'BUY' ? 'buy' : 'sell',
        assetSymbol: sym,
        amount:      parseFloat(r['Qty']||r['Amount']||0),
        feeSEK:      parseFloat(r['Trading Fee']||0),
        needsReview: true,
        notes:       `Bybit ${side} ${sym}`,
      }, accountId, 'bybit_csv');
    });
  }

  function parseCoinbaseCSV(text, accountId) {
    const rows = parseCSV(text);
    return rows.map(r => {
      const type = (r['Transaction Type']||'').toLowerCase();
      return normalizeTransaction({
        txHash:      r['ID']||`cb_${r['Timestamp']}_${r['Asset']}`,
        date:        r['Timestamp'],
        type,
        assetSymbol: (r['Asset']||r['Coin Type']||'').toUpperCase(),
        amount:      parseFloat(r['Quantity Transacted']||0),
        feeSEK:      parseFloat(r['Fees and/or Spread']||0),
        needsReview: true,
        notes:       `Coinbase ${type}`,
      }, accountId, 'coinbase_csv');
    });
  }

  function parseGenericCSV(text, accountId) {
    const rows = parseCSV(text);
    return rows.map(r => {
      const lc = Object.fromEntries(Object.entries(r).map(([k,v]) => [k.toLowerCase().replace(/[\s/]/g,'_'), v]));
      return normalizeTransaction({
        txHash:         lc.txhash||lc.hash||lc.id||lc.order_id||`gen_${Date.now()}_${Math.random()}`,
        date:           lc.date||lc.datetime||lc.timestamp||lc.time||'',
        type:           lc.type||lc.category||lc.side||'',
        assetSymbol:    (lc.asset||lc.symbol||lc.coin||lc.currency||'').toUpperCase(),
        amount:         parseFloat(lc.amount||lc.quantity||lc.qty||0),
        priceSEKPerUnit: parseFloat(lc.price_sek||lc.pricesek||lc.price||0),
        costBasisSEK:   parseFloat(lc.total_sek||lc.totalsek||lc.total||0),
        feeSEK:         parseFloat(lc.fee||lc.fee_sek||0),
        needsReview:    true,
        notes:          'Generic CSV import',
      }, accountId, 'generic_csv');
    });
  }

  // ════════════════════════════════════════════════════════════
  // BLOCKCHAIN IMPORT — full history pagination
  // ════════════════════════════════════════════════════════════

  // Solana via Helius — paginates through ALL transactions
  // IMPORTANT: raw Helius JSON (5–20 KB/tx) is normalized and discarded per page.
  // Never accumulate allRaw — 8000 raw txns ≈ 100 MB in V8, which crashes Chrome.
  async function importSolanaWallet(address, accountId, onProgress) {
    const heliusKey = localStorage.getItem('tcmd_helius_key');
    if (!heliusKey) return { txns:[], error:'No Helius API key configured', missingKey:true };

    let allTxns = [], totalFetched = 0, before = null, hasMore = true;
    setImportStatus(accountId, { status:'syncing', source:'solana', address });

    try {
      while (hasMore) {
        const qs  = `api-key=${heliusKey}&limit=100${before?`&before=${before}`:''}`;
        const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?${qs}`;
        const r   = await fetch(url);

        if (r.status === 429) { await sleep(5000); continue; }
        if (!r.ok) break;

        const page = await r.json();
        if (!page.length) { hasMore = false; break; }

        // Normalize this page immediately — raw data is discarded after this block
        const pageTxns = page
          .flatMap(tx => normalizeSolanaTx(tx, address, accountId) || [])
          .filter(Boolean);
        allTxns.push(...pageTxns);

        totalFetched += page.length;
        before  = page[page.length-1].signature;
        hasMore = page.length === 100;

        if (onProgress) onProgress({ step:'import', msg:`Fetched ${totalFetched} Solana transactions…` });
        await tick(); // yield to browser between pages
      }

      const start = allTxns.length ? allTxns.reduce((a,b) => a.date < b.date ? a : b).date : null;
      const end   = allTxns.length ? allTxns.reduce((a,b) => a.date > b.date ? a : b).date : null;

      setImportStatus(accountId, { status:'synced', totalFetched, totalTxns:allTxns.length, startDate:start, endDate:end });
      return { txns:allTxns, totalFetched };
    } catch (e) {
      setImportStatus(accountId, { status:'failed', error:e.message });
      return { txns:[], error:e.message };
    }
  }

  function normalizeSolanaTx(tx, walletAddr, accountId) {
    try {
      const ts  = new Date((tx.timestamp||0)*1000).toISOString();
      const tt  = tx.tokenTransfers || [];
      const nt  = tx.nativeTransfers || [];
      const fee = (tx.fee||0) / 1e9; // lamports → SOL

      // Swap (SWAP type or has both in and out token transfers)
      if (tx.type === 'SWAP' || (tt.length >= 2)) {
        const out = tt.find(t => t.fromUserAccount === walletAddr);
        const inc = tt.find(t => t.toUserAccount   === walletAddr);
        if (out && inc) {
          return normalizeTransaction({
            txHash:  tx.signature, date: ts, type:'swap',
            assetSymbol: mintToSym(out.mint) || out.mint?.slice(0,8),
            amount:  out.tokenAmount || 0,
            inAsset: mintToSym(inc.mint) || inc.mint?.slice(0,8),
            inAmount: inc.tokenAmount || 0,
            feeSEK:  fee * 150, // approx SOL price * fee SOL
            needsReview: true, notes:'Solana swap',
          }, accountId, 'solana_wallet');
        }
      }

      // SOL transfer
      if (nt.length > 0) {
        const isOut = nt.some(n => n.fromUserAccount === walletAddr);
        const amt   = nt.reduce((s,n) => s + (n.amount||0), 0) / 1e9;
        return normalizeTransaction({
          txHash: tx.signature, date: ts,
          type:   isOut ? 'transfer_out' : 'transfer_in',
          assetSymbol:'SOL', amount:amt,
          feeSEK: fee * 150, needsReview:true, notes:'SOL transfer',
        }, accountId, 'solana_wallet');
      }

      // Token transfer
      const inc = tt.find(t => t.toUserAccount   === walletAddr);
      const out = tt.find(t => t.fromUserAccount === walletAddr);
      if (inc) return normalizeTransaction({
        txHash:tx.signature, date:ts, type:'transfer_in',
        assetSymbol: mintToSym(inc.mint)||inc.mint?.slice(0,8), amount: inc.tokenAmount||0,
        feeSEK:fee*150, needsReview:true,
      }, accountId, 'solana_wallet');
      if (out) return normalizeTransaction({
        txHash:tx.signature, date:ts, type:'transfer_out',
        assetSymbol: mintToSym(out.mint)||out.mint?.slice(0,8), amount: out.tokenAmount||0,
        feeSEK:fee*150, needsReview:true,
      }, accountId, 'solana_wallet');

    } catch { return null; }
    return null;
  }

  // Full mint address → symbol (Solana)
  const KNOWN_MINTS = {
    // Native SOL
    'So11111111111111111111111111111111111111112':  'SOL',
    // Stablecoins
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v':'USDC',  // fixed: was 'u'
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
    'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX':  'USDH',
    // Major DeFi / ecosystem
    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN':  'JUP',
    '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': 'RAY',
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So':  'MSOL',
    'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE':   'ORCA',
    'SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt':   'SRM',
    'MangoCzJ36AjZyKwVj3VnYU4GTonjfVEnJmvvWaxLac':   'MNGO',
    'StepAscQoEioFxxWGnh2sLBDFp9d8rvKz2Xjdsc8bnF':   'STEP',
    'Saber2gLauYim4Mvftnrasomsv6NvAunSsNgQIkmjnK':   'SBR',
    'SHDWyBxihqiCj6YekG2GUr7wqKLeLAMK1gHZck9pL6y':  'SHDW',
    // Meme coins
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': 'WIF',
    'MEFNBXixkEbait3xn9bkm8WsJzXtVsaJEn4c8Sam21Y':   'MEME',
    'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82':   'BOME',
    '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU':  'SAMO',
    // Oracles / infra
    'HZ1JovNiVvGqWz8f9P7pVMKgBfQ5bHUi7t5RhHCRWRJo': 'PYTH',
    'DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7':  'DRIFT',
    'TNSRxcUxoT9xBG3de7NiJo5YBkNzMzMgaEgVgUt5PV':   'TNSR',
    'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk':   'WEN',
    // Gaming / metaverse
    'ATLASXmbPQxBUYbxPsV97usA3fPQYEqzQBUHgiFCUsXx':  'ATLAS',
    'poLisWXnNRwC6oBu1vHiuKQzFjGL4XDSu4g9qjz9qVk':   'POLIS',
    // Bridged assets
    '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs':  'WETH',
    '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E':  'WBTC',
    // Helium
    'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux':   'HNT',
    'mb1eu7TzEc71KxDpsmsKoucSSuuoGLv1drys1oP2jh6':    'MOBILE',
    'iotEVVZLEywoTn1QdwNPddxPWszn3zFhEot3MfL9fns':    'IOT',
  };

  // Human-readable full names for known symbols
  const TOKEN_DISPLAY_NAMES = {
    SOL:'Solana', ETH:'Ethereum', BTC:'Bitcoin', BNB:'BNB',
    USDC:'USD Coin', USDT:'Tether USD', USDH:'USDH', DAI:'Dai', BUSD:'Binance USD',
    JUP:'Jupiter', RAY:'Raydium', MSOL:'Marinade SOL', ORCA:'Orca',
    SRM:'Serum', MNGO:'Mango', STEP:'Step Finance', SBR:'Saber', SHDW:'Shadow Token',
    BONK:'Bonk', WIF:'dogwifhat', MEME:'Memecoin', BOME:'Book of Meme', SAMO:'Samoyed Coin',
    PYTH:'Pyth Network', DRIFT:'Drift Protocol', TNSR:'Tensor', WEN:'Wen',
    ATLAS:'Star Atlas', POLIS:'Star Atlas POLIS',
    WETH:'Wrapped ETH', WBTC:'Wrapped BTC', WSOL:'Wrapped SOL',
    HNT:'Helium', MOBILE:'Helium Mobile', IOT:'Helium IOT',
    LINK:'Chainlink', UNI:'Uniswap', AAVE:'Aave', COMP:'Compound',
    AVAX:'Avalanche', MATIC:'Polygon', DOT:'Polkadot', ADA:'Cardano',
    DOGE:'Dogecoin', SHIB:'Shiba Inu', PEPE:'Pepe',
    OP:'Optimism', ARB:'Arbitrum', INJ:'Injective', APT:'Aptos', SUI:'Sui',
    SEI:'Sei', TIA:'Celestia', ATOM:'Cosmos', NEAR:'NEAR Protocol',
    XRP:'XRP', LTC:'Litecoin', TON:'Toncoin',
    JTO:'Jito', ZEUS:'Zeus Network', BNSOL:'Binance Staked SOL',
    DSYNC:'Destra Network', PEPECOIN:'PepeCoin', MON:'Monad',
  };

  // Reverse lookup: first 8 chars of mint (uppercase) → symbol.
  // Built automatically from KNOWN_MINTS so it's always in sync.
  const MINT_PREFIX_TO_SYM = Object.fromEntries(
    Object.entries(KNOWN_MINTS).map(([mint, sym]) => [mint.slice(0,8).toUpperCase(), sym])
  );

  // Resolve display {symbol, name} for any assetSymbol — handles both proper
  // symbols (SOL, ETH) and 8-char truncated Solana mint prefixes (JUPYIWRY → JUP).
  function resolveTokenDisplay(sym) {
    if (!sym) return { symbol: sym, name: sym };
    const upper = sym.toUpperCase().trim();
    // 1. Direct symbol match
    if (TOKEN_DISPLAY_NAMES[upper]) return { symbol: upper, name: TOKEN_DISPLAY_NAMES[upper] };
    // 2. 8-char mint prefix reverse lookup (e.g. "JUPYIWRY" → "JUP")
    const resolved = MINT_PREFIX_TO_SYM[upper];
    if (resolved) return { symbol: resolved, name: TOKEN_DISPLAY_NAMES[resolved] || resolved };
    // 3. Unknown
    return { symbol: sym, name: null };
  }

  // Async: fetch human-readable names from DexScreener for truly unknown symbols.
  // Results cached in localStorage under 'tcmd_token_names' (7-day TTL).
  async function resolveUnknownTokenNames(symbols) {
    const CACHE_KEY = 'tcmd_token_names';
    const TTL_MS    = 7 * 24 * 60 * 60 * 1000; // 7 days
    let cache = {};
    try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch {}
    // Evict stale entries
    const now = Date.now();
    for (const k of Object.keys(cache)) {
      if (cache[k]._ts && now - cache[k]._ts > TTL_MS) delete cache[k];
    }
    // Only look up symbols we can't resolve statically
    const needed = [...new Set(symbols)].filter(s => {
      const upper = s.toUpperCase();
      return !TOKEN_DISPLAY_NAMES[upper] && !MINT_PREFIX_TO_SYM[upper] && !cache[upper];
    });
    for (const sym of needed.slice(0, 8)) {  // limit to 8 API calls per session
      try {
        const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(sym)}`;
        const r   = await fetchWithTimeout(url, 8000);
        if (!r || !r.ok) continue;
        const data = await r.json();
        // Find best match: prefer pair whose baseToken symbol exactly matches
        const pair = (data.pairs || []).find(
          p => p.baseToken?.symbol?.toUpperCase() === sym.toUpperCase()
        );
        if (pair?.baseToken?.name) {
          cache[sym.toUpperCase()] = {
            symbol: pair.baseToken.symbol,
            name:   pair.baseToken.name,
            _ts:    now,
          };
        }
      } catch { /* ignore individual lookup failures */ }
    }
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {}
    return cache;
  }

  function mintToSym(mint) {
    return KNOWN_MINTS[mint] || null;
  }

  // ════════════════════════════════════════════════════════════
  // ETHEREUM / EVM IMPORT — Etherscan API
  // Fetches both native ETH transactions (txlist) AND ERC-20
  // token transfers (tokentx), deduplicates, detects DEX swaps.
  // Key priority: localStorage → window.TCMD_KEYS → error
  // ════════════════════════════════════════════════════════════
  async function importEthWallet(address, accountId, onProgress) {
    // Priority: Admin panel (localStorage) → config.js/keys.js (TCMD_KEYS)
    const etherscanKey = localStorage.getItem('tcmd_etherscan_key')
      || (typeof window !== 'undefined' && window.TCMD_KEYS?.etherscan)
      || '';
    if (!etherscanKey) {
      return {
        txns: [], error: 'No Etherscan API key configured. Add it in the Admin panel → API Keys.',
        missingKey: true,
      };
    }

    const addrLow = address.toLowerCase();
    setImportStatus(accountId, { status:'syncing', source:'ethereum', address });

    try {
      // Live ETH price in SEK for accurate fee calculation
      let ethSEK = 28000; // safe fallback (≈ ETH $2700 × SEK 10.4)
      try {
        const [sekRate, ethResp] = await Promise.all([
          fetchLiveSEKRate(),
          fetch('https://api.coincap.io/v2/assets/ethereum'),
        ]);
        if (sekRate && ethResp?.ok) {
          const ethData = await ethResp.json();
          const ethUSD  = parseFloat(ethData.data?.priceUsd || 0);
          if (ethUSD > 0) ethSEK = ethUSD * sekRate;
        }
      } catch { /* use fallback */ }

      // ── Etherscan paginator ──────────────────────────────────
      // Free tier: 3 req/s hard limit. We run txlist then tokentx
      // sequentially (never concurrent) and sleep 400ms between pages.
      // Rate-limit responses (status!='1', message contains "rate") are
      // retried once after a 1.2s back-off before throwing.
      async function paginate(action, label) {
        const rows = [];
        let page = 1, hasMore = true;
        while (hasMore) {
          // V2 endpoint — lowercase address required for V2
          const url = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=${action}` +
            `&address=${addrLow}&sort=asc&page=${page}&offset=100&apikey=${etherscanKey}`;

          let data;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const r = await fetch(url);
              if (!r.ok) { hasMore = false; break; }
              data = await r.json();
            } catch { hasMore = false; break; }

            // Rate-limit hit → back off and retry once
            if (data.status !== '1' &&
                (data.message || '').toLowerCase().includes('rate')) {
              await sleep(1200);
              data = null; // force retry
              continue;
            }
            break; // success or non-rate-limit error — stop retrying
          }

          if (!data) break; // network failure or exhausted retries

          // ① Check for API-level errors (bad key, invalid address, etc.)
          if (data.status !== '1') {
            const msg = typeof data.result === 'string' ? data.result : (data.message || 'Etherscan error');
            if (data.message === 'No transactions found') { hasMore = false; break; }
            throw new Error(`Etherscan ${action}: ${msg}`);
          }
          // ② Empty array = end of history
          if (!Array.isArray(data.result) || !data.result.length) { hasMore = false; break; }

          rows.push(...data.result);
          hasMore = data.result.length === 100;
          page++;
          if (onProgress) onProgress({ step:'import', msg:`Fetching ${label}… ${rows.length} found` });
          if (hasMore) await sleep(400); // stay safely under 3 req/s
        }
        return rows;
      }

      // Run sequentially — never fire two Etherscan requests simultaneously
      if (onProgress) onProgress({ step:'import', msg:'Fetching ETH transactions…' });
      const nativeTxs = await paginate('txlist',  'ETH transactions').catch(e => {
        if (e?.message?.startsWith('Etherscan')) throw e;
        return [];
      });
      await sleep(450); // gap between the two endpoint types
      if (onProgress) onProgress({ step:'import', msg:'Fetching token transfers…' });
      const tokenTxs = await paginate('tokentx', 'token transfers').catch(e => {
        if (e?.message?.startsWith('Etherscan')) throw e;
        return [];
      });

      if (onProgress) onProgress({
        step: 'import',
        msg: `Processing ${nativeTxs.length} ETH txns + ${tokenTxs.length} token transfers…`,
      });

      // ── Build lookups ────────────────────────────────────────
      // nativeMap: hash → native tx (for gas cost + ETH-value pairing)
      const nativeMap = {};
      for (const tx of nativeTxs) {
        if (tx.isError === '1') continue; // skip failed txns
        nativeMap[tx.hash] = tx;
      }

      // tokenGroups: hash → { ins: [], outs: [] }
      const tokenGroups = {};
      for (const tx of tokenTxs) {
        if (!tokenGroups[tx.hash]) tokenGroups[tx.hash] = { ins:[], outs:[] };
        if      (tx.to?.toLowerCase()   === addrLow) tokenGroups[tx.hash].ins.push(tx);
        else if (tx.from?.toLowerCase() === addrLow) tokenGroups[tx.hash].outs.push(tx);
      }

      const txns = [];
      const seenHashes = new Set();

      // ── Process grouped token transfers ─────────────────────
      for (const [hash, { ins, outs }] of Object.entries(tokenGroups)) {
        seenHashes.add(hash);
        const native = nativeMap[hash];
        const gasSEK = native
          ? (parseInt(native.gasUsed||0) * parseInt(native.gasPrice||0) / 1e18) * ethSEK
          : 0;
        const ts   = ins[0]?.timeStamp || outs[0]?.timeStamp || '0';
        const date = new Date(parseInt(ts) * 1000).toISOString();

        const parseAmt = tx => parseFloat(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal) || 18);

        if (ins.length > 0 && outs.length > 0) {
          // ── DEX Swap: token-out → token-in ───────────────────
          // Multiple outs/ins (e.g. multi-hop): collapse to totals
          const outSym  = outs[0].tokenSymbol?.toUpperCase();
          const outAmt  = outs.reduce((s,t) => s + parseAmt(t), 0);
          const inSym   = ins[ins.length-1].tokenSymbol?.toUpperCase(); // last in = final token
          const inAmt   = ins.reduce((s,t) => s + parseAmt(t), 0);
          txns.push(normalizeTransaction({
            txHash: hash, date, type: 'swap',
            assetSymbol: outSym,   assetName: outs[0].tokenName,
            amount:      outAmt,
            inAsset:     inSym,    inAmount: inAmt,
            feeSEK:      gasSEK,
            needsReview: false,
          }, accountId, 'eth_wallet'));

        } else if (ins.length > 0) {
          // ── Token received ────────────────────────────────────
          // If the same tx also sent ETH out → it was a buy (ETH→token)
          const nativeEthOut = native?.from?.toLowerCase() === addrLow
            && parseInt(native.value||0) > 0;
          const inTx = ins[0];
          txns.push(normalizeTransaction({
            txHash: hash, date,
            type:        nativeEthOut ? 'buy' : 'receive',
            assetSymbol: inTx.tokenSymbol?.toUpperCase(),
            assetName:   inTx.tokenName,
            amount:      ins.reduce((s,t) => s + parseAmt(t), 0),
            feeSEK:      gasSEK,
            needsReview: !nativeEthOut,
          }, accountId, 'eth_wallet'));

        } else if (outs.length > 0) {
          // ── Token sent ────────────────────────────────────────
          // If same tx received ETH in → it was a sell (token→ETH)
          const nativeEthIn = native?.to?.toLowerCase() === addrLow
            && parseInt(native.value||0) > 0;
          const outTx = outs[0];
          txns.push(normalizeTransaction({
            txHash: hash, date,
            type:        nativeEthIn ? 'sell' : 'send',
            assetSymbol: outTx.tokenSymbol?.toUpperCase(),
            assetName:   outTx.tokenName,
            amount:      outs.reduce((s,t) => s + parseAmt(t), 0),
            feeSEK:      gasSEK,
            needsReview: !nativeEthIn,
          }, accountId, 'eth_wallet'));
        }
      }

      // ── Native ETH-only transactions ─────────────────────────
      // (not already covered by token transfer grouping above)
      for (const tx of nativeTxs) {
        if (tx.isError === '1') continue;
        if (seenHashes.has(tx.hash))    continue; // already processed as a token group
        if (parseInt(tx.value||0) === 0) continue; // contract calls with no ETH value (approvals etc.)

        const isIn   = tx.to?.toLowerCase() === addrLow;
        const gasSEK = isIn ? 0  // receiver doesn't pay gas
          : (parseInt(tx.gasUsed||0) * parseInt(tx.gasPrice||0) / 1e18) * ethSEK;
        const date   = new Date(parseInt(tx.timeStamp) * 1000).toISOString();
        txns.push(normalizeTransaction({
          txHash:      tx.hash, date,
          type:        isIn ? 'receive' : 'send',
          assetSymbol: 'ETH',
          assetName:   'Ethereum',
          amount:      parseInt(tx.value) / 1e18,
          feeSEK:      gasSEK,
          needsReview: true,
        }, accountId, 'eth_wallet'));
      }

      const totalFetched = nativeTxs.length + tokenTxs.length;
      const start = txns.length ? txns.reduce((a,b) => a.date < b.date ? a : b).date : null;
      const end   = txns.length ? txns.reduce((a,b) => a.date > b.date ? a : b).date : null;
      setImportStatus(accountId, { status:'synced', totalFetched, totalTxns:txns.length, startDate:start, endDate:end });
      return { txns, totalFetched };

    } catch (e) {
      setImportStatus(accountId, { status:'failed', error:e.message });
      return { txns:[], error:e.message };
    }
  }

  // ════════════════════════════════════════════════════════════
  // PORTFOLIO LIVE DATA
  // ════════════════════════════════════════════════════════════

  // Fetch current USD→SEK rate from Frankfurter
  async function fetchLiveSEKRate() {
    try {
      const r = await fetchWithTimeout('https://api.frankfurter.app/latest?from=USD&to=SEK', 8000);
      if (!r || !r.ok) return null;
      const d = await r.json();
      return d.rates?.SEK || null;
    } catch { return null; }
  }

  // Fetch current USD prices + 24h change for a list of asset symbols (one bulk request)
  // Returns Map<SYMBOL, { priceUsd: number, changePercent24Hr: number }>
  async function fetchLivePrices(symbols) {
    const result   = new Map();
    const toFetch  = [];
    const idToSym  = {};
    for (const sym of symbols) {
      const ccId = CC_IDS[sym.toUpperCase()];
      if (ccId) { toFetch.push(ccId); idToSym[ccId] = sym.toUpperCase(); }
    }
    if (!toFetch.length) return result;
    try {
      const url = `https://api.coincap.io/v2/assets?ids=${toFetch.join(',')}`;
      const r   = await fetchWithTimeout(url, 10000);
      if (!r || !r.ok) return result;
      const data = await r.json();
      for (const asset of (data.data || [])) {
        const sym = idToSym[asset.id];
        if (sym) result.set(sym, {
          priceUsd:         parseFloat(asset.priceUsd)         || 0,
          changePercent24Hr: parseFloat(asset.changePercent24Hr) || 0,
        });
      }
    } catch {}
    return result;
  }

  // Pure: enrich currentHoldings (from computeTaxYear) with live prices and aggregate totals
  function buildPortfolioSnapshot(currentHoldings, livePrices, sekRate, allTxns) {
    sekRate = sekRate || STABLE_SEK.USD; // fallback if FX fetch failed
    let totalValueSEK     = 0;
    let totalCostSEK      = 0;
    let totalUnrealizedSEK = 0;
    let fiatInvestedSEK   = 0;
    let fiatProceedsSEK   = 0;
    let totalFeesSEK      = 0;

    const holdings = currentHoldings.map(h => {
      const live            = livePrices.get(h.symbol);
      const currentPriceSEK = live ? live.priceUsd * sekRate : null;
      const currentValueSEK = currentPriceSEK != null ? currentPriceSEK * h.quantity : null;
      const unrealizedSEK   = currentValueSEK != null ? currentValueSEK - h.totalCostSEK : null;
      const unrealizedPct   = unrealizedSEK != null && h.totalCostSEK > 0
                              ? (unrealizedSEK / h.totalCostSEK) * 100 : null;
      if (currentValueSEK != null) totalValueSEK     += currentValueSEK;
      totalCostSEK += h.totalCostSEK;
      if (unrealizedSEK   != null) totalUnrealizedSEK += unrealizedSEK;
      return { ...h, currentPriceSEK, currentValueSEK, unrealizedSEK, unrealizedPct,
               changePercent24Hr: live?.changePercent24Hr ?? null };
    });

    for (const t of (allTxns || [])) {
      if ((t.feeSEK || 0) > 0)          totalFeesSEK      += t.feeSEK;
      if (t.category === CAT.BUY  && (t.costBasisSEK || 0) > 0) fiatInvestedSEK  += t.costBasisSEK;
      if (t.category === CAT.SELL && (t.costBasisSEK || 0) > 0) fiatProceedsSEK += t.costBasisSEK;
    }

    return { holdings, totalValueSEK, totalCostSEK, totalUnrealizedSEK,
             fiatInvestedSEK, fiatProceedsSEK, totalFeesSEK, sekRate,
             fetchedAt: Date.now() };
  }

  // Build time-series of portfolio value for the chart.
  // Replays transaction history and looks up prices from cache at each month end.
  // Returns Array<{ date: string (YYYY-MM-DD), valueSEK: number }>
  function buildPortfolioHistory(allTxns, priceCache) {
    if (!allTxns?.length) return [];
    const sorted = [...allTxns]
      .filter(t => !t.isInternalTransfer &&
                   t.category !== CAT.SPAM && t.category !== CAT.APPROVAL)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    if (!sorted.length) return [];

    const hlds  = {};   // sym → quantity
    function ens(sym) { if (!hlds[sym]) hlds[sym] = 0; }

    // Collect month-end snapshots from first tx date to today
    const first = new Date(sorted[0].date);
    const now   = new Date();
    const months = [];
    const cur   = new Date(first.getFullYear(), first.getMonth(), 1);
    while (cur <= now) { months.push(new Date(cur)); cur.setMonth(cur.getMonth()+1); }

    const points = [];
    let tIdx = 0;

    for (const mStart of months) {
      const mEnd    = new Date(mStart.getFullYear(), mStart.getMonth()+1, 0);
      const dateStr = mEnd.toISOString().slice(0,10);

      // Apply all txns up to end of month
      while (tIdx < sorted.length && new Date(sorted[tIdx].date) <= mEnd) {
        const t = sorted[tIdx++];
        const sym = t.assetSymbol; if (!sym) continue;
        ens(sym);
        const cat = t.category;
        if ([CAT.BUY, CAT.TRANSFER_IN, CAT.RECEIVE, CAT.INCOME].includes(cat))
          hlds[sym] = (hlds[sym]||0) + (t.amount||0);
        else if ([CAT.SELL, CAT.SEND, CAT.TRANSFER_OUT].includes(cat))
          hlds[sym] = Math.max(0, (hlds[sym]||0) - (t.amount||0));
        else if (cat === CAT.TRADE) {
          hlds[sym] = Math.max(0, (hlds[sym]||0) - (t.amount||0));
          if (t.inAsset && t.inAmount > 0) { ens(t.inAsset); hlds[t.inAsset] = (hlds[t.inAsset]||0) + t.inAmount; }
        }
      }

      // Value at month end using price cache
      let valueSEK = 0, hasPrice = false;
      for (const [sym, qty] of Object.entries(hlds)) {
        if (qty <= 1e-9) continue;
        const ccId  = CC_IDS[sym]; if (!ccId) continue;
        const price = priceCache[`${ccId}_${dateStr}`];
        if (price > 0) { valueSEK += price * qty; hasPrice = true; }
      }
      if (hasPrice) points.push({ date: dateStr, valueSEK });
    }
    return points;
  }

  // Build cost-basis time-series for the chart — no price cache needed.
  // Uses transaction costBasisSEK to replay cumulative holdings value month by month.
  // Falls back to this when buildPortfolioHistory returns nothing (e.g. unknown tokens).
  // Returns Array<{ date: string (YYYY-MM-DD), valueSEK: number, isCostBasis: true }>
  function buildCostBasisHistory(allTxns) {
    if (!allTxns?.length) return [];
    const sorted = [...allTxns]
      .filter(t => !t.isInternalTransfer &&
                   t.category !== CAT.SPAM && t.category !== CAT.APPROVAL)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    if (!sorted.length) return [];

    // Track average-cost per symbol: { qty, totalCostSEK }
    const hlds = {};
    function ens(sym) { if (!hlds[sym]) hlds[sym] = { qty: 0, totalCostSEK: 0 }; }

    const first = new Date(sorted[0].date);
    const now   = new Date();
    const cur   = new Date(first.getFullYear(), first.getMonth(), 1);
    const months = [];
    while (cur <= now) { months.push(new Date(cur)); cur.setMonth(cur.getMonth() + 1); }

    const points = [];
    let tIdx = 0;

    for (const mStart of months) {
      const mEnd    = new Date(mStart.getFullYear(), mStart.getMonth() + 1, 0);
      const dateStr = mEnd.toISOString().slice(0, 10);

      // Replay all txns up to month end
      while (tIdx < sorted.length && new Date(sorted[tIdx].date) <= mEnd) {
        const t   = sorted[tIdx++];
        const sym = t.assetSymbol; if (!sym) continue;
        ens(sym);
        const cost = t.costBasisSEK || 0;
        const cat  = t.category;
        if ([CAT.BUY, CAT.TRANSFER_IN, CAT.RECEIVE, CAT.INCOME].includes(cat)) {
          hlds[sym].qty          += (t.amount || 0);
          hlds[sym].totalCostSEK += cost;
        } else if ([CAT.SELL, CAT.SEND, CAT.TRANSFER_OUT].includes(cat)) {
          const qty    = hlds[sym].qty;
          const remove = Math.min(t.amount || 0, qty);
          const avg    = qty > 0 ? hlds[sym].totalCostSEK / qty : 0;
          hlds[sym].qty          = Math.max(0, qty - remove);
          hlds[sym].totalCostSEK = Math.max(0, hlds[sym].totalCostSEK - avg * remove);
        } else if (cat === CAT.TRADE) {
          const qty    = hlds[sym].qty;
          const remove = Math.min(t.amount || 0, qty);
          const avg    = qty > 0 ? hlds[sym].totalCostSEK / qty : 0;
          hlds[sym].qty          = Math.max(0, qty - remove);
          hlds[sym].totalCostSEK = Math.max(0, hlds[sym].totalCostSEK - avg * remove);
          if (t.inAsset && t.inAmount > 0) {
            ens(t.inAsset);
            hlds[t.inAsset].qty          += t.inAmount;
            hlds[t.inAsset].totalCostSEK += cost;
          }
        }
      }

      const totalCostSEK = Object.values(hlds).reduce((s, h) => s + (h.totalCostSEK || 0), 0);
      if (totalCostSEK > 0) points.push({ date: dateStr, valueSEK: totalCostSEK, isCostBasis: true });
    }
    return points;
  }

  // ── Utilities ─────────────────────────────────────────────
  function formatSEK(amt, d=0) {
    if (amt===null||amt===undefined||isNaN(amt)) return '—';
    return new Intl.NumberFormat('sv-SE',{style:'currency',currency:'SEK',minimumFractionDigits:d,maximumFractionDigits:d}).format(amt);
  }
  function formatCrypto(amt, d=6) {
    if (!amt && amt!==0) return '—';
    return parseFloat(amt).toLocaleString('sv-SE',{minimumFractionDigits:0,maximumFractionDigits:d});
  }
  function getAvailableTaxYears() {
    const txns = getTransactions();
    if (!txns.length) { const y=new Date().getFullYear(); return [y-1,y]; }
    const years = [...new Set(txns.map(t => new Date(t.date).getFullYear()))].sort();
    const cur = new Date().getFullYear();
    if (!years.includes(cur)) years.push(cur);
    return years;
  }

  // ── Public API ────────────────────────────────────────────
  return {
    CAT, REVIEW_DESCRIPTIONS,
    // Settings
    getSettings, saveSettings,
    // Accounts
    getAccounts, addAccount, removeAccount, updateAccount,
    getImportStatus, setImportStatus,
    // Transactions
    loadTransactions,
    getTransactions, saveTransactions, addTransactions,
    deleteTransaction, updateTransaction,
    normalizeTransaction,
    // Pipeline
    runPipeline, Events,
    // Classification
    autoClassifyAll, matchTransfers,
    // Prices
    fetchAllSEKPrices, getPriceCache, savePriceCache,
    // Tax engine
    computeTaxYear,
    // K4 export
    generateK4Report, generateK4CSV, generateAuditCSV,
    // Review
    getReviewIssues, isTaxableCategory,
    // CSV parsers
    parseBinanceCSV, parseKrakenCSV, parseBybitCSV, parseCoinbaseCSV, parseGenericCSV,
    // Blockchain import
    importSolanaWallet, importEthWallet,
    // Portfolio live data
    fetchLiveSEKRate, fetchLivePrices, buildPortfolioSnapshot, buildPortfolioHistory, buildCostBasisHistory,
    // Token name resolution
    resolveTokenDisplay, resolveUnknownTokenNames,
    // Utils
    formatSEK, formatCrypto, getAvailableTaxYears,
    isPipelineRunning: () => _pipelineRunning,
  };
})();
