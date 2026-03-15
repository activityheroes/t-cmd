/* ============================================================
   T-CMD — Swedish Crypto Tax Engine v2
   Full pipeline: import → classify → match transfers →
     fetch SEK prices → compute tax → K4 export
   Implements Genomsnittsmetoden per Skatteverket.
   ============================================================ */

const TaxEngine = (() => {

  // ── Swedish Tax Rules ─────────────────────────────────────
  const TAX_RATE = 0.30;
  const LOSS_DEDUCTION = 0.70;
  const ROWS_PER_K4_FORM = 7;

  // ── Stablecoins (treated as SEK-proxies at 1 USD ≈ current rate) ──
  // USD-pegged stablecoins — any of these with missing price data gets 1 USD fallback
  const STABLES = new Set([
    // Major USD stables
    'USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'USDP', 'USDS', 'USDE',
    'PYUSD', 'FDUSD', 'GUSD', 'HUSD', 'USDM', 'SUSD', 'USDX',
    // Algorithmic / yield-bearing USD stables
    'FRAX', 'LUSD', 'MIM', 'FEI', 'RAI', 'USDJ', 'USDD', 'CRVUSD',
    'ALUSD', 'DOLA', 'BEAN', 'USDN', 'CUSD', 'MUSD',
    // LP stablecoin representations often used in DeFi
    '3CRV', 'USDC-LP', 'DAI-LP',
    // EUR-pegged stablecoins
    'EUROC', 'EURC', 'EURT', 'EURS', 'AGEUR', 'EURA',
  ]);
  // EUR-pegged subset (priced at EUR rate instead of USD rate)
  const EUR_STABLES = new Set(['EUROC', 'EURC', 'EURT', 'EURS', 'AGEUR', 'EURA']);
  // ── Major assets with deep liquidity (used to prioritise swap-leg derivation) ──
  const MAJOR_ASSETS = new Set(['BTC','ETH','SOL','BNB','MATIC','AVAX','DOT','ADA','WETH','WBTC','WBNB','POL']);
  // Approx SEK per USD / EUR  (used when CoinGecko is unavailable for stablecoins)
  const STABLE_SEK = { USD: 10.4, EUR: 11.2 };

  // ── Global asset canonical identities ─────────────────────
  // Maps alternate/wrapped/bridged names → canonical symbol.
  // Used so the same economic asset is tracked as one across chains/sources.
  // Wrap/unwrap are NON-TAXABLE in Sweden (same economic exposure);
  // bridged USDC variants collapse to USDC for cost-basis continuity.
  const ASSET_CANONICAL = {
    // Wrapped native tokens — economically identical; treated as same asset
    'WETH'    : 'ETH',  'WBTC'  : 'BTC',   'WSOL'  : 'SOL',
    'WBNB'    : 'BNB',  'WMATIC': 'MATIC',  'WAVAX' : 'AVAX',
    'WFTM'    : 'FTM',  'WCRO'  : 'CRO',   'WONE'  : 'ONE',
    'WROSE'   : 'ROSE', 'WKAVA' : 'KAVA',
    // Bridged USDC variants (Polygon, Base, Arbitrum, Optimism, etc.)
    'USDC.E'  : 'USDC', 'USDCE' : 'USDC',  'USDC.B': 'USDC',
    'BRIDGED_USDC': 'USDC', 'USD_COIN': 'USDC',
    'USDCAV2': 'USDC', 'USDC2' : 'USDC',
    // Bridged USDT
    'USDT.E'  : 'USDT', 'USDT.B': 'USDT', 'USDTAV2': 'USDT',
    // Bridged DAI variants
    'DAI.E'   : 'DAI',  'BDAI'  : 'DAI',
    // Frax variants
    'FRAXBP'  : 'FRAX',
    // Curve USD
    'CRVUSD'  : 'CRVUSD',
    // Staked / liquid-staked ETH (same economic exposure for Swedish tax)
    'STETH'   : 'ETH',  'WSTETH': 'ETH',   'BETH'  : 'ETH',   'RETH': 'ETH',
    // Staked SOL representations
    'MSOL'    : 'SOL',  'STSOL' : 'SOL',   'JITOSOL': 'SOL',
    // Alternate native names used by some APIs
    'XBT'     : 'BTC',  'XETH'  : 'ETH',
  };

  // Returns the canonical symbol for any asset, normalising wraps + bridged variants.
  // Preserves unknowns unchanged so pricing/classification still gets original name.
  function normalizeAssetSymbol(sym) {
    if (!sym) return sym;
    const upper = sym.trim().toUpperCase();
    return ASSET_CANONICAL[upper] || upper;
  }

  // ── CoinGecko asset ID mapping — free, no auth required ──────────
  // CoinGecko IDs (primary price source — free tier, no auth required)
  // Note: differs from CoinCap on BNB, AVAX, MATIC, NEAR, ARB etc.
  const CC_IDS = {
    BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin',
    ADA: 'cardano', DOT: 'polkadot', AVAX: 'avalanche-2', MATIC: 'matic-network',
    LINK: 'chainlink', UNI: 'uniswap', ATOM: 'cosmos', NEAR: 'near',
    OP: 'optimism', ARB: 'arbitrum', INJ: 'injective-protocol', APT: 'aptos',
    SUI: 'sui', DOGE: 'dogecoin', LTC: 'litecoin', XRP: 'ripple',
    SHIB: 'shiba-inu', PEPE: 'pepe', WIF: 'dogwifhat', BONK: 'bonk',
    JUP: 'jupiter', PYTH: 'pyth-network', SEI: 'sei-network', TIA: 'celestia',
    STRK: 'starknet', TON: 'the-open-network',
    USDT: 'tether', USDC: 'usd-coin', BUSD: 'binance-usd', DAI: 'dai',
    WETH: 'weth', WBTC: 'wrapped-bitcoin', WSOL: 'wrapped-solana',
    ALGO: 'algorand', FTM: 'fantom', SAND: 'the-sandbox', MANA: 'decentraland',
    CRV: 'curve-dao-token', AAVE: 'aave', COMP: 'compound-governance-token',
    SNX: 'havven', MKR: 'maker', LDO: 'lido-dao', RPL: 'rocket-pool',
    RUNE: 'thorchain', GRT: 'the-graph', FIL: 'filecoin', ICP: 'internet-computer',
    VET: 'vechain', HBAR: 'hedera-hashgraph', ETC: 'ethereum-classic',
    BCH: 'bitcoin-cash', EOS: 'eos', ZEC: 'zcash', XMR: 'monero',
    RAY: 'raydium', ORCA: 'orca', MNGO: 'mango-markets',
  };

  // ── Transaction Categories ────────────────────────────────
  const CAT = {
    // Core taxable events
    BUY: 'buy', SELL: 'sell', TRADE: 'trade',
    // Movements — may or may not be taxable depending on context
    RECEIVE: 'receive', SEND: 'send',
    INCOME: 'income',                         // Staking reward, lending interest, referral
    AIRDROP: 'airdrop',                       // Airdrop received — income at FMV (Skatteverket)
    FEE: 'fee',
    TRANSFER_IN: 'transfer_in', TRANSFER_OUT: 'transfer_out',  // Internal moves
    // Bridge / cross-chain — granular so matcher can pair them
    BRIDGE_IN: 'bridge_in',                   // Funds arriving from another chain
    BRIDGE_OUT: 'bridge_out',                 // Funds sent to another chain
    BRIDGE: 'bridge',                         // Legacy / unspecified direction
    // Token wrapping — non-taxable in Sweden (same economic exposure)
    WRAP: 'wrap',                             // ETH → WETH
    UNWRAP: 'unwrap',                         // WETH → ETH
    // Non-economic
    SPAM: 'spam', APPROVAL: 'approval',
    STAKING: 'staking', NFT_SALE: 'nft_sale',
    DEFI_UNKNOWN: 'defi_unknown',
    // Inventory reconstruction
    UNKNOWN_ACQUISITION: 'unknown_acquisition', // Disposal with no traceable prior acquisition
  };

  // ── Storage Keys (price cache remains localStorage; rest moves to Supabase) ──
  const LS = {
    PRICES: 'tcmd_tax_prices',
  };

  // ── Pipeline Event Emitter ────────────────────────────────
  const _listeners = {};
  const Events = {
    on(ev, fn) { (_listeners[ev] = _listeners[ev] || []).push(fn); },
    off(ev, fn) { _listeners[ev] = (_listeners[ev] || []).filter(f => f !== fn); },
    emit(ev, d) { (_listeners[ev] || []).forEach(fn => { try { fn(d); } catch { } }); },
  };

  // ── Settings (in-memory cache loaded from Supabase) ──────
  let _settingsCache = null;
  function getSettings() {
    const def = {
      currency: 'SEK', taxYear: new Date().getFullYear() - 1,
      country: 'SE', method: 'genomsnittsmetoden',
      userName:     '',   // Namn — shown in K4 PDF header
      personnummer: '',   // Personnummer YYYYMMDD-XXXX — shown in K4 PDF header
    };
    return _settingsCache ? { ...def, ..._settingsCache } : def;
  }
  async function loadSettings() {
    try { _settingsCache = await SupabaseDB.getUserData('tax_settings', null); } catch { }
  }
  function saveSettings(s) {
    _settingsCache = s;
    SupabaseDB.setUserData('tax_settings', s).catch(e => console.warn('[TaxEngine] saveSettings:', e.message));
  }

  // ── One-time migration from the legacy 'anon' namespace ──
  // Before the _uid() bug fix, every user resolved to 'anon' and data was
  // stored under tcmd_anon_* keys / tcmd_tax_anon IDB.
  // This migration runs once per user after the fix:
  //   • If the user's own scoped key is empty AND the anon key has data →
  //     copy anon data to the user's scoped key and DELETE the anon key so
  //     no second user can claim the same data.
  //   • If both are empty or the user already has their own data → no-op.
  async function _migrateAnonData(uid) {
    if (!uid || uid === 'anon') return;
    const migrationFlag = `tcmd_${uid}_anonMigrated`;
    if (localStorage.getItem(migrationFlag)) return; // already done
    localStorage.setItem(migrationFlag, '1');

    const KEYS = ['tax_accounts', 'tax_settings', 'tax_import_status'];
    for (const key of KEYS) {
      const userKey = `tcmd_${uid}_${key}`;
      const anonKey = `tcmd_anon_${key}`;
      const userHasData = localStorage.getItem(userKey);
      const anonData    = localStorage.getItem(anonKey);
      if (!userHasData && anonData && anonData !== 'null' && anonData !== '[]' && anonData !== '{}') {
        console.log(`[TaxEngine] Migrating ${anonKey} → ${userKey}`);
        localStorage.setItem(userKey, anonData);
        localStorage.removeItem(anonKey); // prevent other users from claiming it
      } else if (anonData) {
        // Anon key exists but user already has their own data — just clear the anon key
        localStorage.removeItem(anonKey);
      }
    }

    // IDB migration: if tcmd_tax_anon has transactions and the user's DB is empty → migrate
    try {
      const anonTxns = await new Promise(res => {
        const req = indexedDB.open('tcmd_tax_anon', 1);
        req.onsuccess = e => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('transactions')) { db.close(); res([]); return; }
          const tx = db.transaction('transactions', 'readonly');
          tx.objectStore('transactions').getAll().onsuccess = ev => {
            db.close(); res(ev.target.result || []);
          };
        };
        req.onerror = () => res([]);
      });
      if (anonTxns.length > 0) {
        const userDbName = `tcmd_tax_${uid}`;
        const userTxns = await new Promise(res => {
          const req = indexedDB.open(userDbName, 1);
          req.onupgradeneeded = e => e.target.result.createObjectStore('transactions', { keyPath: 'id' });
          req.onsuccess = e => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('transactions')) { db.close(); res([]); return; }
            db.transaction('transactions', 'readonly').objectStore('transactions').getAll()
              .onsuccess = ev => { db.close(); res(ev.target.result || []); };
          };
          req.onerror = () => res([]);
        });
        if (userTxns.length === 0) {
          // User's DB is empty — migrate anon transactions to their scoped DB
          console.log(`[TaxEngine] Migrating ${anonTxns.length} transactions from tcmd_tax_anon → ${userDbName}`);
          const req = indexedDB.open(userDbName, 1);
          req.onsuccess = e => {
            const db = e.target.result;
            const tx = db.transaction('transactions', 'readwrite');
            const store = tx.objectStore('transactions');
            anonTxns.forEach(t => store.put(t));
            tx.oncomplete = () => {
              db.close();
              // Delete the anon database to prevent other users claiming it
              indexedDB.deleteDatabase('tcmd_tax_anon');
            };
          };
        } else {
          // User already has data — just wipe anon DB
          indexedDB.deleteDatabase('tcmd_tax_anon');
        }
      }
    } catch (e) {
      console.warn('[TaxEngine] IDB migration error:', e.message);
    }
  }

  // ── Accounts (in-memory cache loaded from Supabase) ──────
  let _accountsCache = [];
  function getAccounts() { return _accountsCache; }
  async function loadAccounts() {
    try { _accountsCache = await SupabaseDB.getUserData('tax_accounts', []); } catch { _accountsCache = []; }
  }
  function saveAccounts(a) {
    _accountsCache = a;
    SupabaseDB.setUserData('tax_accounts', a).catch(e => console.warn('[TaxEngine] saveAccounts:', e.message));
  }
  function addAccount(acc) {
    const accs = getAccounts();
    const id = 'acc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const n = { id, addedAt: new Date().toISOString(), syncStatus: 'never_synced', ...acc };
    accs.push(n); saveAccounts(accs); return n;
  }
  function removeAccount(id) {
    saveAccounts(getAccounts().filter(a => a.id !== id));
    saveTransactions(getTransactions().filter(t => t.accountId !== id));
    setImportStatus(id, null);
    // Also purge any raw events stored by the 12-stage pipeline for this account.
    // Prevents stale Helius/Etherscan data from being replayed on next pipeline run.
    if (typeof TaxPipeline !== 'undefined' && TaxPipeline.RawDataStore) {
      TaxPipeline.RawDataStore.deleteByAccount(id).catch(e =>
        console.warn('[TaxEngine] RawDataStore purge failed:', e.message));
    }
  }
  function clearAllData() {
    saveAccounts([]);
    saveTransactions([]);
    _importStatusCache = {};
    SupabaseDB.setUserData('tax_import_status', {}).catch(() => {});
  }
  function updateAccount(id, data) {
    saveAccounts(getAccounts().map(a => a.id === id ? { ...a, ...data } : a));
  }

  // ── Import Status (in-memory cache) ───────────────────────
  let _importStatusCache = {};
  function getImportStatuses() { return _importStatusCache; }
  async function loadImportStatuses() {
    try { _importStatusCache = await SupabaseDB.getUserData('tax_import_status', {}); } catch { _importStatusCache = {}; }
  }
  function setImportStatus(accountId, status) {
    if (status === null) { delete _importStatusCache[accountId]; }
    else { _importStatusCache[accountId] = { ..._importStatusCache[accountId], ...status, updatedAt: new Date().toISOString() }; }
    SupabaseDB.setUserData('tax_import_status', _importStatusCache).catch(e => console.warn('[TaxEngine] importStatus:', e.message));
  }
  function getImportStatus(accountId) { return getImportStatuses()[accountId] || { status: 'never_synced' }; }

  // ── IndexedDB helpers (no 5 MB quota limit) ───────────────
  // Database name is user-scoped so sessions belonging to different users
  // on the same browser NEVER share transaction data.
  const IDB_STORE   = 'transactions';
  const IDB_VERSION = 1;

  // Returns a user-specific IDB name.
  // Falls back to a generic name only when no user is authenticated yet.
  function _idbName() {
    try {
      const uid = SupabaseDB.getCurrentUserId?.() || 'anon';
      return `tcmd_tax_${uid}`;
    } catch { return 'tcmd_tax_anon'; }
  }

  // Track the last user who loaded data so we can wipe stale cache on switch.
  let _idbLastUserId = null;

  function idbOpen() {
    const dbName = _idbName();
    return new Promise((res, rej) => {
      const req = indexedDB.open(dbName, IDB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE))
          db.createObjectStore(IDB_STORE, { keyPath: 'id' });
      };
      req.onsuccess = e => res(e.target.result);
      req.onerror = e => rej(e.target.error);
    });
  }

  // Call this on login/logout to drop the in-memory transaction cache
  // so the next loadTransactions() reads from the correct user's IDB.
  function clearUserCache() {
    _txCache          = null;
    _accountsCache    = [];
    _settingsCache    = null;
    _idbLastUserId    = null;
    _importStatusCache = {};
    if (_cloudSyncTimer) { clearTimeout(_cloudSyncTimer); _cloudSyncTimer = null; }
  }

  // ── Cloud sync (cross-browser) ─────────────────────────────
  // Transactions are stored in IndexedDB (browser-local) for performance.
  // We also maintain a cloud backup in Supabase so that logging in from
  // a different browser (e.g. Safari → Chrome) restores the full history.
  //
  // Strategy:
  //   • Writes: debounced 3 s after the last saveTransactions() call.
  //     Chunked into CLOUD_CHUNK_SIZE rows so no single JSON value is
  //     too large for Supabase's jsonb column.
  //   • Reads:  on loadTransactions(), if IndexedDB comes back empty
  //     AND Supabase has cloud data, we pull it down and repopulate IDB.
  const CLOUD_CHUNK_SIZE = 1000; // transactions per Supabase row
  let _cloudSyncTimer = null;

  function _scheduleCloudSync(txns) {
    if (!SUPABASE_READY) return; // no Supabase → nothing to sync
    if (_cloudSyncTimer) clearTimeout(_cloudSyncTimer);
    _cloudSyncTimer = setTimeout(() => {
      _cloudSyncTimer = null;
      _pushTransactionsToCloud(txns).catch(e =>
        console.warn('[TaxEngine] cloud sync failed:', e.message));
    }, 3000);
  }

  async function _pushTransactionsToCloud(txns) {
    if (!SUPABASE_READY || !txns) return;
    const chunks = [];
    for (let i = 0; i < txns.length; i += CLOUD_CHUNK_SIZE)
      chunks.push(txns.slice(i, i + CLOUD_CHUNK_SIZE));
    if (chunks.length === 0) chunks.push([]); // keep meta even when empty

    // Write each chunk
    for (let i = 0; i < chunks.length; i++) {
      await SupabaseDB.setUserData(`tax_txns_chunk_${i}`, chunks[i]);
    }
    // Write metadata (so the reader knows how many chunks to expect)
    await SupabaseDB.setUserData('tax_txns_meta', {
      chunks:    chunks.length,
      total:     txns.length,
      syncedAt:  new Date().toISOString(),
    });
    const syncedAt = new Date().toISOString();
    console.log(`[TaxEngine] Synced ${txns.length} transactions to cloud (${chunks.length} chunks)`);
    // Notify the UI so it can update the sync timestamp display
    try { window.dispatchEvent(new CustomEvent('taxCloudSynced', { detail: { count: txns.length, syncedAt } })); } catch { }
  }

  async function _pullTransactionsFromCloud() {
    if (!SUPABASE_READY) return null;
    try {
      const meta = await SupabaseDB.getUserData('tax_txns_meta', null);
      if (!meta || !meta.chunks || meta.total === 0) return null;
      const all = [];
      for (let i = 0; i < meta.chunks; i++) {
        const chunk = await SupabaseDB.getUserData(`tax_txns_chunk_${i}`, []);
        all.push(...chunk);
      }
      console.log(`[TaxEngine] Restored ${all.length} transactions from cloud`);
      return all.length ? all : null;
    } catch (e) {
      console.warn('[TaxEngine] cloud pull failed:', e.message);
      return null;
    }
  }

  async function idbSaveAll(txns) {
    try {
      const db = await idbOpen();
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      store.clear();
      for (const t of txns) store.put(t);
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    } catch (e) {
      // Fallback: try localStorage (may fail for large datasets)
      console.warn('[TaxEngine] IDB write failed, trying localStorage:', e.message);
      try { localStorage.setItem('tcmd_tax_transactions', JSON.stringify(txns)); } catch { }
    }
  }

  async function idbLoadAll() {
    try {
      const db = await idbOpen();
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      return await new Promise((res, rej) => {
        const req = store.getAll();
        req.onsuccess = () => res(req.result || []);
        req.onerror = () => rej(req.error);
      });
    } catch (e) {
      console.warn('[TaxEngine] IDB read failed, falling back to localStorage:', e.message);
      try { return JSON.parse(localStorage.getItem('tcmd_tax_transactions') || '[]'); } catch { return []; }
    }
  }

  // ── Transactions (in-memory cache backed by IndexedDB) ────
  let _txCache = null;  // null = not yet loaded

  function getTransactions() { return _txCache || []; }

  function saveTransactions(txns) {
    _txCache = txns;
    idbSaveAll(txns).catch(e => console.warn('[TaxEngine] saveTransactions error:', e));
    if (txns.length === 0) {
      // When ALL transactions are cleared, push the empty state to cloud
      // IMMEDIATELY (no debounce). Without this, a page reload within the
      // 3-second window would find IDB empty → fall back to cloud → restore
      // the deleted transactions as if the delete never happened.
      if (_cloudSyncTimer) { clearTimeout(_cloudSyncTimer); _cloudSyncTimer = null; }
      _pushTransactionsToCloud([]).catch(e =>
        console.warn('[TaxEngine] cloud clear failed:', e.message));
    } else {
      // For normal saves, debounce to avoid hammering Supabase on rapid edits.
      _scheduleCloudSync(txns);
    }
  }

  async function loadTransactions() {
    // Detect user switch: if the current user differs from the last loaded user,
    // wipe the in-memory cache so stale data is never served to the wrong user.
    const currentUid = SupabaseDB.getCurrentUserId?.() || 'anon';
    if (_idbLastUserId !== null && _idbLastUserId !== currentUid) {
      console.log('[TaxEngine] User changed — clearing transaction cache');
      clearUserCache();
    }
    if (_txCache !== null) return;  // already loaded for this user

    // Run one-time migration from the legacy 'anon' namespace (see _migrateAnonData above).
    // Only runs once per user (guarded by a migration flag in localStorage).
    await _migrateAnonData(currentUid);
    _idbLastUserId = currentUid;
    _txCache = await idbLoadAll();

    // One-time migration: if IDB is empty, check legacy (un-scoped) localStorage key
    if (!_txCache.length) {
      try {
        const raw = localStorage.getItem('tcmd_tax_transactions');
        if (raw) {
          _txCache = JSON.parse(raw);
          await idbSaveAll(_txCache);
          localStorage.removeItem('tcmd_tax_transactions');
          console.log('[TaxEngine] Migrated', _txCache.length, 'transactions from localStorage to IDB');
        }
      } catch { }
    }

    // Cross-browser restore: if IDB is still empty, try pulling from Supabase cloud backup.
    // This is how transactions move from Safari → Chrome (or any other browser pair).
    if (!_txCache.length && SUPABASE_READY) {
      const cloudTxns = await _pullTransactionsFromCloud();
      if (cloudTxns && cloudTxns.length) {
        _txCache = cloudTxns;
        await idbSaveAll(_txCache); // populate local IDB so future loads are instant
        console.log('[TaxEngine] Restored', _txCache.length, 'transactions from cloud backup');
      }
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

  function deleteTransaction(id) { saveTransactions(getTransactions().filter(t => t.id !== id)); }
  function updateTransaction(id, data) { saveTransactions(getTransactions().map(t => t.id === id ? { ...t, ...data } : t)); }

  function mkId() { return 'txn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

  // Derive the blockchain network name from the import source string.
  // Used by the pricing engine to call GeckoTerminal with the right network.
  function chainFromSource(src) {
    if (!src) return null;
    const s = src.toLowerCase();
    if (s.includes('solana') || s.includes('sol_')) return 'solana';
    if (s.includes('base'))        return 'base';
    if (s.includes('arbitrum') || s.includes('arb')) return 'arbitrum';
    if (s.includes('optimism') || s.includes('_op')) return 'optimism';
    if (s.includes('polygon') || s.includes('matic')) return 'polygon_pos';
    if (s.includes('avax') || s.includes('avalanche')) return 'avax';
    if (s.includes('bsc') || s.includes('binance_wallet')) return 'bsc';
    if (s.includes('eth') || s.includes('ethereum')) return 'eth';
    return null;
  }

  // ── Normalise raw → standard transaction ─────────────────
  function normalizeTransaction(raw, accountId, source) {
    // Promote rawType from the source record so classification works
    // after storage reload without needing the full raw object.
    const rawType = (raw.type || raw.side || raw.category || raw.transactionType || '').toLowerCase();
    // Preserve the original symbol before normalization — it may be the contract/mint address
    // and is needed by the GeckoTerminal pricing layer.
    const rawSymbol = (raw.assetSymbol || raw.symbol || raw.asset || '').trim();
    const normalizedSym = normalizeAssetSymbol(rawSymbol.toUpperCase());
    return {
      id: raw.id || mkId(),
      accountId,
      source,
      chain: raw.chain || chainFromSource(source),
      txHash: raw.txHash || raw.hash || raw.id || ('manual_' + Date.now()),
      date: parseDate(raw.date || raw.timestamp) || new Date().toISOString(),
      category: raw.category || CAT.RECEIVE,
      autoClassified: false,
      isInternalTransfer: false,
      assetSymbol: normalizedSym,
      // contractAddress: the original on-chain address before symbol resolution
      // Used for GeckoTerminal pricing when the token isn't in CoinGecko
      contractAddress: raw.contractAddress || raw.mintAddress
                    || (looksLikeContractAddress(rawSymbol) ? rawSymbol : null),
      assetName: raw.assetName || '',
      coinGeckoId: raw.coinGeckoId || CC_IDS[normalizedSym] || null,
      amount: Math.abs(parseFloat(raw.amount || 0)),
      inAsset: normalizeAssetSymbol((raw.inAsset || '').toUpperCase()),
      inAmount: Math.abs(parseFloat(raw.inAmount || 0)),
      priceSEKPerUnit: parseFloat(raw.priceSEKPerUnit || 0),
      costBasisSEK: parseFloat(raw.costBasisSEK || 0),
      feeSEK: parseFloat(raw.feeSEK || 0),
      priceSource: raw.priceSource || null,
      needsReview: raw.needsReview !== undefined ? raw.needsReview : true,
      reviewReason: raw.reviewReason || null,
      notes: raw.notes || '',
      rawType,        // stored for re-classification; no full _raw object saved
      // Exchange execution price (Level 1 pricing)
      rawTradePrice: parseFloat(raw.rawTradePrice) || null,
      rawTradeCurrency: (raw.rawTradeCurrency || '').toUpperCase() || null,
      // Solana swap metadata
      solanaSwapType: raw.solanaSwapType || null,
      // Reconstruction debug metadata (set by normalizeSolanaTx)
      _reconstruction: raw._reconstruction || null,
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

  const SPAM_PATTERNS = [/airdrop.*claim/i, /free.*token/i, /visit.*to.*claim/i, /reward.*claim/i,
    /\$\d+.*airdrop/i, /claim.*reward/i, /visit.*site/i, /connect.*wallet/i, /whitelist/i];

  // ── Spam / scam token symbol heuristics ─────────────────
  // A symbol is "contract-like" if it looks like an unresolved address.
  // ETH: starts with 0x, Solana: base58 string > 12 chars, or truncated 8-char hex prefix
  function looksLikeContractAddress(sym) {
    if (!sym) return false;
    if (sym.startsWith('0x') && sym.length > 10) return true;      // ETH address
    if (/^[1-9A-HJ-NP-Za-km-z]{32,}$/.test(sym)) return true;     // Full Solana mint
    if (/^[A-F0-9]{8}$/.test(sym.toUpperCase())) return true;       // 8-char hex prefix
    return false;
  }

  // ════════════════════════════════════════════════════════════
  // STEP 1 — DECODE ON-CHAIN EVENTS
  // Fix raw blockchain events BEFORE classification:
  // • Merge split-swap rows (same txHash, multiple asset transfers)
  // • Detect ETH ↔ token patterns
  // • Tag transactions with wallet + blockchain metadata
  // ════════════════════════════════════════════════════════════
  function decodeOnChainEvents(txns) {
    // Group by txHash (only relevant for on-chain sources)
    const byHash = {};
    for (const t of txns) {
      if (!t.txHash || t.txHash.startsWith('manual_') || t.manualCategory) continue;
      (byHash[t.txHash] = byHash[t.txHash] || []).push(t);
    }

    const toRemove = new Set();
    const toAdd = [];

    for (const [hash, group] of Object.entries(byHash)) {
      if (group.length < 2) continue;

      // Skip if any are already manually classified or from exchange CSVs
      if (group.some(t => t.manualCategory || t.source?.includes('_csv'))) continue;

      // Detect split swaps: one group has one SEND and one RECEIVE of DIFFERENT assets
      const sends = group.filter(t =>
        t.rawType === 'send' || t.rawType === 'transfer_out' || t.category === CAT.SEND || t.category === CAT.TRANSFER_OUT
      );
      const receives = group.filter(t =>
        t.rawType === 'receive' || t.rawType === 'transfer_in' || t.category === CAT.RECEIVE || t.category === CAT.TRANSFER_IN
      );

      if (sends.length >= 1 && receives.length >= 1) {
        const sendSym = sends[0].assetSymbol;
        const recvSym = receives[receives.length - 1].assetSymbol; // last received = final token

        if (sendSym && recvSym && sendSym !== recvSym) {
          // Merge into one TRADE event — remove all sub-rows, add one merged row
          const totalSentAmt = sends.reduce((s, t) => s + (t.amount || 0), 0);
          const totalRecvAmt = receives.reduce((s, t) => s + (t.amount || 0), 0);
          const totalFee = group.reduce((s, t) => s + (t.feeSEK || 0), 0);
          const date = group.reduce((a, b) => a.date < b.date ? a : b).date;

          for (const t of group) toRemove.add(t.id);
          toAdd.push(normalizeTransaction({
            id: 'dec_' + hash.slice(0, 12) + '_' + Math.random().toString(36).slice(2, 6),
            txHash: hash,
            date,
            type: 'swap',
            assetSymbol: sendSym,
            assetName: sends[0].assetName || sendSym,
            amount: totalSentAmt,
            inAsset: recvSym,
            inAmount: totalRecvAmt,
            feeSEK: totalFee,
            needsReview: sends[0].needsReview && receives[0].needsReview,
            notes: `Decoded swap from ${group.length} sub-events`,
          }, sends[0].accountId, sends[0].source));
        }
      }
    }

    // Apply merges
    if (toAdd.length > 0 || toRemove.size > 0) {
      const result = txns.filter(t => !toRemove.has(t.id));
      return [...result, ...toAdd];
    }
    return txns;
  }

  // ════════════════════════════════════════════════════════════
  // STEP 2 — RESOLVE TOKEN METADATA
  // Batch-resolve unknown token symbols to human-readable names.
  // Runs BEFORE classification so detectCategory() has clean symbols.
  // ════════════════════════════════════════════════════════════
  async function resolveAllTokenMetadata(txns, onProgress) {
    // Collect symbols that look like contract addresses or are unknown
    const unknownSymbols = [...new Set(
      txns
        .map(t => t.assetSymbol)
        .filter(s => s && (looksLikeContractAddress(s) || !TOKEN_DISPLAY_NAMES[s.toUpperCase()]))
    )];

    if (!unknownSymbols.length) return txns;
    if (onProgress) onProgress({ step: 'tokens', msg: `Resolving ${unknownSymbols.length} unknown token symbols…` });

    const resolvedCache = await resolveUnknownTokenNames(unknownSymbols);

    // Also resolve inAsset symbols for trades
    const inAssetSymbols = [...new Set(
      txns.map(t => t.inAsset).filter(s => s && looksLikeContractAddress(s))
    )];
    if (inAssetSymbols.length) await resolveUnknownTokenNames(inAssetSymbols);

    // Reload cache after DexScreener fills it
    let nameCache = {};
    try { nameCache = JSON.parse(localStorage.getItem('tcmd_token_names') || '{}'); } catch {}

    return txns.map(t => {
      let sym = t.assetSymbol || '';
      let name = t.assetName || '';
      let coinGeckoId = t.coinGeckoId;

      // 1. Known mint → resolve to symbol
      if (KNOWN_MINTS[sym]) { sym = KNOWN_MINTS[sym]; }
      // 2. 8-char prefix lookup
      const prefixResolved = MINT_PREFIX_TO_SYM[sym.toUpperCase()];
      if (prefixResolved) { sym = prefixResolved; }
      // 3. DexScreener cache
      const cached = nameCache[sym.toUpperCase()];
      if (cached) { sym = cached.symbol || sym; name = cached.name || name; }
      // 4. Static display names
      const staticName = TOKEN_DISPLAY_NAMES[sym.toUpperCase()];
      if (staticName && !name) name = staticName;
      // 5. CoinGecko ID assignment
      if (!coinGeckoId) coinGeckoId = CC_IDS[sym.toUpperCase()] || null;

      // Resolve inAsset (trade "received" side) the same way
      let inAsset = t.inAsset || '';
      if (inAsset) {
        if (KNOWN_MINTS[inAsset]) inAsset = KNOWN_MINTS[inAsset];
        const inPrefix = MINT_PREFIX_TO_SYM[inAsset.toUpperCase()];
        if (inPrefix) inAsset = inPrefix;
        const inCached = nameCache[inAsset.toUpperCase()];
        if (inCached) inAsset = inCached.symbol || inAsset;
      }

      // Preserve the original contractAddress even after symbol resolution
      // so GeckoTerminal can look up the token's historical OHLCV by address.
      const contractAddress = t.contractAddress
        || (looksLikeContractAddress(t.assetSymbol) ? t.assetSymbol : null);

      return {
        ...t,
        assetSymbol: sym,
        assetName: name,
        coinGeckoId,
        inAsset: inAsset || t.inAsset,
        contractAddress,
      };
    });
  }

  // ════════════════════════════════════════════════════════════
  // STEP 3 — DETECT SPAM TOKENS
  // Mark spam BEFORE classification to avoid polluting K4.
  // ════════════════════════════════════════════════════════════
  function detectSpamTokens(txns) {
    return txns.map(t => {
      if (t.manualCategory || t.userReviewed) return t;
      const sym = (t.assetSymbol || '').toUpperCase();
      const notes = (t.notes || t.assetName || '').toLowerCase();
      const amount = t.amount || 0;

      let isSpam = false;

      // 1. Explicit spam patterns in name/notes
      if (SPAM_PATTERNS.some(p => p.test(notes))) isSpam = true;
      // 2. Unresolved contract address as symbol
      if (!isSpam && looksLikeContractAddress(sym)) isSpam = true;
      // 3. Dust amounts with no known price and not a major asset
      const isMajor = ['BTC','ETH','SOL','BNB','USDC','USDT','MATIC','AVAX','ARB','OP'].includes(sym);
      if (!isSpam && !isMajor && amount > 0 && amount < 0.000001) isSpam = true;
      // 4. Zero cost + zero price + not staking/income type
      if (!isSpam && !t.priceSEKPerUnit && !t.costBasisSEK && !t.coinGeckoId && !STABLES.has(sym)) {
        // Only flag receive/transfer_in as potential spam if amount is oddly round or tiny
        if (t.rawType === 'receive' || t.rawType === 'transfer_in') {
          const isOddlyRound = Number.isInteger(amount) && amount >= 1000000;
          if (isOddlyRound) isSpam = true;
        }
      }

      if (isSpam && t.category !== CAT.SPAM) {
        return { ...t, category: CAT.SPAM, autoClassified: true, needsReview: false };
      }
      return t;
    });
  }

  function autoClassifyAll(txns) {
    return txns.map(t => {
      if (t.manualCategory) return t; // Never override user edits
      const cat = detectCategory(t);
      const needsReview = shouldReview(t, cat);
      return {
        ...t,
        category: cat,
        autoClassified: true,
        needsReview,
        reviewReason: needsReview ? getReviewReason(t, cat) : null,
      };
    });
  }

  function detectCategory(t) {
    const rawType = (t.rawType || '').toLowerCase();
    const sym = (t.assetSymbol || '').toUpperCase();
    const notes = (t.notes || '').toLowerCase();
    const source = (t.source || '').toLowerCase();
    const amount = t.amount || 0;

    // ── Exchange-reported types (most reliable) ────────────
    if (rawType.match(/^buy$/))  return CAT.BUY;
    if (rawType.match(/^sell$/)) return CAT.SELL;
    if (rawType.match(/swap|convert|exchange/)) return CAT.TRADE;

    // Income: staking, earn, rewards, interest
    if (rawType.match(/staking|earn|reward|interest|cashback|referral|mining/)) return CAT.INCOME;
    // Airdrop: separate from generic receive — income at FMV
    if (rawType.match(/airdrop/)) return CAT.AIRDROP;

    // Exchange crypto deposits are incoming transfers (not a buy of new assets)
    if (rawType.match(/^deposit$/)) return CAT.TRANSFER_IN;
    // Exchange crypto withdrawals are outgoing transfers
    if (rawType.match(/^withdrawal?$/)) return CAT.TRANSFER_OUT;

    if (rawType.match(/fee/))      return CAT.FEE;
    if (rawType.match(/approval/)) return CAT.APPROVAL;

    // ── DeFi / Staking / NFT ──────────────────────────────
    if (rawType.match(/stake|unstake|claim/)) return CAT.STAKING;
    if (rawType.match(/nft.*sale|nft.*sell/)) return CAT.NFT_SALE;
    if (rawType.match(/add.*liquidity|remove.*liquidity|\blp\b/)) return CAT.TRADE;
    if (rawType.match(/lend|borrow|repay|supply|withdraw.*vault/)) return CAT.DEFI_UNKNOWN;
    if (rawType.match(/contract.*interaction|unknown.*program/))   return CAT.DEFI_UNKNOWN;

    // ── Bridge / Wrap — granular categories ───────────────
    // Wrap/unwrap: detect from rawType or notes (ETH→WETH, WETH→ETH, etc.)
    if (rawType === 'wrap'   || notes.match(/\bwrap\b/)  ) return CAT.WRAP;
    if (rawType === 'unwrap' || notes.match(/\bunwrap\b/)) return CAT.UNWRAP;
    // Bridge direction from rawType
    if (rawType.match(/bridge.*in|bridge.*receive|bridge.*deposit|cross.?chain.*receiv/)) return CAT.BRIDGE_IN;
    if (rawType.match(/bridge.*out|bridge.*send|bridge.*withdraw|cross.?chain.*send/))   return CAT.BRIDGE_OUT;
    // Generic bridge (direction unknown — will be resolved by transfer matcher)
    if (rawType.match(/bridge/)) return CAT.BRIDGE;

    // ── Blockchain heuristics ─────────────────────────────
    // Has both sides of swap → TRADE
    if (t.inAsset && t.inAmount > 0) return CAT.TRADE;

    // Canonical wrapped asset arriving → likely an unwrap (non-taxable)
    const original = ASSET_CANONICAL[sym];
    if (original && (rawType === 'receive' || !rawType)) {
      if (notes.match(/unwrap|withdraw.*wrap|redeem/)) return CAT.UNWRAP;
    }
    // Canonical wrapped asset leaving → likely a wrap (non-taxable)
    if (original && (rawType === 'send' || !rawType)) {
      if (notes.match(/\bwrap\b|deposit.*wrap/)) return CAT.WRAP;
    }

    // Spam detection
    if (SPAM_PATTERNS.some(p => p.test(notes))) return CAT.SPAM;
    if (amount > 0 && amount < 0.000001 && !['BTC', 'ETH', 'SOL'].includes(sym)) return CAT.SPAM;

    // Tiny amounts = likely fees
    if (amount < 0.0001 && ['ETH', 'SOL', 'BNB'].includes(sym)) return CAT.FEE;

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
    return [
      CAT.SELL, CAT.TRADE, CAT.RECEIVE, CAT.INCOME, CAT.BUY,
      CAT.STAKING, CAT.NFT_SALE, CAT.AIRDROP, CAT.UNKNOWN_ACQUISITION,
    ].includes(cat);
  }

  // Non-taxable economic categories (internal moves, no gain/loss)
  function isNonTaxableTransfer(cat) {
    return [
      CAT.TRANSFER_IN, CAT.TRANSFER_OUT, CAT.BRIDGE_IN, CAT.BRIDGE_OUT,
      CAT.WRAP, CAT.UNWRAP,
    ].includes(cat);
  }

  function getReviewReason(t, cat) {
    if (!t.priceSEKPerUnit && !t.costBasisSEK) return 'missing_sek_price';
    if (!t.coinGeckoId && !STABLES.has(t.assetSymbol)) return 'unknown_asset';
    if (cat === CAT.DEFI_UNKNOWN)   return 'unsupported_defi';
    if (cat === CAT.BRIDGE)         return 'bridge_review';
    if (cat === CAT.BRIDGE_IN || cat === CAT.BRIDGE_OUT) return 'bridge_review';
    if (cat === CAT.UNKNOWN_ACQUISITION) return 'unknown_acquisition';
    return 'unclassified';
  }

  // ════════════════════════════════════════════════════════════
  // TRANSFER MATCHING  (cross-chain / multi-source / bridge)
  // ════════════════════════════════════════════════════════════
  //
  // Three matching passes, each with different time + fee tolerances:
  //   Pass 1 — Same-chain, wallet-to-wallet (24 h, 2%)
  //   Pass 2 — Cross-chain bridge            (72 h, 5%)
  //   Pass 3 — CEX withdrawal ↔ on-chain     (48 h, 2%)
  //
  // Assets are compared using their CANONICAL symbol (WETH = ETH, etc.)
  // so wraps/unwraps across chains are matched as internal transfers.
  // ════════════════════════════════════════════════════════════

  const MATCH_WINDOW_MS  = 24 * 60 * 60 * 1000; // 24 h (same-chain)
  const AMOUNT_TOLERANCE = 0.02;                  // 2%

  function matchTransfers(txns) {
    const matched = new Set();

    // Canonical symbol: normalise wraps so WETH and ETH match
    const symOf = t => normalizeAssetSymbol(t.assetSymbol || '');

    // In-place mark helper
    function pair(out, inc, transferType) {
      out.isInternalTransfer = true;
      out.matchedTxId  = inc.id;
      out.matchedType  = transferType;
      out.needsReview  = false;
      out.reviewReason = null;
      inc.isInternalTransfer = true;
      inc.matchedTxId  = out.id;
      inc.matchedType  = transferType;
      inc.needsReview  = false;
      inc.reviewReason = null;
      matched.add(out.id);
      matched.add(inc.id);
    }

    // Generic match pass: finds best matching incoming for each outgoing
    function runPass(outCats, inCats, windowMs, amtTol, allowSameAccount) {
      const outgoing = txns.filter(t => !matched.has(t.id) && outCats.includes(t.category));
      const incoming = txns.filter(t => !matched.has(t.id) && inCats.includes(t.category));

      for (const out of outgoing) {
        if (matched.has(out.id)) continue;
        const outMs  = new Date(out.date).getTime();
        const outSym = symOf(out);

        const candidates = incoming
          .filter(inc => {
            if (matched.has(inc.id)) return false;
            if (!allowSameAccount && inc.accountId === out.accountId) return false;
            if (symOf(inc) !== outSym) return false;
            const timeDiff = Math.abs(new Date(inc.date).getTime() - outMs);
            if (timeDiff > windowMs) return false;
            const amtDiff = Math.abs(inc.amount - out.amount) / (out.amount || 1);
            if (amtDiff > amtTol) return false;
            return true;
          })
          .sort((a, b) => {
            const ta = Math.abs(new Date(a.date).getTime() - outMs);
            const tb = Math.abs(new Date(b.date).getTime() - outMs);
            return ta - tb;
          });

        if (candidates.length > 0) {
          pair(out, candidates[0], 'transfer');
        }
      }
    }

    // ── Pass 1: Same-chain wallet→wallet (24 h, 2% fee tolerance) ──
    runPass(
      [CAT.TRANSFER_OUT, CAT.SEND],
      [CAT.TRANSFER_IN,  CAT.RECEIVE],
      24 * 3600_000, 0.02, false,
    );

    // ── Pass 2: Cross-chain bridge (72 h, 5% bridge fee tolerance) ──
    // Bridge pairs: BRIDGE_OUT ↔ BRIDGE_IN / RECEIVE / TRANSFER_IN
    // Also catches unclassified sends that turn out to be bridges
    runPass(
      [CAT.BRIDGE_OUT, CAT.BRIDGE, CAT.SEND, CAT.TRANSFER_OUT],
      [CAT.BRIDGE_IN,  CAT.BRIDGE, CAT.RECEIVE, CAT.TRANSFER_IN],
      72 * 3600_000, 0.05, false,
    );

    // ── Pass 3: CEX withdrawal → on-chain deposit (48 h, 2%) ──
    // Exchange sources paired with blockchain sources
    runPass(
      [CAT.TRANSFER_OUT, CAT.SEND],
      [CAT.TRANSFER_IN,  CAT.RECEIVE],
      48 * 3600_000, 0.02, false,
    );

    // ── Pass 4: Wrap/unwrap within same account (same asset canonical) ──
    // e.g. WRAP (ETH→WETH) on same wallet: mark as internal, non-taxable
    const wrapOuts = txns.filter(t =>
      !matched.has(t.id) && (t.category === CAT.WRAP || t.category === CAT.UNWRAP),
    );
    for (const out of wrapOuts) {
      if (matched.has(out.id)) continue;
      const outMs  = new Date(out.date).getTime();
      const outSym = symOf(out);
      // Find the counterpart: same account, same canonical asset, within 10 min
      const counterpart = txns.find(t =>
        !matched.has(t.id) && t.id !== out.id &&
        t.accountId === out.accountId &&
        symOf(t) === outSym &&
        Math.abs(new Date(t.date).getTime() - outMs) < 10 * 60_000 &&
        (t.category === CAT.WRAP || t.category === CAT.UNWRAP ||
         t.category === CAT.RECEIVE || t.category === CAT.SEND),
      );
      if (counterpart) pair(out, counterpart, 'wrap');
    }

    return txns;
  }

  // ════════════════════════════════════════════════════════════
  // CROSS-SOURCE DEDUPLICATION
  // Detects same real-world transaction imported from multiple
  // sources (e.g., API + CSV, exchange + wallet, multiple syncs)
  // ════════════════════════════════════════════════════════════
  const DEDUP_TIME_MS = 5 * 60 * 1000; // 5 minutes
  const DEDUP_AMT_TOL = 0.01;          // 1%

  function deduplicateTransactions(txns) {
    // Group by asset symbol for efficient comparison
    const byAsset = {};
    for (const t of txns) {
      const sym = t.assetSymbol || 'UNKNOWN';
      (byAsset[sym] = byAsset[sym] || []).push(t);
    }

    const dupIds = new Set();
    const dupGroups = []; // for review

    for (const [sym, group] of Object.entries(byAsset)) {
      if (group.length < 2) continue;

      // Sort by date for efficient scanning
      group.sort((a, b) => new Date(a.date) - new Date(b.date));

      for (let i = 0; i < group.length; i++) {
        const a = group[i];
        if (a.isDuplicate || a.manualCategory) continue;

        for (let j = i + 1; j < group.length; j++) {
          const b = group[j];
          if (b.isDuplicate || b.manualCategory) continue;

          // Must be from different accounts (same account dedup handled at import)
          if (a.accountId === b.accountId) continue;

          const timeDiff = Math.abs(new Date(b.date) - new Date(a.date));
          if (timeDiff > DEDUP_TIME_MS) break; // sorted by date, no more matches possible

          const amtDiff = a.amount > 0
            ? Math.abs(a.amount - b.amount) / a.amount
            : 0;

          if (amtDiff <= DEDUP_AMT_TOL) {
            // Same asset, similar amount, close time, different sources → likely duplicate
            b.isDuplicate = true;
            b.duplicateOfId = a.id;
            b.needsReview = true;
            b.reviewReason = 'duplicate';
            dupIds.add(b.id);
            dupGroups.push({ original: a.id, duplicate: b.id, sym, timeDiff, amtDiff });
          }
        }
      }
    }

    return txns;
  }

  // ════════════════════════════════════════════════════════════
  // RE-SYNC — clear account data and re-import
  // ════════════════════════════════════════════════════════════
  function resyncAccount(accountId) {
    // Remove all transactions for this account
    const txns = getTransactions().filter(t => t.accountId !== accountId);
    saveTransactions(txns);
    // Reset import status
    setImportStatus(accountId, { status: 'never_synced' });
    return txns.length;
  }

  // ── Purge phantom Solana transactions ────────────────────
  // Removes transactions that were imported before the failed-tx
  // filter was added (commit 7c558f6). Detects phantom entries by:
  //  1. Implausibly large SOL amounts (> 10,000 SOL in a single tx)
  //  2. Implausibly large SEK cost basis for a Solana source tx
  //     (> 50M SEK = ~$5M at 10 SEK/USD — unrealistic for retail)
  //  3. Transactions whose notes contain "DEX buy/sell" with
  //     a costBasisSEK that is orders of magnitude beyond the fee
  //
  // Returns { removed, kept } counts.
  function purgeSolanaPhantoms(accountId) {
    const MAX_SOL_SINGLE_TX = 10_000;     // SOL
    const MAX_SEK_SINGLE_TX = 50_000_000; // 50M SEK
    const all = getTransactions();

    const isPhantom = t => {
      if (t.source !== 'solana_wallet') return false;
      if (accountId && t.accountId !== accountId) return false;
      // Implausibly large token amount for a single Solana tx
      if (t.assetSymbol === 'SOL' && (t.amount || 0) > MAX_SOL_SINGLE_TX) return true;
      if ((t.inAsset === 'SOL') && (t.inAmount || 0) > MAX_SOL_SINGLE_TX) return true;
      // Implausibly large SEK cost for any single tx from a retail wallet
      if ((t.costBasisSEK || 0) > MAX_SEK_SINGLE_TX) return true;
      return false;
    };

    const phantoms = all.filter(isPhantom);
    if (!phantoms.length) return { removed: 0, kept: all.length };

    const kept = all.filter(t => !isPhantom(t));
    saveTransactions(kept);
    console.log(`[TaxEngine] purgeSolanaPhantoms: removed ${phantoms.length} phantom txns`);
    return { removed: phantoms.length, kept: kept.length };
  }

  // ════════════════════════════════════════════════════════════
  // SEK PRICE PIPELINE  (CoinCap + Frankfurter — CORS-friendly)
  // CoinGecko:   api.coingecko.com — daily USD prices, free tier no auth
  // Frankfurter: api.frankfurter.app — ECB FX rates USD→SEK, batch by year
  // No API key required. ~5–10 total requests regardless of tx count.
  // ════════════════════════════════════════════════════════════

  function getPriceCache() { try { return JSON.parse(localStorage.getItem(LS.PRICES) || '{}'); } catch { return {}; } }
  function savePriceCache(c) { try { localStorage.setItem(LS.PRICES, JSON.stringify(c)); } catch { } }

  function cacheKey(coinId, isoDate) {
    return `${coinId}_${isoDate.slice(0, 10)}`;
  }

  function stableSEKPrice(sym) {
    const EUR = ['EUROC', 'EURC', 'EURT', 'EURS'];
    if (EUR.includes(sym)) return STABLE_SEK.EUR;
    return STABLE_SEK.USD;
  }

  // Fetch with a hard timeout — avoids hanging the tab if API is slow/rate-limiting
  async function fetchWithTimeout(url, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(tid);
      return r;
    } catch (e) {
      clearTimeout(tid);
      return null; // timeout or network error → treat as missing price
    }
  }

  // ── GeckoTerminal — DEX OHLCV for on-chain tokens not in CoinGecko ──
  // GeckoTerminal's direct API blocks browser requests from github.io with CORS.
  // We route it through corsproxy.io (open, privacy-preserving proxy — only the
  // token mint address is sent, no user data).  Falls back to null on any failure.
  const GT_NETWORK_MAP = {
    solana: 'solana', eth: 'eth', base: 'base',
    arbitrum: 'arbitrum', optimism: 'optimism',
    polygon_pos: 'polygon_pos', avax: 'avax', bsc: 'bsc',
  };

  // CORS proxy prefix — routes GeckoTerminal requests through a free proxy that
  // adds the missing Access-Control-Allow-Origin header.
  const GT_CORS_PROXY = 'https://corsproxy.io/?url=';

  // Fetch OHLCV for a token by contract/mint address for a given year.
  // Returns Map<YYYY-MM-DD, usdPrice> or null on failure.
  async function fetchGeckoTerminalYear(address, network, year) {
    const gtNetwork = GT_NETWORK_MAP[network];
    if (!gtNetwork || !address) return null;
    try {
      const beforeTs = Math.floor(Date.UTC(year, 11, 31, 23, 59, 59) / 1000);
      const directUrl = `https://api.geckoterminal.com/api/v2/networks/${gtNetwork}/tokens/${address}/ohlcv/day?limit=365&before_timestamp=${beforeTs}`;
      // Try direct first (works in dev / if GT re-enables CORS), then proxy
      let r = await fetchWithTimeout(directUrl, 8000);
      if (!r || !r.ok) {
        r = await fetchWithTimeout(GT_CORS_PROXY + encodeURIComponent(directUrl), 12000);
      }
      if (!r || !r.ok) return null;
      const json = await r.json();
      const ohlcv = json?.data?.attributes?.ohlcv_list;
      if (!Array.isArray(ohlcv) || !ohlcv.length) return null;
      const map = new Map();
      for (const [ts, , , , close] of ohlcv) {
        const d = new Date(ts * 1000).toISOString().slice(0, 10);
        if (typeof close === 'number' && close > 0) map.set(d, close);
      }
      return map.size > 0 ? map : null;
    } catch { return null; }
  }

  // ── Cache key for GeckoTerminal data (separate namespace) ────
  function gtCacheKey(address, dateStr) { return `gt:${address}:${dateStr}`; }

  // ── CoinCap v2 — free, no API key, CORS-friendly ─────────────
  // Replaces CoinGecko which now requires a paid API key for all requests.
  // CoinCap uses the same asset slug format for most major coins.
  // IDs that differ from CoinGecko are translated in COINCAP_ID_MAP below.
  const COINCAP_ID_MAP = {
    'binancecoin':     'binance-coin',
    'avalanche-2':     'avalanche',
    'matic-network':   'polygon',
    'injective-protocol': 'injective',
    'pyth-network':    'pyth-network',  // same
    'dogwifhat':       'dogwifhat',     // same (may not be in CoinCap)
    'the-open-network': 'toncoin',
  };

  // Fetch one year of daily USD prices from CoinCap v2 history endpoint.
  // Returns Map<YYYY-MM-DD, usdPrice> or null on failure.
  async function fetchCoinCapYear(cgId, year) {
    const capId = COINCAP_ID_MAP[cgId] || cgId;
    const start = Date.UTC(year, 0, 1);          // ms
    const end   = Date.UTC(year, 11, 31, 23, 59, 59);
    try {
      const url = `https://api.coincap.io/v2/assets/${capId}/history?interval=d1&start=${start}&end=${end}`;
      const r = await fetchWithTimeout(url, 12000);
      if (!r || !r.ok) return null;
      const data = await r.json();
      const map = new Map();
      // data.data = [{ priceUsd: "50000.0", time: 1635724800000, date: "..." }]
      for (const point of (data.data || [])) {
        const d = new Date(point.time).toISOString().slice(0, 10);
        const p = parseFloat(point.priceUsd);
        if (p > 0) map.set(d, p);
      }
      return map.size > 0 ? map : null;
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
      const k = d.toISOString().slice(0, 10);
      if (map.has(k)) return map.get(k);
    }
    return null;
  }

  // ════════════════════════════════════════════════════════════
  // SEK PRICING SERVICE — 6-level fallback chain
  //
  // Level 1  trade_exact            Exchange-reported execution price
  // Level 2  swap_implied           Derive from the other leg of a swap (inAsset/inAmount)
  // Level 3  market_api_coingecko   Historical CoinGecko daily USD × FX (known tokens)
  //          market_api_dex         GeckoTerminal on-chain DEX OHLCV (contract address)
  // Level 4  pair_derived           Infer from priced counterpart in same txHash group
  // Level 5  stable_historical_fx   Stablecoin × historical USD/SEK FX rate
  // Level 6  stable_approx          Stablecoin × hardcoded fallback rate
  //          missing                All passes failed → manual review
  //
  // Every transaction gets: priceSEKPerUnit, costBasisSEK,
  //   priceSource, priceConfidence, priceDerivedFromOtherLeg
  // Transactions reach manual review ONLY when ALL fallbacks fail.
  // ════════════════════════════════════════════════════════════

  const PS = {
    TRADE_EXACT:     'trade_exact',        // Exchange execution price (most reliable)
    SWAP_IMPLIED:    'swap_implied',        // Derived from the other swap leg
    MARKET_API:      'market_api_coingecko',// CoinGecko historical daily price
    DEX_MARKET:      'market_api_dex',     // GeckoTerminal on-chain DEX OHLCV
    PAIR_DERIVED:    'pair_derived',        // Inferred from priced counterpart in same tx
    STABLE_HIST_FX:  'stable_historical_fx',// Stablecoin × historical USD/SEK FX rate
    STABLE_APPROX:   'stable_approx',      // Stablecoin × hardcoded fallback rate
    MANUAL:          'manual',             // User-entered price
    BACK_DERIVED:    'back_derived',       // Inferred from a later disposal of the same asset
    MISSING:         'missing',            // All passes failed — manual review required
  };

  // Price Confidence tiers — drive smart triage in getReviewIssues.
  // Replaces the old binary priced/missing with five distinct tiers:
  //   SPAM_ZERO       → auto-detected spam; zero value; not shown in K4 review
  //   RECEIVED_UNSOLD → received and never disposed; informational only, not K4-blocking
  //   UNKNOWN_MANUAL  → disposal or acquired asset with no price; K4 blocker; manual entry required
  //   INFERRED_*      → priced via derivation or market API (already resolved, not shown in review)
  //   EXACT           → exchange execution price (already resolved)
  const PC = {
    EXACT:           'exact',           // Level 1 — trade execution price
    INFERRED_HIGH:   'inferred_high',   // Swap leg with stablecoin counterpart
    INFERRED_MED:    'inferred_med',    // Swap leg with non-stable / pair-derived
    INFERRED_LOW:    'inferred_low',    // Market API with far-date interpolation
    SPAM_ZERO:       'spam_zero',       // Auto-detected spam → zero value, non-blocking
    RECEIVED_UNSOLD: 'received_unsold', // Received but never disposed → informational
    UNKNOWN_MANUAL:  'unknown_manual',  // True unknown → K4 blocker, manual entry required
  };

  // Look up a SEK price from the daily-price cache for a symbol + date.
  // Checks CoinGecko cache (by ccId) first, then GeckoTerminal cache (by contractAddress).
  // Tries exact date then walks ±7 days (handles weekends / API gaps).
  function lookupCachedSEK(sym, dateStr, cache, contractAddress) {
    if (!dateStr) return null;

    // 1. CoinGecko cache (by ccId)
    const ccId = CC_IDS[sym?.toUpperCase()];
    if (ccId) {
      const exact = cache[cacheKey(ccId, dateStr)];
      if (exact) return exact;
      const base = new Date(dateStr);
      for (let delta = 1; delta <= 7; delta++) {
        for (const sign of [1, -1]) {
          const d = new Date(base);
          d.setUTCDate(d.getUTCDate() + sign * delta);
          const v = cache[cacheKey(ccId, d.toISOString().slice(0, 10))];
          if (v) return v;
        }
      }
    }

    // 2. Symbol as cache key (used when GeckoTerminal prices are stored under sym key)
    const symDirect = cache[cacheKey(sym?.toUpperCase(), dateStr)];
    if (symDirect) return symDirect;

    // 3. GeckoTerminal cache (by contract address)
    if (contractAddress) {
      const gtExact = cache[gtCacheKey(contractAddress, dateStr)];
      if (gtExact) return gtExact;
      const base = new Date(dateStr);
      for (let delta = 1; delta <= 7; delta++) {
        for (const sign of [1, -1]) {
          const d = new Date(base);
          d.setUTCDate(d.getUTCDate() + sign * delta);
          const v = cache[gtCacheKey(contractAddress, d.toISOString().slice(0, 10))];
          if (v) return v;
        }
      }
    }

    return null;
  }

  // Historical SEK/USD rate for a date (falls back ±7 days for bank holidays)
  function historicalFX(dateStr, fxByYear) {
    if (!dateStr || !fxByYear) return null;
    const year = parseInt(dateStr.slice(0, 4));
    const fxMap = fxByYear.get(year);
    return fxMap ? nearestMapValue(fxMap, dateStr, 7) : null;
  }

  // Price one transaction through the full fallback chain.
  // Returns an updated transaction object with price metadata set.
  // Helper: get SEK value for a symbol+amount using any available source
  // Used inline within the derivation passes
  function getSEKValue(sym, amt, date, cache, fxByYear) {
    if (!sym || !amt) return null;
    sym = sym.toUpperCase();
    if (STABLES.has(sym)) {
      const EUR_STABLES = new Set(['EUROC', 'EURC', 'EURT', 'EURS']);
      const rate = historicalFX(date, fxByYear) || STABLE_SEK.USD;
      return EUR_STABLES.has(sym) ? rate * (STABLE_SEK.EUR / STABLE_SEK.USD) * amt : rate * amt;
    }
    const cached = lookupCachedSEK(sym, date, cache, null);
    return cached ? cached * amt : null;
  }

  function priceOneTxn(t, cache, fxByYear) {
    // Never overwrite manual prices
    if (t.priceSource === PS.MANUAL || t.manualCategory) return t;
    // Internal transfers are non-taxable — zero value
    if (t.isInternalTransfer) {
      return { ...t, priceSEKPerUnit: 0, costBasisSEK: 0,
               priceSource: PS.TRADE_EXACT, priceConfidence: 'high' };
    }
    // Non-taxable / spam: skip
    if (!isTaxableCategory(t.category) && t.category !== CAT.FEE) return t;

    const sym  = (t.assetSymbol || '').toUpperCase();
    const date = (t.date || '').slice(0, 10);
    const amt  = t.amount || 0;

    // ── Already priced ─────────────────────────────────────
    if (t.priceSEKPerUnit > 0 && t.priceSource !== PS.MISSING) {
      return {
        ...t,
        costBasisSEK: t.costBasisSEK || t.priceSEKPerUnit * amt,
        priceSource:     t.priceSource     || PS.TRADE_EXACT,
        priceConfidence: t.priceConfidence || 'high',
        needsReview: false, reviewReason: null,
      };
    }

    // ── Level 1: Direct exchange execution price ──────────
    // Exchange CSV parsers store rawTradePrice (in USD/EUR/quote currency)
    if (t.rawTradePrice && t.rawTradeCurrency) {
      const raw = parseFloat(t.rawTradePrice) || 0;
      if (raw > 0) {
        const fx   = historicalFX(date, fxByYear) || STABLE_SEK.USD;
        const price = t.rawTradeCurrency === 'SEK' ? raw : raw * fx;
        if (price > 0) return {
          ...t,
          priceSEKPerUnit: price, costBasisSEK: price * amt,
          priceSource: PS.TRADE_EXACT, priceConfidence: 'high',
          needsReview: false, reviewReason: null,
        };
      }
    }

    // ── Level 2: Inline swap leg derivation ───────────────
    // If this transaction has BOTH outgoing + incoming asset (TRADE / BUY / SELL
    // with inAsset+inAmount set), derive value from the known side immediately.
    // This handles: Binance BUY/SELL CSV rows, on-chain swaps, exchange pairs.
    const inSym = (t.inAsset || '').toUpperCase();
    const inAmt = t.inAmount || 0;
    if (inSym && inAmt > 0) {
      // 2a. In-side is stablecoin → its SEK value is the proceeds/cost
      const inSEK = getSEKValue(inSym, inAmt, date, cache, fxByYear);
      if (inSEK && inSEK > 0 && amt > 0) {
        return {
          ...t,
          priceSEKPerUnit: inSEK / amt, costBasisSEK: inSEK,
          priceSource: PS.SWAP_IMPLIED, priceConfidence: STABLES.has(inSym) ? 'high' : 'medium',
          priceDerivedFromOtherLeg: true,
          needsReview: false, reviewReason: null,
        };
      }
    }
    // For SELL/BUY: the "out" side might be priced and "in" side is the unknown
    // i.e. selling unknown → receiving stablecoin. Treat them the same way.
    if (t.category === CAT.SELL && inSym && inAmt > 0) {
      const receivedSEK = getSEKValue(inSym, inAmt, date, cache, fxByYear);
      if (receivedSEK && receivedSEK > 0 && amt > 0) {
        return {
          ...t,
          priceSEKPerUnit: receivedSEK / amt, costBasisSEK: receivedSEK,
          priceSource: PS.SWAP_IMPLIED, priceConfidence: 'high',
          priceDerivedFromOtherLeg: true,
          needsReview: false, reviewReason: null,
        };
      }
    }

    // ── Level 3: Historical market API (CoinGecko + GeckoTerminal cache) ──
    if (!STABLES.has(sym)) {
      const cached = lookupCachedSEK(sym, date, cache, t.contractAddress);
      if (cached) {
        return {
          ...t,
          priceSEKPerUnit: cached, costBasisSEK: cached * amt,
          priceSource: PS.MARKET_API, priceConfidence: 'high',
          needsReview: false, reviewReason: null,
        };
      }
    }

    // ── Level 5: Stablecoin × historical USD/SEK FX ───────
    if (STABLES.has(sym)) {
      const EUR_STABLES = new Set(['EUROC', 'EURC', 'EURT', 'EURS']);
      const isEUR = EUR_STABLES.has(sym);
      const usdSEK = historicalFX(date, fxByYear);
      if (usdSEK) {
        const price = isEUR ? usdSEK * (STABLE_SEK.EUR / STABLE_SEK.USD) : usdSEK;
        return {
          ...t,
          priceSEKPerUnit: price, costBasisSEK: price * amt,
          priceSource: PS.STABLE_HIST_FX, priceConfidence: 'high',
          needsReview: false, reviewReason: null,
        };
      }
      // Level 6 fallback: hardcoded rate
      const approx = stableSEKPrice(sym);
      return {
        ...t,
        priceSEKPerUnit: approx, costBasisSEK: approx * amt,
        priceSource: PS.STABLE_APPROX, priceConfidence: 'medium',
        needsReview: false, reviewReason: null,
      };
    }

    // Mark for cross-transaction derivation passes
    return { ...t, priceSource: PS.MISSING, priceConfidence: null };
  }

  // Pass 2: Cross-transaction derivation
  // For still-unpriced transactions, try to derive from:
  // (a) same txHash group — RECEIVE paired with SEND in same on-chain tx
  // (b) priced sibling transaction with same asset (nearby date)
  // Runs MULTIPLE rounds until no more prices can be resolved (chain-derive).
  function deriveFromContext(txns, cache, fxByYear) {
    // Group by txHash for same-event derivation
    const byHash = {};
    for (const t of txns) {
      if (t.txHash && !t.txHash.startsWith('manual_')) {
        (byHash[t.txHash] = byHash[t.txHash] || []).push(t);
      }
    }

    // Build symbol → best price map (most recent price wins for each symbol)
    // Used to derive RECEIVE prices from symbol's known price on same/nearby date
    const symPriceCache = new Map(); // "SYM|YYYY-MM-DD" → SEK unit price

    function buildSymPriceCache(txns) {
      symPriceCache.clear();
      for (const t of txns) {
        if (!t.priceSEKPerUnit || t.priceSource === PS.MISSING) continue;
        const key = `${t.assetSymbol?.toUpperCase()}|${(t.date || '').slice(0, 10)}`;
        if (!symPriceCache.has(key)) symPriceCache.set(key, t.priceSEKPerUnit);
      }
    }

    function nearestSymPrice(sym, date) {
      if (!sym || !date) return null;
      sym = sym.toUpperCase();
      // Exact date
      const exact = symPriceCache.get(`${sym}|${date}`);
      if (exact) return exact;
      // Walk ±7 days in sorted keys
      const base = new Date(date);
      for (let d = 1; d <= 7; d++) {
        for (const sign of [1, -1]) {
          const dd = new Date(base);
          dd.setUTCDate(dd.getUTCDate() + sign * d);
          const v = symPriceCache.get(`${sym}|${dd.toISOString().slice(0,10)}`);
          if (v) return v;
        }
      }
      return null;
    }

    let changed = true;
    let rounds = 0;

    while (changed && rounds < 4) {
      changed = false;
      rounds++;
      buildSymPriceCache(txns);

      txns = txns.map(t => {
        if (t.priceSource !== PS.MISSING && t.priceSEKPerUnit > 0) return t;
        if (!isTaxableCategory(t.category) && t.category !== CAT.FEE) return t;
        if (t.isInternalTransfer) return t;

        const sym  = (t.assetSymbol || '').toUpperCase();
        const inSym = (t.inAsset || '').toUpperCase();
        const date = (t.date || '').slice(0, 10);
        const amt  = t.amount || 0;
        const inAmt = t.inAmount || 0;

        // ── 2a: Same txHash group derivation ──────────────
        const hashGroup = t.txHash && !t.txHash.startsWith('manual_') ? (byHash[t.txHash] || []) : [];
        const pricedInGroup = hashGroup.filter(x => x.id !== t.id && x.priceSEKPerUnit > 0 && x.priceSource !== PS.MISSING);

        if (pricedInGroup.length > 0 && amt > 0) {
          // Pick the most trustworthy counterpart: stablecoin > major asset > any priced leg.
          // Then derive THIS asset's SEK price as (swap total SEK) / (this amount).
          // NOTE: do NOT copy the counterpart's priceSEKPerUnit directly — that is the
          // OTHER asset's per-unit price (e.g. ETH = 30 000 SEK/unit) and has nothing
          // to do with this token's per-unit price.
          const best = pricedInGroup.find(x => STABLES.has((x.assetSymbol||'').toUpperCase()))
            || pricedInGroup.find(x => MAJOR_ASSETS.has((x.assetSymbol||'').toUpperCase()))
            || pricedInGroup[0];
          if (best) {
            const swapTotalSEK = best.costBasisSEK > 0
              ? best.costBasisSEK
              : best.priceSEKPerUnit * (best.amount || 0);
            if (swapTotalSEK > 0) {
              const ctrSym = (best.assetSymbol||'').toUpperCase();
              const conf = STABLES.has(ctrSym) ? PC.INFERRED_HIGH : PC.INFERRED_MED;
              changed = true;
              return {
                ...t,
                priceSEKPerUnit: swapTotalSEK / amt,
                costBasisSEK:    swapTotalSEK,
                priceSource: PS.SWAP_IMPLIED, priceConfidence: conf,
                priceDerivedFromOtherLeg: true,
                needsReview: false, reviewReason: null,
              };
            }
          }
        }

        // ── 2b: Inline inAsset derivation (from priced inAsset) ─
        if (inSym && inAmt > 0) {
          const inPrice = nearestSymPrice(inSym, date)
            || getSEKValue(inSym, 1, date, cache, fxByYear);  // unit price via FX
          if (inPrice && inPrice > 0 && amt > 0) {
            const totalSEK = inPrice * inAmt;
            changed = true;
            return {
              ...t,
              priceSEKPerUnit: totalSEK / amt, costBasisSEK: totalSEK,
              priceSource: PS.SWAP_IMPLIED,
              priceConfidence: STABLES.has(inSym) ? 'high' : 'medium',
              priceDerivedFromOtherLeg: true,
              needsReview: false, reviewReason: null,
            };
          }
        }

        // ── 2c: Asset symbol lookup from priced sibling ─────
        // RECEIVE of ROOT after selling SOL → use SOL price to derive ROOT cost
        const nearPrice = nearestSymPrice(sym, date);
        if (nearPrice && nearPrice > 0 && amt > 0) {
          changed = true;
          return {
            ...t,
            priceSEKPerUnit: nearPrice, costBasisSEK: nearPrice * amt,
            priceSource: PS.MARKET_API, priceConfidence: 'medium',
            needsReview: false, reviewReason: null,
          };
        }

        return t;
      });
    }

    return txns;
  }

  // Pass 2.5: Propagate derived prices to same-symbol same-day transactions.
  // After the multi-round cross-tx loop some tokens gain swap-implied prices.
  // This pass spreads those prices to any remaining unpriced transactions for
  // the same symbol on the exact same calendar day, capturing e.g.:
  //   • multiple PEIPEI buys on the same day as the priced swap
  //   • transfer-in of a token bought elsewhere on the same day
  // Source priority: trade_exact / stable > market_api > swap_implied / back_derived
  function propagateSameDayPrices(txns) {
    const SRC_PRIORITY = {
      [PS.TRADE_EXACT]: 5, [PS.STABLE_HIST_FX]: 4, [PS.STABLE_APPROX]: 4,
      [PS.MARKET_API]: 3, [PS.DEX_MARKET]: 3,
      [PS.SWAP_IMPLIED]: 2, [PS.PAIR_DERIVED]: 2, [PS.BACK_DERIVED]: 1,
    };
    // Build best-price-per-day map
    const dayMap = new Map(); // "SYM|YYYY-MM-DD" → { price, source, priority }
    for (const t of txns) {
      if (!t.priceSEKPerUnit || t.priceSEKPerUnit <= 0) continue;
      if (t.priceSource === PS.MISSING) continue;
      const key = `${(t.assetSymbol||'').toUpperCase()}|${(t.date||'').slice(0,10)}`;
      const pri  = SRC_PRIORITY[t.priceSource] ?? 0;
      const cur  = dayMap.get(key);
      if (!cur || pri > cur.priority) dayMap.set(key, { price: t.priceSEKPerUnit, source: t.priceSource, priority: pri });
    }
    // Apply to unpriced transactions
    return txns.map(t => {
      if (t.priceSEKPerUnit > 0 || t.priceSource !== PS.MISSING) return t;
      if (t.isInternalTransfer) return t;
      if (!isTaxableCategory(t.category) && t.category !== CAT.FEE) return t;
      const key = `${(t.assetSymbol||'').toUpperCase()}|${(t.date||'').slice(0,10)}`;
      const entry = dayMap.get(key);
      if (!entry || entry.price <= 0) return t;
      const amt = t.amount || 0;
      if (!amt) return t;
      return {
        ...t,
        priceSEKPerUnit: entry.price, costBasisSEK: entry.price * amt,
        priceSource: entry.source, priceConfidence: PC.INFERRED_MED,
        pricePropagatedSameDay: true,
        needsReview: false, reviewReason: null,
      };
    });
  }

  // Pass 3: Price fee rows using the same-date price of the fee asset
  function priceFees(txns, cache, fxByYear) {
    // Build a quick symbol-price map from already-priced transactions
    const symPriceMap = new Map();
    for (const t of txns) {
      if (t.priceSEKPerUnit > 0 && t.priceSource !== PS.MISSING) {
        const key = `${t.assetSymbol?.toUpperCase()}|${(t.date || '').slice(0, 10)}`;
        if (!symPriceMap.has(key)) symPriceMap.set(key, t.priceSEKPerUnit);
      }
    }
    return txns.map(t => {
      if (t.category !== CAT.FEE) return t;
      if ((t.feeSEK > 0 || t.priceSEKPerUnit > 0) && t.priceSource !== PS.MISSING) return t;
      const sym  = (t.assetSymbol || '').toUpperCase();
      const date = (t.date || '').slice(0, 10);
      const amt  = t.amount || 0;
      const price = lookupCachedSEK(sym, date, cache, t.contractAddress)
        || symPriceMap.get(`${sym}|${date}`)
        || (STABLES.has(sym) ? (historicalFX(date, fxByYear) || stableSEKPrice(sym)) : null);
      if (!price) return t;
      return {
        ...t,
        priceSEKPerUnit: price,
        costBasisSEK: price * amt,
        feeSEK: t.feeSEK || price * amt,
        priceSource: STABLES.has(sym) ? PS.STABLE_HIST_FX : PS.MARKET_API,
        priceConfidence: 'medium',
        needsReview: false, reviewReason: null,
      };
    });
  }

  // Pass 4: Back-derive acquisition prices from later disposals of the same asset.
  // If token X was received with no price, but is later sold for a known SEK amount,
  // we infer the acquisition cost from the nearest-in-time disposal price.
  // This eliminates the majority of "missing acquisition price" K4 blockers for tokens
  // that eventually get disposed of — without any extra API calls.
  function backDeriveFromDisposals(txns) {
    // Build map: symbol → list of { date, price } from priced disposals
    const disposalPrices = new Map(); // symbol → [{date, price}]
    for (const t of txns) {
      if (![CAT.SELL, CAT.TRADE, CAT.NFT_SALE].includes(t.category)) continue;
      if (!t.priceSEKPerUnit || t.priceSEKPerUnit <= 0) continue;
      if (t.priceSource === PS.MISSING) continue;
      const sym = (t.assetSymbol || '').toUpperCase();
      if (!disposalPrices.has(sym)) disposalPrices.set(sym, []);
      disposalPrices.get(sym).push({ date: t.date || '', price: t.priceSEKPerUnit });
    }
    // Sort each list chronologically for proximity lookup
    for (const list of disposalPrices.values()) {
      list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    }

    function nearestDisposalPrice(sym, date) {
      const list = disposalPrices.get(sym);
      if (!list || !list.length) return null;
      let bestPrice = null, bestDiffMs = Infinity;
      const ts = date ? new Date(date).getTime() : 0;
      for (const { date: d, price } of list) {
        const diff = Math.abs(new Date(d).getTime() - ts);
        if (diff < bestDiffMs) { bestDiffMs = diff; bestPrice = price; }
      }
      return bestPrice;
    }

    return txns.map(t => {
      // Only fill completely unpriced acquisition transactions
      if (t.priceSEKPerUnit > 0 || t.priceSource !== PS.MISSING) return t;
      if (t.isInternalTransfer) return t;
      if (![CAT.BUY, CAT.RECEIVE, CAT.AIRDROP].includes(t.category)) return t;
      const sym = (t.assetSymbol || '').toUpperCase();
      const amt = t.amount || 0;
      if (!amt) return t;
      const price = nearestDisposalPrice(sym, t.date);
      if (!price || price <= 0) return t;
      return {
        ...t,
        priceSEKPerUnit: price,
        costBasisSEK:    price * amt,
        priceSource:     PS.BACK_DERIVED,
        priceConfidence: PC.INFERRED_MED,
        priceDerivedFromDisposal: true,
        needsReview: false, reviewReason: null,
      };
    });
  }

  // ── Smart missing-price helpers ────────────────────────────
  // Build a set of canonical asset symbols that have at least one disposal
  // (SELL, TRADE, NFT_SALE) anywhere in the transaction list.
  // Used to distinguish "received but never sold" from "sold with no price history".
  function buildDisposalSet(txns) {
    const disposed = new Set();
    for (const t of txns) {
      if ([CAT.SELL, CAT.TRADE, CAT.NFT_SALE].includes(t.category)) {
        disposed.add((t.assetSymbol || '').toUpperCase());
      }
    }
    return disposed;
  }

  // Heuristic spam detector — returns true if this transaction looks like
  // a worthless spam airdrop that should be auto-zeroed instead of reviewed.
  // Does NOT override user-set categories or prices.
  function isLikelySpamToken(t) {
    if (t.priceSource === PS.MANUAL) return false; // user already decided
    if (t.userReviewed) return false;

    const sym  = (t.assetSymbol || '').toUpperCase();
    const amt  = t.amount || 0;
    const notes = (t.notes || t.description || '').toLowerCase();

    // Already classified as spam by the classifier
    if (t.category === CAT.SPAM) return true;

    // Symbol is still a raw contract address (unresolved)
    if (looksLikeContractAddress(sym)) return true;

    // Notes contain spam patterns
    if (SPAM_PATTERNS.some(p => p.test(notes))) return true;

    // Extremely small dust amount (excludes major coins)
    if (amt > 0 && amt < 0.000001 && !['BTC','ETH','SOL','BNB','USDT','USDC'].includes(sym)) return true;

    // Typical spam airdrop: huge round number (≥1M) of an unknown token
    if (amt >= 1_000_000 && amt % 1000 === 0
        && [CAT.RECEIVE, CAT.AIRDROP].includes(t.category)
        && !CC_IDS[sym] && !STABLES.has(sym)) return true;

    return false;
  }

  // Full pricing chain application
  // Pass 1:   independent per-transaction pricing (CoinGecko + stablecoin + inline swap derivation)
  // Pass 2:   cross-transaction derivation (same txHash + sibling prices) — up to 4 rounds
  // Pass 2.5: propagate derived prices to same-symbol same-day transactions
  // Pass 3:   fee row pricing
  // Pass 4:   back-derive acquisition price from later disposal of the same asset
  // Final:    tag any remaining unpriced taxable transactions for manual review
  function applyPricingChain(txns, cache, fxByYear) {
    let result = txns.map(t => priceOneTxn(t, cache, fxByYear)); // Pass 1
    result = deriveFromContext(result, cache, fxByYear);           // Pass 2 (multi-round)
    result = propagateSameDayPrices(result);                      // Pass 2.5
    result = priceFees(result, cache, fxByYear);                  // Pass 3
    result = backDeriveFromDisposals(result);                     // Pass 4
    // Final: smart confidence triage — not all missing prices are equal
    // Build disposal set so we can detect "received but never sold" tokens
    const disposedSyms = buildDisposalSet(result);
    return result.map(t => {
      if (t.isInternalTransfer || !isTaxableCategory(t.category)) return t;
      if (!t.priceSEKPerUnit && !t.costBasisSEK) {
        const sym = (t.assetSymbol || '').toUpperCase();
        const isDisposal = [CAT.SELL, CAT.TRADE, CAT.NFT_SALE].includes(t.category);

        // Group B — Auto-detected spam: zero value, non-blocking, don't clutter review
        if (isLikelySpamToken(t)) {
          return { ...t,
            priceSEKPerUnit: 0, costBasisSEK: 0,
            priceSource: PS.MISSING, priceConfidence: PC.SPAM_ZERO,
            needsReview: false, reviewReason: 'spam_token',
          };
        }

        // Group C — Received but never disposed: informational warning, NOT a K4 blocker
        if (!isDisposal && !disposedSyms.has(sym)) {
          return { ...t,
            priceSource: PS.MISSING, priceConfidence: PC.RECEIVED_UNSOLD,
            needsReview: true, reviewReason: 'received_not_sold',
          };
        }

        // Group D — True unknown: disposal or acquired asset needed for K4 → manual review
        return { ...t,
          priceSource: PS.MISSING, priceConfidence: PC.UNKNOWN_MANUAL,
          needsReview: true, reviewReason: 'missing_sek_price',
          isK4Blocker: isDisposal,
        };
      }
      // Ensure needsReview is cleared for priced transactions
      if (t.reviewReason === 'missing_sek_price' && (t.priceSEKPerUnit > 0 || t.costBasisSEK > 0)) {
        return { ...t, needsReview: false, reviewReason: null };
      }
      return t;
    });
  }

  // Fetch all missing SEK prices — batched by (coin × year) for minimal API requests
  async function fetchAllSEKPrices(txns, onProgress) {
    const cache = getPriceCache();

    // Collect ALL years with taxable transactions
    // (FX needed for every year that has stablecoins, not just years with unknown coins)
    const allTaxableYears = new Set();
    const neededPairs     = new Map(); // "ccId|year" → { ccId, year }
    const MAX_PAIRS       = 80;

    for (const t of txns) {
      if (t.isInternalTransfer) continue;
      if (!isTaxableCategory(t.category)) continue;
      const dateStr = (t.date || '').slice(0, 10);
      if (!dateStr) continue;
      const year = parseInt(dateStr.slice(0, 4));
      if (!isNaN(year)) allTaxableYears.add(year);

      // Queue CoinGecko fetch for non-stable, unpriced, known-ID tokens
      if (t.priceSEKPerUnit > 0) continue;
      if (STABLES.has((t.assetSymbol || '').toUpperCase())) continue;
      const ccId = CC_IDS[(t.assetSymbol || '').toUpperCase()];
      if (!ccId) continue;
      if (cache[cacheKey(ccId, dateStr)] !== undefined) continue;
      const pairKey = `${ccId}|${year}`;
      if (!neededPairs.has(pairKey)) neededPairs.set(pairKey, { ccId, year });
      if (neededPairs.size >= MAX_PAIRS) break;
    }
    // Also collect years from all categories that carry economic value:
    // TRADE (swap in-asset derivation), BRIDGE_IN (carries FMV cost basis), AIRDROP
    const ECONOMIC_CATS = new Set([CAT.TRADE, CAT.BRIDGE_IN, CAT.AIRDROP, CAT.INCOME, CAT.STAKING]);
    for (const t of txns) {
      if (!ECONOMIC_CATS.has(t.category) && !isTaxableCategory(t.category)) continue;
      const year = parseInt((t.date || '').slice(0, 4));
      if (!isNaN(year)) allTaxableYears.add(year);
    }

    const totalSteps = allTaxableYears.size + neededPairs.size;

    if (totalSteps === 0) {
      if (onProgress) onProgress({ step: 'price', pct: 100, msg: 'Prices up to date' });
      return applyPricingChain(txns, cache, new Map());
    }

    let stepsDone = 0;

    // ── A: Fetch USD→SEK FX for ALL taxable years ─────────
    // This ensures stablecoins get historical rates, not a hardcoded 10.4
    const fxByYear = new Map();
    for (const year of allTaxableYears) {
      const fxMap = await fetchFXYear(year);
      if (fxMap) fxByYear.set(year, fxMap);
      stepsDone++;
      if (onProgress) onProgress({
        step: 'price',
        pct: Math.round((stepsDone / totalSteps) * 60),
        msg: `Loading FX rates (${year})…`,
      });
    }

    // ── B: Fetch CoinGecko price history per (coin × year) ─
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
        pct: 60 + Math.round((stepsDone / totalSteps) * 25),
        msg: `Fetching prices (${ccId} ${year})…`,
      });
    }

    // ── C: GeckoTerminal — on-chain DEX tokens with contract address ──
    // This is the pricing layer for tokens like ROOT, DSYNC, NEURAL, and any
    // obscure DEX token not indexed by CoinGecko. Uses the contract/mint address
    // preserved in `contractAddress` to call GeckoTerminal's OHLCV API.
    const gtNeeded = new Map(); // "address|chain|year" → { address, chain, year }
    const MAX_GT = 30; // Limit to avoid rate-limiting (GT free tier: 30 req/min)

    for (const t of txns) {
      if (t.isInternalTransfer) continue;
      if (!isTaxableCategory(t.category) && t.category !== CAT.FEE) continue;
      if (t.priceSEKPerUnit > 0 || t.coinGeckoId) continue; // already priced or has CG
      if (!t.contractAddress) continue;
      const network = GT_NETWORK_MAP[t.chain] || GT_NETWORK_MAP[chainFromSource(t.source)];
      if (!network) continue;
      const year = parseInt((t.date || '').slice(0, 4));
      if (isNaN(year)) continue;
      const gtKey = `${t.contractAddress}|${network}|${year}`;
      // Skip if already cached
      if (updatedCache[gtCacheKey(t.contractAddress, (t.date || '').slice(0, 10))]) continue;
      if (!gtNeeded.has(gtKey)) {
        gtNeeded.set(gtKey, { address: t.contractAddress, chain: network, year });
        if (gtNeeded.size >= MAX_GT) break;
      }
    }

    for (const [, { address, chain, year }] of gtNeeded) {
      const fxMap    = fxByYear.get(year);
      const priceMap = await fetchGeckoTerminalYear(address, chain, year);
      if (priceMap) {
        for (const [date, usdPrice] of priceMap) {
          if (isNaN(usdPrice) || usdPrice <= 0) continue;
          const fx = fxMap ? nearestMapValue(fxMap, date) : null;
          if (fx) {
            updatedCache[gtCacheKey(address, date)] = usdPrice * fx;
            // Also cache under the canonical symbol key if we know it
            // (set below after resolution — best effort)
          }
        }
      }
      if (onProgress) onProgress({
        step: 'price',
        pct: 85 + Math.round(gtNeeded.size > 0 ? 5 : 0),
        msg: `GeckoTerminal: pricing ${address.slice(0, 8)}… (${chain})`,
      });
    }

    savePriceCache(updatedCache);

    // ── D: Apply full pricing chain (all passes) ───────────
    if (onProgress) onProgress({ step: 'price', pct: 97, msg: 'Applying pricing chain…' });

    // For GeckoTerminal-priced tokens: inject SEK price from the gt cache
    // before applyPricingChain runs so Level 3 can find it.
    const txnsWithGTPrices = txns.map(t => {
      if (t.priceSEKPerUnit > 0 || !t.contractAddress) return t;
      const dateStr = (t.date || '').slice(0, 10);
      const gtPrice = updatedCache[gtCacheKey(t.contractAddress, dateStr)];
      if (!gtPrice) return t;
      // Store under asset symbol key too so the normal cache lookup works
      const symKey = cacheKey(t.assetSymbol, dateStr);
      if (!updatedCache[symKey]) updatedCache[symKey] = gtPrice;
      return t;
    });

    return applyPricingChain(txnsWithGTPrices, updatedCache, fxByYear);
  }

  // ════════════════════════════════════════════════════════════
  // FULL IMPORT PIPELINE — 12-Stage Architecture
  //
  // Delegates to TaxPipeline (tax-pipeline.js) which implements
  // the full 12-stage ingestion contract:
  //
  //   Stage 1  Import       — raw data stored (at import time)
  //   Stage 2  Parse        — source-specific parsers (at import time)
  //   Stage 3  Pre-filter   — remove failed/noise/non-economic events
  //   Stage 4  Resolve      — token metadata
  //   Stage 5  Spam         — dust/scam detection
  //   Stage 6  Reconstruct  — swap/trade/transfer reconstruction
  //   Stage 7  Match        — internal transfer matching
  //   Stage 8  Price        — SEK price assignment
  //   Stage 9  Inventory    — cost basis (Genomsnittsmetoden)
  //   Stage 10 Review       — exception queue
  //   Stage 11 Tax events   — disposals + income
  //   Stage 12 Report       — Swedish K4 (SKV 2104)
  //
  // Raw source data is NEVER used directly for tax calculations.
  // Only NormalizedEvents (post Stage 2) enter the pipeline.
  // ════════════════════════════════════════════════════════════
  let _pipelineRunning = false;

  async function runPipeline(opts = {}) {
    if (_pipelineRunning) return;

    // ── Delegate to TaxPipeline if available ──────────────────
    if (typeof TaxPipeline !== 'undefined') {
      _pipelineRunning = true;
      Events.emit('pipeline:start', {});
      try {
        const result = await TaxPipeline.run({
          onProgress: (p) => {
            Events.emit('pipeline:step', p);
            if (opts.onProgress) opts.onProgress(p);
          },
          taxYear: getSettings().taxYear,
        });
        if (!result) return;
        return {
          totalTxns:    result.txns.length,
          reviewIssues: result.reviewIssues.length,
          duplicates:   result.txns.filter(t => t.isDuplicate).length,
          taxResult:    result.inventoryResult,
          filteredCount: result.allFiltered.length,
          stageLog:     result.stageLog,
        };
      } finally {
        _pipelineRunning = false;
      }
    }

    // ── Fallback: legacy single-file pipeline ─────────────────
    // Used when tax-pipeline.js is not loaded (e.g., tests, standalone).
    // This path matches the original implementation exactly.
    _pipelineRunning = true;
    Events.emit('pipeline:start', {});

    try {
      const emit = (step, pct, msg) => {
        Events.emit('pipeline:step', { step, pct, msg });
        if (opts.onProgress) opts.onProgress({ step, pct, msg });
      };

      let txns = getTransactions();

      // Stage 3-equivalent: pre-filter failed/zero-value events
      // (lightweight inline version without the full PreFilter module)
      emit('decode', 5, 'Pre-filtering events…');
      const APPROVAL_CATS = new Set(['approval', 'account_creation']);
      const FAILED_STATUSES = new Set(['failed', 'cancelled', 'error', 'revert']);
      const beforeFilter = txns.length;
      txns = txns.filter(t => {
        if (t.status && FAILED_STATUSES.has((t.status || '').toLowerCase())) return false;
        if (t.rawStatus && FAILED_STATUSES.has((t.rawStatus || '').toLowerCase())) return false;
        if (APPROVAL_CATS.has((t.category || '').toLowerCase())) return false;
        const total = (t.amount || 0) + (t.inAmount || 0) + Math.abs(t.feeSEK || 0);
        if (total < 1e-12) return false;
        return true;
      });
      if (txns.length < beforeFilter) {
        console.log(`[Pipeline] Pre-filter: removed ${beforeFilter - txns.length} noise events`);
      }
      await tick();

      // Stage 6a: Decode on-chain events
      emit('decode', 10, 'Decoding on-chain events…');
      txns = decodeOnChainEvents(txns);
      await tick();

      // Stage 4: Resolve token metadata
      emit('tokens', 15, 'Resolving token names…');
      txns = await resolveAllTokenMetadata(txns, (p) => emit('tokens', 15, p.msg));
      await tick();

      // Stage 5: Detect spam tokens
      emit('spam', 22, 'Detecting spam tokens…');
      txns = detectSpamTokens(txns);
      await tick();

      // Stage 3b-equivalent: deduplication
      emit('dedup', 28, 'Detecting duplicate transactions…');
      txns = deduplicateTransactions(txns);
      await tick();

      // Stage 6b: Solana swap post-processing
      emit('classify', 33, 'Reconstructing Solana swaps…');
      const solanaResult = reprocessSolanaSwaps();
      if (solanaResult.merged > 0) {
        const toDeleteSet = new Set(solanaResult.toDelete);
        txns = txns.filter(t => !toDeleteSet.has(t.id));
        for (const newTx of solanaResult.toAdd) {
          if (!txns.find(t => t.txHash === newTx.txHash && t.category === CAT.TRADE)) {
            txns.push(newTx);
          }
        }
        console.log(`[Pipeline] Solana: merged ${solanaResult.merged} split swap pairs`);
      }
      await tick();

      // Stage 6c: Classify all transactions
      emit('classify', 36, 'Classifying transactions…');
      txns = autoClassifyAll(txns);
      await tick();

      // Stage 7: Match internal transfers
      emit('transfer', 44, 'Matching internal transfers…');
      txns = matchTransfers(txns);
      await tick();

      // Stage 8: Assign SEK prices
      emit('price', 52, 'Fetching historical SEK prices…');
      txns = await fetchAllSEKPrices(txns, (p) => {
        emit('price', 52 + Math.round(p.pct * 0.2), p.msg);
      });
      await tick();

      // Stage 8b: Negative balance detection
      emit('balance', 74, 'Checking for missing history…');
      txns = detectNegativeBalances(txns);
      await tick();

      // Save enriched NormalizedEvents
      emit('save', 80, 'Saving…');
      saveTransactions(txns);
      await tick();

      // Stage 9: Compute tax (Genomsnittsmetoden)
      emit('tax', 88, 'Computing Swedish tax (Genomsnittsmetoden)…');
      const settings = getSettings();
      const taxResult = computeTaxYear(settings.taxYear, txns);

      // Stage 10: Review issues
      const reviewIssues = getReviewIssues(txns, taxResult);

      emit('done', 100, `Done — ${txns.length.toLocaleString()} transactions, ${reviewIssues.length} issues`);

      const result = {
        totalTxns:    txns.length,
        reviewIssues: reviewIssues.length,
        duplicates:   txns.filter(t => t.isDuplicate).length,
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
  // STEP 8 — NEGATIVE BALANCE DETECTION
  // Simulate running holdings forward; any asset that goes
  // negative was sold before it was bought (missing history).
  // Tags the offending disposal transactions for review.
  // ════════════════════════════════════════════════════════════
  function detectNegativeBalances(txns) {
    // Forward-pass inventory simulation to find where disposals exceed available balance.
    // We track running qty and, separately, whether ANY acquisitions were ever seen.
    const sorted = [...txns].sort((a, b) => new Date(a.date) - new Date(b.date));
    const qty         = {};   // sym → running quantity
    const everBought  = {};   // sym → true if at least one acquisition event seen
    // Txns whose disposal causes a negative balance, keyed by id
    const badIds = new Map(); // id → 'unknown_acquisition' | 'negative_balance'

    for (const t of sorted) {
      if (t.isInternalTransfer) continue;
      if ([CAT.SPAM, CAT.APPROVAL, CAT.WRAP, CAT.UNWRAP].includes(t.category)) continue;
      const sym = t.assetSymbol;
      if (!sym) continue;
      if (qty[sym] === undefined) qty[sym] = 0;

      switch (t.category) {
        // ── Acquisition events ──
        case CAT.BUY:
        case CAT.RECEIVE:
        case CAT.TRANSFER_IN:
        case CAT.BRIDGE_IN:
        case CAT.INCOME:
        case CAT.STAKING:
        case CAT.AIRDROP:
          qty[sym] += t.amount || 0;
          everBought[sym] = true;
          // Track the in-side of a trade as an acquisition too
          if (t.inAsset && t.inAmount > 0) {
            if (qty[t.inAsset] === undefined) qty[t.inAsset] = 0;
            qty[t.inAsset] += t.inAmount;
            everBought[t.inAsset] = true;
          }
          break;

        // ── Disposal events ──
        case CAT.SELL:
        case CAT.SEND:
        case CAT.TRANSFER_OUT:
        case CAT.BRIDGE_OUT:
        case CAT.FEE:
          qty[sym] -= t.amount || 0;
          if (qty[sym] < -0.0001 && !t.manualCategory && !t.userReviewed) {
            // Distinguish: was this asset NEVER acquired vs. partial history gap?
            const reason = !everBought[sym]
              ? 'unknown_acquisition'   // No acquisition ever seen → genuinely unknown source
              : 'negative_balance';     // Acquired before, but gap in history
            badIds.set(t.id, reason);
          }
          break;

        case CAT.TRADE: {
          qty[sym] -= t.amount || 0;
          if (qty[sym] < -0.0001 && !t.manualCategory && !t.userReviewed) {
            const reason = !everBought[sym] ? 'unknown_acquisition' : 'negative_balance';
            badIds.set(t.id, reason);
          }
          if (t.inAsset && t.inAmount > 0) {
            if (qty[t.inAsset] === undefined) qty[t.inAsset] = 0;
            qty[t.inAsset] += t.inAmount;
            everBought[t.inAsset] = true;
          }
          break;
        }
      }
    }

    if (!badIds.size) return txns;

    return txns.map(t => {
      const reason = badIds.get(t.id);
      if (!reason) return t;
      return { ...t, needsReview: true, reviewReason: reason };
    });
  }

  // ════════════════════════════════════════════════════════════
  // REVIEW ISSUES
  // Comprehensive detection of all issue types.
  // Called AFTER pipeline completes with full taxResult context.
  // ════════════════════════════════════════════════════════════
  const REVIEW_DESCRIPTIONS = {
    // ── Missing price — split into tiers ───────────────────
    // K4 blocker: disposal (sale/trade) with no SEK value
    missing_sek_price:    { label: 'Missing price (K4 blocker)',  icon: '💰', priority: 'critical', isK4Blocker: true,
      why: 'This disposal (sale or trade) has no SEK price — required for K4 gain/loss calculation.',
      fix: 'Enter the market price in SEK on the transaction date. Check CoinMarketCap or CoinGecko historical data.',
      bulkActions: ['enter_price', 'mark_zero_cost', 'mark_spam'] },
    // Informational: received token that was never sold — not K4 blocking
    received_not_sold:    { label: 'Received — never sold',       icon: '📥', priority: 'low', isK4Blocker: false,
      why: 'This token was received but never sold. No SEK price was found, but it is not blocking your K4 since you have not disposed of it.',
      fix: 'No action required. If this was income (staking reward, salary, referral bonus), reclassify as Income so it is included in your income tax calculation.',
      bulkActions: ['mark_income', 'mark_spam', 'ignore_received'] },
    // Informational: auto-detected spam token — already zeroed
    spam_token:           { label: 'Spam / worthless token',      icon: '🗑️', priority: 'info', isK4Blocker: false,
      why: 'Auto-detected as a spam airdrop or dust transaction — set to zero value and excluded from K4.',
      fix: 'If this token actually has value, click "Override" to enter the correct SEK price.',
      bulkActions: ['confirm_spam', 'override_price'] },
    unknown_asset:        { label: 'Unknown token',               icon: '❓', why: 'Token metadata could not be resolved — symbol may be a contract address.', fix: 'Enter the price manually or mark as spam if worthless.' },
    unmatched_transfer:   { label: 'Unmatched transfer',          icon: '🔗', why: 'This send/receive could not be matched to your other accounts. If it left your control it may be a taxable disposal.', fix: 'Connect the destination account, or reclassify as sell/donation.' },
    negative_balance:     { label: 'Incomplete buy history',      icon: '⚠️', priority: 'high', isK4Blocker: true,
      why: 'More units were sold than recorded as acquired — some import history is missing. Cost basis has been partially reconstructed from available data.',
      fix: 'Import the full transaction history for this asset from all sources (exchange CSVs, other wallets, other chains). If the asset moved between your own wallets, make sure both sides are imported.',
      bulkActions: ['enter_price', 'mark_zero_cost', 'import_account'] },
    unknown_acquisition:  { label: 'Unknown acquisition source',  icon: '🔍', priority: 'critical', isK4Blocker: true,
      why: 'This disposal has no matching acquisition in any imported source. The asset may have been purchased on an unconnected exchange, received from an unimported wallet, or held before this wallet was tracked. Cost basis is set to 0 until resolved.',
      fix: 'Add the exchange or wallet where this was originally acquired — the engine will automatically match the deposit and remove this issue. Alternatively, enter the acquisition price manually.',
      bulkActions: ['import_account', 'enter_price', 'mark_zero_cost', 'mark_spam'] },
    duplicate:            { label: 'Possible duplicate',          icon: '📋', why: 'Very similar transaction found from another source. May double-count gains/losses.', fix: 'Review and delete one copy.' },
    unclassified:         { label: 'Unclassified',                icon: '🏷️', why: 'Could not determine what type of transaction this is.', fix: 'Select the correct category manually.' },
    ambiguous_swap:       { label: 'Incomplete swap',             icon: '↔️', why: 'Only one side of a swap was found — missing received asset or amount.', fix: 'Enter the received asset and amount on this transaction.' },
    unsupported_defi:     { label: 'Complex DeFi interaction',    icon: '🧩', why: 'This is a DeFi interaction (lending, LP, vault, etc.) that cannot be auto-classified.', fix: 'Classify manually as buy/sell/income/fee/ignore.' },
    bridge_review:        { label: 'Bridge / cross-chain',        icon: '🌉', why: 'Cross-chain bridge detected. If the receiving side was imported, it should be matched as a non-taxable transfer.', fix: 'Import the destination chain/wallet so the bridge pair can be matched, or confirm as non-taxable internal transfer.' },
    special_transaction:  { label: 'Special transaction',         icon: '⭐', why: 'Staking, LP, NFT, or airdrop transactions have special Swedish tax treatment.', fix: 'Verify classification is correct for your situation.' },
    unknown_contract:     { label: 'Unknown contract',            icon: '🤖', why: 'Interaction with an unrecognised smart contract — could be anything from an airdrop claim to a DeFi protocol.', fix: 'Investigate on a blockchain explorer and classify manually.' },
    outlier:              { label: 'Outlier / sanity check',      icon: '📊', why: 'This transaction has an unusually large gain/loss or an extreme price vs market value.', fix: 'Verify the SEK price is correct at the transaction date.' },
    split_trade:          { label: 'Possible split trade',        icon: '🔀', why: 'Multiple transactions near the same time may represent a single trade reported as separate rows.', fix: 'Check if these should be merged into one trade.' },
  };

  function getReviewIssues(txns, taxResult) {
    if (!txns) txns = getTransactions();
    const issues = [];
    const txById = new Map(txns.map(t => [t.id, t]));

    // ── Pass 1: Flag-based issues (set during pipeline) ──
    for (const t of txns) {
      if (!t.needsReview || !t.reviewReason) continue;
      if (t.category === CAT.SPAM || t.category === CAT.APPROVAL) continue;
      if (t.isDuplicate) {
        issues.push({ txnId: t.id, txn: t, reason: 'duplicate', meta: REVIEW_DESCRIPTIONS.duplicate });
        continue;
      }
      issues.push({
        txnId: t.id, txn: t, reason: t.reviewReason,
        meta: REVIEW_DESCRIPTIONS[t.reviewReason] || { label: t.reviewReason, icon: '⚠️', why: '', fix: '' },
      });
    }

    const flaggedIds = new Set(issues.map(i => i.txnId));

    // ── Build txHash → tx[] map for swap-context analysis ──
    const txsByHash = {};
    for (const t of txns) {
      if (t.txHash && !t.txHash.startsWith('manual_')) {
        (txsByHash[t.txHash] = txsByHash[t.txHash] || []).push(t);
      }
    }

    // ── Pass 2: Structural checks (independent of per-tx flags) ──
    const taxableCats = new Set([
      CAT.SELL, CAT.TRADE, CAT.RECEIVE, CAT.INCOME, CAT.BUY,
      CAT.STAKING, CAT.NFT_SALE, CAT.AIRDROP, CAT.UNKNOWN_ACQUISITION,
    ]);

    for (const t of txns) {
      if (t.userReviewed || t.isInternalTransfer) continue;
      if (t.category === CAT.SPAM || t.category === CAT.APPROVAL) continue;
      if (flaggedIds.has(t.id)) continue;

      // 1. Missing SEK price on taxable event — split by confidence tier
      if (taxableCats.has(t.category) && !t.priceSEKPerUnit && !t.costBasisSEK) {
        const conf = t.priceConfidence;
        const reason = t.reviewReason;

        // Group B: spam_zero — already auto-zeroed, never surface in review
        if (conf === PC.SPAM_ZERO || reason === 'spam_token') {
          flaggedIds.add(t.id); continue;
        }
        // Group C: received but never sold — low-priority informational only
        if (conf === PC.RECEIVED_UNSOLD || reason === 'received_not_sold') {
          issues.push({ txnId: t.id, txn: t, reason: 'received_not_sold',
            meta: REVIEW_DESCRIPTIONS.received_not_sold, priority: 'low', isK4Blocker: false });
          flaggedIds.add(t.id); continue;
        }
        // Group D: true unknown — K4 blocker (disposals) or high-priority acquisition
        const isDisposal = [CAT.SELL, CAT.TRADE, CAT.NFT_SALE].includes(t.category);
        // Determine WHY this transaction is still unpriced, and the best fix
        const sym = (t.assetSymbol || '').toUpperCase();
        const hashGroup  = t.txHash ? (txsByHash[t.txHash] || []) : [];
        const pricedPeers = hashGroup.filter(x => x.id !== t.id && x.priceSEKPerUnit > 0 && x.priceSource !== PS.MISSING);
        const swapPeers   = hashGroup.filter(x => x.id !== t.id);
        const hasKnownId  = !!(CC_IDS[sym] || t.coinGeckoId || STABLES.has(sym));
        let priceBlockReason, suggestedAction;
        if (pricedPeers.length > 0) {
          // Has a priced swap partner — inference should have resolved this; signal re-pipeline
          priceBlockReason = 'swap_inference_failed';
          suggestedAction  = 'rerun_pipeline';
        } else if (swapPeers.length > 0) {
          // Has swap context but the counterpart is also unpriced
          priceBlockReason = 'no_priced_swap_leg';
          suggestedAction  = isDisposal ? 'enter_price' : 'enter_price';
        } else if (!hasKnownId) {
          // Token not in any price database — no external pricing possible
          priceBlockReason = 'no_market_listing';
          suggestedAction  = isDisposal ? 'enter_price' : 'mark_spam';
        } else {
          // Known token but API returned no data (delisted, missing date range, rate-limited)
          priceBlockReason = 'market_api_failed';
          suggestedAction  = 'batch_price_lookup';
        }
        issues.push({ txnId: t.id, txn: t, reason: 'missing_sek_price',
          meta: REVIEW_DESCRIPTIONS.missing_sek_price,
          priority: isDisposal ? 'critical' : 'high', isK4Blocker: isDisposal,
          priceBlockReason, suggestedAction });
        flaggedIds.add(t.id); continue;
      }

      // 2. Unknown token (contract address still showing or no name/CoinGecko ID)
      if (taxableCats.has(t.category) && !t.coinGeckoId && !STABLES.has(t.assetSymbol)) {
        if (looksLikeContractAddress(t.assetSymbol) || (!t.assetName && !TOKEN_DISPLAY_NAMES[t.assetSymbol?.toUpperCase()])) {
          issues.push({ txnId: t.id, txn: t, reason: 'unknown_asset', meta: REVIEW_DESCRIPTIONS.unknown_asset });
          flaggedIds.add(t.id); continue;
        }
      }

      // 3. Unmatched external transfer (SEND/RECEIVE not paired, potentially taxable)
      if ((t.category === CAT.SEND || t.category === CAT.TRANSFER_OUT) && !t.matchedTxId && !t.isInternalTransfer) {
        issues.push({ txnId: t.id, txn: t, reason: 'unmatched_transfer', meta: REVIEW_DESCRIPTIONS.unmatched_transfer });
        flaggedIds.add(t.id); continue;
      }

      // 4. Bridge / cross-chain: unmatched bridge sends and bridge receives
      if ((t.category === CAT.BRIDGE || t.category === CAT.BRIDGE_IN || t.category === CAT.BRIDGE_OUT) && !t.isInternalTransfer) {
        issues.push({ txnId: t.id, txn: t, reason: 'bridge_review', meta: REVIEW_DESCRIPTIONS.bridge_review });
        flaggedIds.add(t.id); continue;
      }

      // 5. Special transactions (staking, NFT)
      if ([CAT.STAKING, CAT.NFT_SALE].includes(t.category)) {
        issues.push({ txnId: t.id, txn: t, reason: 'special_transaction', meta: REVIEW_DESCRIPTIONS.special_transaction });
        flaggedIds.add(t.id); continue;
      }

      // 6. Airdrops — flag for tax treatment confirmation
      if (t.category === CAT.AIRDROP) {
        issues.push({ txnId: t.id, txn: t, reason: 'special_transaction', meta: REVIEW_DESCRIPTIONS.special_transaction });
        flaggedIds.add(t.id); continue;
      }

      // 7. Unknown contract interaction
      if (t.category === CAT.DEFI_UNKNOWN) {
        issues.push({ txnId: t.id, txn: t, reason: 'unknown_contract', meta: REVIEW_DESCRIPTIONS.unknown_contract });
        flaggedIds.add(t.id); continue;
      }

      // 8. Incomplete swap (TRADE but no inAsset or inAmount)
      if (t.category === CAT.TRADE && (!t.inAsset || !t.inAmount)) {
        issues.push({ txnId: t.id, txn: t, reason: 'ambiguous_swap', meta: REVIEW_DESCRIPTIONS.ambiguous_swap });
        flaggedIds.add(t.id); continue;
      }
    }

    // ── Pass 2b: Unknown acquisition from taxResult disposals ──
    // These are disposals where inventory went negative (sold > ever acquired)
    if (taxResult?.disposals) {
      for (const d of taxResult.disposals) {
        if (flaggedIds.has(d.id) || !d.unknownAcquisition) continue;
        const t = txById.get(d.id);
        if (!t || t.userReviewed) continue;
        issues.push({ txnId: d.id, txn: t, reason: 'unknown_acquisition', meta: REVIEW_DESCRIPTIONS.unknown_acquisition });
        flaggedIds.add(d.id);
      }
    }

    // ── Pass 3: Outlier detection using disposal results ──
    if (taxResult?.disposals) {
      for (const d of taxResult.disposals) {
        if (flaggedIds.has(d.id)) continue;
        const t = txById.get(d.id);
        if (!t || t.userReviewed) continue;
        // Flag extreme gain/loss: gain > 10× cost basis is suspicious
        const ratio = d.costBasisSEK > 0 ? d.gainLossSEK / d.costBasisSEK : 0;
        if (Math.abs(ratio) > 10 && Math.abs(d.gainLossSEK) > 1000) {
          issues.push({ txnId: d.id, txn: t, reason: 'outlier', meta: REVIEW_DESCRIPTIONS.outlier });
          flaggedIds.add(d.id);
        }
      }
    }

    // Sort: most critical first
    // K4 blockers → high priority → informational → spam/info
    const ORDER = [
      'unknown_acquisition',  // disposal with zero cost basis
      'negative_balance',     // partial history gap
      'missing_sek_price',    // disposal with no price — K4 blocker
      'unknown_asset',        // token not resolved
      'duplicate',
      'ambiguous_swap',
      'unmatched_transfer',
      'bridge_review',
      'outlier',
      'split_trade',
      'unknown_contract',
      'unsupported_defi',
      'special_transaction',
      'unclassified',
      'received_not_sold',    // informational — received but never sold
      'spam_token',           // auto-zeroed spam — lowest priority
    ];
    // Within same reason, disposals (critical) come before acquisitions (high)
    issues.sort((a, b) => {
      const ai = ORDER.indexOf(a.reason); const bi = ORDER.indexOf(b.reason);
      const rankA = ai === -1 ? 99 : ai;
      const rankB = bi === -1 ? 99 : bi;
      if (rankA !== rankB) return rankA - rankB;
      // Tie-break: K4-blocking disposals before non-blocking acquisitions
      const aK4 = a.isK4Blocker ? 0 : 1;
      const bK4 = b.isK4Blocker ? 0 : 1;
      return aK4 - bK4;
    });

    return issues;
  }

  // ════════════════════════════════════════════════════════════
  // SWEDISH TAX ENGINE — Genomsnittsmetoden
  // Full inventory reconstruction before gain/loss calculation.
  // Every economic meaning is resolved before touching the ledger.
  // ════════════════════════════════════════════════════════════
  function computeTaxYear(year, txns) {
    if (!txns) txns = getTransactions();
    year = parseInt(year);

    // ── Pre-pass: detect assets sold with no acquisition in imported data ──────
    // When a user's full history isn't imported (e.g. they only imported one wallet
    // but bought on an exchange), disposals appear without prior acquisitions.
    //
    // Reconstruction heuristic:
    //   1. Find every asset that has at least one disposal but NO acquisition event
    //      anywhere in the transaction set (not just the tax year — all history).
    //   2. For each such "orphan" asset, look for any RECEIVE or TRANSFER_IN that
    //      was marked isInternalTransfer=true (meaning its cost basis was assumed
    //      to come from the sending side, which wasn't imported). Those transfers
    //      are the most likely acquisition record we have.
    //   3. Pre-populate the holdings with the priced RECEIVE so the disposal gets a
    //      real cost basis instead of 0.
    //
    // This handles the most common case: "I bought on Binance, withdrew to my
    // Phantom wallet, and only imported the Phantom wallet."
    {
      const ACQ_CATS = new Set([CAT.BUY, CAT.RECEIVE, CAT.TRANSFER_IN, CAT.BRIDGE_IN,
                                 CAT.INCOME, CAT.STAKING, CAT.AIRDROP]);
      const DISP_CATS = new Set([CAT.SELL, CAT.TRADE, CAT.SEND, CAT.TRANSFER_OUT,
                                  CAT.BRIDGE_OUT, CAT.FEE]);

      // Collect acquisition and disposal sets across ALL time (no year filter)
      const acqSyms  = new Set();
      const dispSyms = new Set();
      for (const t of txns) {
        if (t.isDuplicate) continue;
        const sym = t.assetSymbol;
        if (!sym) continue;
        if (ACQ_CATS.has(t.category))  acqSyms.add(sym);
        if (t.inAsset && t.inAmount > 0) acqSyms.add(t.inAsset);
        if (DISP_CATS.has(t.category)) dispSyms.add(sym);
      }

      // Assets disposed but NEVER acquired in any imported data
      const neverAcquired = [...dispSyms].filter(s => !acqSyms.has(s));

      if (neverAcquired.length > 0) {
        // For each orphan asset, find TRANSFER_IN / isInternalTransfer RECEIVEs
        // (these are receives that matched a send from another of our accounts —
        // their cost basis legitimately comes from that account's acquisition cost).
        // If found AND priced, we can pre-seed the holdings with the earliest one.
        const orphanSet = new Set(neverAcquired);
        const syntheticAcq = {};  // sym → { qty, costSEK }

        for (const t of txns) {
          if (t.isDuplicate) continue;
          const sym = t.assetSymbol;
          if (!orphanSet.has(sym)) continue;
          const isTransferIn = t.category === CAT.TRANSFER_IN ||
            (t.category === CAT.RECEIVE && t.isInternalTransfer);
          if (!isTransferIn) continue;

          const amt   = t.amount || 0;
          const price = t.priceSEKPerUnit || 0;
          if (amt <= 0) continue;

          if (!syntheticAcq[sym]) syntheticAcq[sym] = { qty: 0, costSEK: 0 };
          syntheticAcq[sym].qty     += amt;
          syntheticAcq[sym].costSEK += price > 0 ? price * amt
            : (STABLES.has(sym)
                ? (EUR_STABLES.has(sym) ? STABLE_SEK.EUR : STABLE_SEK.USD) * amt
                : 0);
        }

        // If no TRANSFER_IN was found, try plain RECEIVE events (even unmatched ones)
        // — they represent tokens arriving from an external source; their market-rate
        // price at receipt IS the acquisition cost.
        for (const t of txns) {
          if (t.isDuplicate) continue;
          const sym = t.assetSymbol;
          if (!orphanSet.has(sym) || syntheticAcq[sym]) continue;
          if (t.category !== CAT.RECEIVE) continue;

          const amt   = t.amount || 0;
          const price = t.priceSEKPerUnit || 0;
          if (amt <= 0) continue;

          if (!syntheticAcq[sym]) syntheticAcq[sym] = { qty: 0, costSEK: 0 };
          syntheticAcq[sym].qty     += amt;
          syntheticAcq[sym].costSEK += price > 0 ? price * amt
            : (STABLES.has(sym)
                ? (EUR_STABLES.has(sym) ? STABLE_SEK.EUR : STABLE_SEK.USD) * amt
                : 0);
        }

        // Pre-seed holdings with reconstructed acquisitions
        for (const [sym, { qty, costSEK }] of Object.entries(syntheticAcq)) {
          if (!holdings[sym]) holdings[sym] = { totalQty: 0, totalCostSEK: 0 };
          holdings[sym].totalQty     += qty;
          holdings[sym].totalCostSEK += costSEK;
          console.log(`[TaxEngine] Pre-seeded ${sym}: qty=${qty.toFixed(4)} costSEK=${costSEK.toFixed(2)} (reconstructed from receive/transfer)`);
        }
      }
    }

    // Process ALL history (including prior years) to build correct cost basis
    const allSorted = [...txns]
      .filter(t => new Date(t.date).getFullYear() <= year)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    // Per-asset inventory: { totalQty, totalCostSEK }
    // Assets are tracked by canonical symbol (WETH→ETH already normalised at import)
    const holdings  = {};
    const disposals = [];  // in target year
    const income    = [];  // in target year

    function ensure(sym) {
      if (!holdings[sym]) holdings[sym] = { totalQty: 0, totalCostSEK: 0 };
    }
    function avg(sym) {
      const h = holdings[sym];
      return (h && h.totalQty > 0) ? h.totalCostSEK / h.totalQty : 0;
    }

    // Record a disposal into the ledger
    // unknownAcq = true when we're selling more than we ever recorded acquiring
    function recordDisposal(t, sym, qty, proceedsSEK, feeSEK, extraFields = {}) {
      const h = holdings[sym] || { totalQty: 0, totalCostSEK: 0 };
      const available = h.totalQty;
      const unknownAcq = qty > available + 0.0001;  // sold more than we have
      const safeQty    = unknownAcq ? qty : Math.min(qty, available);
      // Under Genomsnittsmetoden: when acquisition is unknown, cost basis = 0
      // (Skatteverket assumes full proceeds = gain when no evidence of cost exists).
      // Exception: stablecoins pegged to a known fiat value. Using their ~1 USD / ~1 EUR
      // peg as fallback avoids inflating K4 with fictional gains on pass-through stables.
      let costBasis;
      if (!unknownAcq) {
        costBasis = avg(sym) * safeQty;
      } else if (STABLES.has(sym)) {
        const stableSEK = EUR_STABLES.has(sym) ? STABLE_SEK.EUR : STABLE_SEK.USD;
        costBasis = safeQty * stableSEK;
      } else {
        costBasis = 0;  // Unknown non-stable: full proceeds = gain (Skatteverket default)
      }
      const gainLoss   = proceedsSEK - feeSEK - costBasis;

      // Reduce holdings (floor at 0)
      h.totalQty     = Math.max(0, h.totalQty - safeQty);
      h.totalCostSEK = Math.max(0, h.totalCostSEK - costBasis);

      return {
        date: t.date,
        assetSymbol: sym,
        assetName: t.assetName || sym,
        amountSold: safeQty,
        proceedsSEK,
        feeSEK,
        costBasisSEK: costBasis,
        gainLossSEK: gainLoss,
        avgCostAtSale: avg(sym),
        id: t.id,
        needsReview: t.needsReview || unknownAcq,
        unknownAcquisition: unknownAcq,
        ...extraFields,
      };
    }

    for (const t of allSorted) {
      const sym = t.assetSymbol;
      if (!sym) continue;
      // Skip spam / approvals — non-economic
      if ([CAT.SPAM, CAT.APPROVAL].includes(t.category)) continue;
      // Skip internal transfers — no economic event (already matched by matchTransfers)
      if (t.isInternalTransfer) continue;

      ensure(sym);
      const h       = holdings[sym];
      const inYear  = new Date(t.date).getFullYear() === year;
      const priceSEK    = t.priceSEKPerUnit || (t.costBasisSEK / (t.amount || 1)) || 0;
      const proceedsSEK = t.costBasisSEK    || (priceSEK * (t.amount || 0));
      const feeSEK      = t.feeSEK || 0;

      switch (t.category) {

        // ── Acquisition events: add to inventory ───────────
        case CAT.BUY:
        case CAT.RECEIVE: {
          // RECEIVE carries cost basis at FMV (treated as acquisition)
          // Internal transfers were filtered above, so this is genuine incoming
          const cost = proceedsSEK + feeSEK;
          h.totalQty     += t.amount;
          h.totalCostSEK += cost;
          // Unclassified receives count as income per Skatteverket default
          if (inYear && t.category === CAT.RECEIVE) {
            income.push({ date: t.date, assetSymbol: sym, amount: t.amount,
                          valueSEK: proceedsSEK, id: t.id, category: t.category });
          }
          break;
        }

        case CAT.INCOME:
        case CAT.STAKING: {
          // Staking rewards & income: add at FMV, report as income
          h.totalQty     += t.amount;
          h.totalCostSEK += proceedsSEK;
          if (inYear) {
            income.push({ date: t.date, assetSymbol: sym, amount: t.amount,
                          valueSEK: proceedsSEK, id: t.id, category: t.category });
          }
          break;
        }

        case CAT.AIRDROP: {
          // Airdrops = income at FMV (Skatteverket ruling)
          h.totalQty     += t.amount;
          h.totalCostSEK += proceedsSEK;
          if (inYear) {
            income.push({ date: t.date, assetSymbol: sym, amount: t.amount,
                          valueSEK: proceedsSEK, id: t.id, category: CAT.AIRDROP });
          }
          break;
        }

        // Non-taxable inbound transfers — carry over cost basis at avg
        case CAT.TRANSFER_IN:
        case CAT.BRIDGE_IN: {
          // Cost basis moves with the asset: use the asset's market price at arrival
          // (the sending side already deducted from its holdings)
          const costAtArrival = proceedsSEK + feeSEK;
          h.totalQty     += t.amount;
          h.totalCostSEK += costAtArrival || (avg(sym) * t.amount);
          break;
        }

        // ── Disposal events ─────────────────────────────────
        case CAT.SELL: {
          const d = recordDisposal(t, sym, t.amount, proceedsSEK, feeSEK);
          if (inYear) disposals.push(d);
          break;
        }

        case CAT.SEND: {
          // Unmatched SEND that wasn't caught as internal transfer
          // — treat as disposal (possible gift/donation, taxable in Sweden)
          const d = recordDisposal(t, sym, t.amount, proceedsSEK, feeSEK);
          if (inYear) disposals.push(d);
          break;
        }

        case CAT.TRANSFER_OUT:
        case CAT.BRIDGE_OUT: {
          // Non-taxable outbound: reduce inventory, preserve cost basis ratio
          const qty  = Math.min(t.amount, h.totalQty);
          const cb   = avg(sym) * qty;
          h.totalQty     = Math.max(0, h.totalQty - qty);
          h.totalCostSEK = Math.max(0, h.totalCostSEK - cb);
          break;
        }

        case CAT.TRADE: {
          const inSym  = t.inAsset;
          const inAmt  = t.inAmount || 0;

          // ── Swap-at-cost fallback ───────────────────────────────────────────
          // When the pricing chain could not price the out-side asset (memecoin
          // with no market data), proceedsSEK = 0. Storing 0 as the in-side cost
          // cascades into phantom gains every time the received asset (e.g. SOL)
          // is later disposed of.
          //
          // Fallback strategy (in priority order):
          //   1. proceedsSEK > 0 from pricing chain → use it directly (happy path)
          //   2. avg(inSym) > 0 → use avg cost of received asset × qty as a
          //      neutral "swap at cost" estimate (no gain, no loss on this trade)
          //   3. avg(sym) > 0 → use avg cost of out-side × qty (your cost basis
          //      is used as proceeds — zero-gain treatment)
          //   4. Fall through with 0 (unresolvable, flagged in review)
          //
          // The 'proceedsSource: swap_at_cost' field is propagated to the disposal
          // record so the health checker and UI can flag these rows distinctly from
          // fully-priced disposals.
          let effectiveProceedsSEK = proceedsSEK;
          let swapAtCost = false;

          if (effectiveProceedsSEK <= 0 && inSym && inAmt > 0) {
            ensure(inSym);
            const inAvgCost = avg(inSym);
            if (inAvgCost > 0) {
              // Use the avg cost of the received asset as a proxy for trade value.
              // This is defensible: we know what we received is worth at least its
              // average purchase price. Result: trade is revenue-neutral.
              effectiveProceedsSEK = inAvgCost * inAmt;
              swapAtCost = true;
            } else {
              // Received asset has 0 avg cost (also unknown). Try out-side avg cost.
              const outAvgCost = avg(sym);
              if (outAvgCost > 0) {
                effectiveProceedsSEK = outAvgCost * t.amount;
                swapAtCost = true;
              }
            }
          }

          // Out side: disposal of `sym`
          const tradeExtra = { isTrade: true, inAsset: inSym, inAmount: inAmt };
          if (swapAtCost) {
            tradeExtra.proceedsSource = 'swap_at_cost';
            tradeExtra.swapAtCostEstimate = effectiveProceedsSEK;
            // Keep needsReview = true so these show in the review queue
            tradeExtra.needsReview = true;
          }
          const d = recordDisposal(t, sym, t.amount, effectiveProceedsSEK, feeSEK, tradeExtra);
          if (inYear) disposals.push(d);
          // In side: acquisition of `inSym` at cost = FMV of what was given up
          if (inSym && inAmt > 0) {
            ensure(inSym);
            holdings[inSym].totalQty     += inAmt;
            holdings[inSym].totalCostSEK += effectiveProceedsSEK; // FMV of out-side = cost of in-side
          }
          break;
        }

        // Wrap/unwrap: non-taxable — asset stays in inventory under canonical name
        // (normalizeAssetSymbol already mapped WETH → ETH at import time,
        //  so wrap/unwrap events should share the same sym key)
        case CAT.WRAP:
        case CAT.UNWRAP:
          // Nothing to do: inventory already uses canonical symbol
          break;

        case CAT.FEE: {
          // Fees paid in crypto = small disposal at market value (per Skatteverket)
          const GAS_TOKENS = new Set(['ETH', 'SOL', 'BNB', 'MATIC', 'AVAX', 'ARB', 'OP']);
          if (!GAS_TOKENS.has(sym)) break;
          const qty      = Math.min(t.amount, h.totalQty);
          const feeProc  = priceSEK * qty;
          const feeCb    = avg(sym) * qty;
          const feeGain  = feeProc - feeCb;
          if (inYear && Math.abs(feeGain) > 0.01) {
            disposals.push({
              date: t.date, assetSymbol: sym, amountSold: qty,
              proceedsSEK: feeProc, feeSEK: 0,
              costBasisSEK: feeCb, gainLossSEK: feeGain,
              id: t.id, isFee: true, needsReview: false,
            });
          }
          h.totalQty     = Math.max(0, h.totalQty - qty);
          h.totalCostSEK = Math.max(0, h.totalCostSEK - feeCb);
          break;
        }
      }
    }

    // Summary
    const totalGains = disposals.filter(d => d.gainLossSEK > 0).reduce((s, d) => s + d.gainLossSEK, 0);
    const totalLosses = disposals.filter(d => d.gainLossSEK < 0).reduce((s, d) => s + Math.abs(d.gainLossSEK), 0);
    const netGainLoss = totalGains - totalLosses;
    // Per Skatteverket: only 70% of losses are deductible against gains (SFL 42 kap. 26§)
    const deductLoss = totalLosses * LOSS_DEDUCTION;
    const taxableGain = Math.max(0, totalGains - deductLoss);
    const estimatedTax = taxableGain * TAX_RATE;
    const totalIncome = income.reduce((s, i) => s + i.valueSEK, 0);

    // Target-year transactions only (for stats)
    const yearTxns = txns.filter(t => new Date(t.date).getFullYear() === year);

    // Current holdings — resolve display symbol/name so the UI always shows
    // human-readable tokens (JUPYIWRY → JUP "Jupiter", EPJFWDD5 → USDC, etc.)
    const currentHoldings = Object.entries(holdings)
      .filter(([, h]) => h.totalQty > 1e-9)
      .map(([sym, h]) => {
        const td = resolveTokenDisplay(sym);
        return {
          symbol: td.symbol || sym,
          assetName: td.name || h.assetName || sym,
          quantity: h.totalQty,
          avgCostSEK: h.totalQty > 0 ? h.totalCostSEK / h.totalQty : 0,
          totalCostSEK: h.totalCostSEK,
        };
      })
      .sort((a, b) => b.totalCostSEK - a.totalCostSEK);

    // Aggregate proceeds / cost for declaration reference
    const totalProceeds = disposals.reduce((s, d) => s + d.proceedsSEK, 0);
    const totalCostBasis = disposals.reduce((s, d) => s + d.costBasisSEK, 0);

    return {
      year, disposals, income, currentHoldings,
      summary: {
        totalTransactions: yearTxns.length,
        totalDisposals: disposals.length,
        totalProceeds, totalCostBasis,
        totalGains, totalLosses, netGainLoss,
        taxableGain, deductibleLoss: deductLoss,
        estimatedTax, totalIncome,
      },
    };
  }

  // ════════════════════════════════════════════════════════════
  // REPORT HEALTH — sanity check before presenting K4 totals
  // Analyses the disposals list for signs that the numbers are
  // unreliable, and returns a health status with actionable details.
  // ════════════════════════════════════════════════════════════
  function computeReportHealth(taxResult) {
    if (!taxResult || !taxResult.disposals) {
      return { status: 'unknown', level: -1, label: 'Inga data', canFile: false, details: [] };
    }
    const { disposals, summary } = taxResult;
    const total = disposals.length;

    if (total === 0) {
      return { status: 'ok', level: 3, label: 'Inga avyttringar att deklarera', canFile: true, details: [] };
    }

    // Count problem categories
    const unknownAcqCount = disposals.filter(d => d.unknownAcquisition).length;
    const swapAtCostCount = disposals.filter(d => d.proceedsSource === 'swap_at_cost').length;
    // Zero-cost disposals that are NOT flagged as unknownAcquisition (silent 0-cost rows)
    const silentZeroCost  = disposals.filter(d =>
      !d.unknownAcquisition &&
      d.proceedsSEK > 100 &&
      d.costBasisSEK === 0 &&
      d.proceedsSource !== 'swap_at_cost'
    ).length;
    const k4Blockers = unknownAcqCount + silentZeroCost;

    // Fraction of disposals with unresolved pricing
    const pctUnresolved = total > 0 ? k4Blockers / total : 0;
    // Is the gain suspiciously large relative to proceeds? (>10× gain ratio = likely phantom)
    const gainRatio = (summary.totalProceeds || 0) > 1000
      ? (summary.totalGains || 0) / (summary.totalProceeds || 1)
      : 0;
    const suspiciouslyHighGain = gainRatio > 0.95 && (summary.totalGains || 0) > 50000;

    const details = [];
    if (unknownAcqCount > 0)  details.push(`${unknownAcqCount} avyttring${unknownAcqCount !== 1 ? 'ar' : ''} med okänd anskaffning (kostnadsbas = 0)`);
    if (silentZeroCost > 0)   details.push(`${silentZeroCost} avyttring${silentZeroCost !== 1 ? 'ar' : ''} med saknat pris (0 kr kostnadsbas)`);
    if (swapAtCostCount > 0)  details.push(`${swapAtCostCount} swap${swapAtCostCount !== 1 ? 's' : ''} prissatt med uppskattning (swap-at-cost)`);
    if (suspiciouslyHighGain) details.push(`Vinst/försäljningspris-kvot ${(gainRatio * 100).toFixed(0)}% — ovanligt hög, kontrollera importhistorik`);

    // Status levels: 0 = invalid, 1 = needs_review, 2 = warnings, 3 = ok
    if (pctUnresolved > 0.25 || suspiciouslyHighGain) {
      return {
        status: 'invalid',
        level: 0,
        label: 'Sannolikt felaktigt — granska innan inlämning',
        sublabel: 'Många avyttringar saknar korrekt kostnadsbas. Kontrollera importhistoriken.',
        canFile: false,
        details,
        k4Blockers, unknownAcqCount, swapAtCostCount, silentZeroCost,
      };
    }
    if (pctUnresolved > 0.05 || unknownAcqCount > 3 || (swapAtCostCount > 10 && unknownAcqCount > 0)) {
      return {
        status: 'needs_review',
        level: 1,
        label: 'Granska innan inlämning',
        sublabel: `${k4Blockers} avyttring${k4Blockers !== 1 ? 'ar' : ''} kräver granskning.`,
        canFile: false,
        details,
        k4Blockers, unknownAcqCount, swapAtCostCount, silentZeroCost,
      };
    }
    if (unknownAcqCount > 0 || swapAtCostCount > 0 || silentZeroCost > 0) {
      return {
        status: 'warnings',
        level: 2,
        label: 'Klar med varningar',
        sublabel: details.join(' · '),
        canFile: true,
        details,
        k4Blockers, unknownAcqCount, swapAtCostCount, silentZeroCost,
      };
    }
    return {
      status: 'ok',
      level: 3,
      label: 'Klar för inlämning',
      sublabel: `${total} avyttring${total !== 1 ? 'ar' : ''} — fullständig importhistorik`,
      canFile: true,
      details: [],
      k4Blockers: 0, unknownAcqCount: 0, swapAtCostCount: 0, silentZeroCost: 0,
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
      if (!assetMap[d.assetSymbol]) assetMap[d.assetSymbol] = { gains: [], losses: [] };
      if (d.gainLossSEK >= 0) assetMap[d.assetSymbol].gains.push(d);
      else assetMap[d.assetSymbol].losses.push(d);
    }

    // Build K4 rows: max 2 per asset (gain row + loss row)
    const k4Rows = [];
    for (const [sym, { gains, losses }] of Object.entries(assetMap)) {
      // Resolve human-readable name for beteckning field
      const td = resolveTokenDisplay(sym);
      const displayName = td.name
        ? `${td.name} (${td.symbol || sym})`
        : (td.symbol || sym);
      if (gains.length > 0) {
        const qty  = gains.reduce((s, d) => s + d.amountSold, 0);
        const proc = gains.reduce((s, d) => s + d.proceedsSEK, 0);
        const cost = gains.reduce((s, d) => s + d.costBasisSEK, 0);
        const gain = gains.reduce((s, d) => s + d.gainLossSEK, 0);
        const unknownAcqCount = gains.filter(d => d.unknownAcquisition).length;
        const swapAtCostCount = gains.filter(d => d.proceedsSource === 'swap_at_cost').length;
        const confidence = unknownAcqCount > 0 ? 'unknown'
          : swapAtCostCount > 0 ? 'estimated'
          : cost === 0 && proc > 0 ? 'zero_cost'
          : 'exact';
        k4Rows.push({ sym, displayName, side: 'gain', qty, proc, cost, gain, loss: 0,
          confidence, unknownAcqCount, swapAtCostCount });
      }
      if (losses.length > 0) {
        const qty  = losses.reduce((s, d) => s + d.amountSold, 0);
        const proc = losses.reduce((s, d) => s + d.proceedsSEK, 0);
        const cost = losses.reduce((s, d) => s + d.costBasisSEK, 0);
        const loss = Math.abs(losses.reduce((s, d) => s + d.gainLossSEK, 0));
        const unknownAcqCount = losses.filter(d => d.unknownAcquisition).length;
        const swapAtCostCount = losses.filter(d => d.proceedsSource === 'swap_at_cost').length;
        const confidence = unknownAcqCount > 0 ? 'unknown'
          : swapAtCostCount > 0 ? 'estimated'
          : cost === 0 && proc > 0 ? 'zero_cost'
          : 'exact';
        k4Rows.push({ sym, displayName, side: 'loss', qty, proc, cost, gain: 0, loss,
          confidence, unknownAcqCount, swapAtCostCount });
      }
    }

    // Total sums
    const totalGains = k4Rows.reduce((s, r) => s + r.gain, 0);
    const totalLosses = k4Rows.reduce((s, r) => s + r.loss, 0);

    return {
      k4Rows, totalGains, totalLosses, year, userInfo,
      formsNeeded: Math.max(1, Math.ceil(k4Rows.length / ROWS_PER_K4_FORM))
    };
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
      const pageRows = k4.k4Rows.slice(page * ROWS_PER_PAGE, (page + 1) * ROWS_PER_PAGE);
      lines.push(
        `; ─────────────────────────────────────────────────────────────`,
        `; K4 BLANKETT ${page + 1} av ${k4.formsNeeded}  |  Inkomstår ${k4.year}`,
        `; D. Övriga värdepapper / andra tillgångar (kryptovalutor)`,
        `; ─────────────────────────────────────────────────────────────`,
        `Rad,Antal/Belopp,Beteckning/Valutakod,Försäljningspris (SEK),Omkostnadsbelopp (SEK),Vinst,Förlust`,
      );

      for (let row = 1; row <= ROWS_PER_PAGE; row++) {
        const r = pageRows[row - 1];
        if (r) {
          const label = r.displayName || r.sym;
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

      const pageGain = pageRows.reduce((s, r) => s + r.gain, 0);
      const pageLoss = pageRows.reduce((s, r) => s + r.loss, 0);
      lines.push(
        ``,
        `; Summa vinst blankett ${page + 1}:,,,,,${Math.round(pageGain)},`,
        `; Summa förlust blankett ${page + 1}:,,,,,,${Math.round(pageLoss)}`,
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
    const sortedDisposals = [...disposals].sort((a, b) => a.date.localeCompare(b.date));
    for (const d of sortedDisposals) {
      const td = resolveTokenDisplay(d.assetSymbol);
      lines.push([
        new Date(d.date).toLocaleDateString('sv-SE'),
        `"${td.symbol || d.assetSymbol}"`,
        `"${td.name || td.symbol || d.assetSymbol}"`,
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
      const sortedIncome = [...income].sort((a, b) => a.date.localeCompare(b.date));
      for (const inc of sortedIncome) {
        const td = resolveTokenDisplay(inc.assetSymbol);
        lines.push([
          new Date(inc.date).toLocaleDateString('sv-SE'),
          `"${td.symbol || inc.assetSymbol}"`,
          `"${td.name || td.symbol || inc.assetSymbol}"`,
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
      header.forEach((h, i) => { obj[h.trim().replace(/"/g, '')] = (cols[i] || '').trim().replace(/"/g, ''); });
      return obj;
    }).filter(row => Object.values(row).some(v => v));
  }

  function splitCSVLine(line) {
    const cols = []; let cur = ''; let inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { cols.push(cur); cur = ''; }
      else { cur += ch; }
    }
    cols.push(cur);
    return cols;
  }

  function parseBinanceCSV(text, accountId) {
    const rows = parseCSV(text);
    return rows.map(r => {
      const side = (r['Side'] || r['Type'] || '').toUpperCase();
      const pair = r['Pair'] || r['Symbol'] || '';
      // Extract quote asset from trading pair (e.g. BTCUSDT → USDT, ETHBTC → BTC)
      const quoteMatch = pair.match(/(USDT|BUSD|USDC|TUSD|USDP|EUR|USD|BTC|ETH|BNB)$/i);
      const quoteAsset = (quoteMatch ? quoteMatch[1] : (r['Quote Asset'] || 'USDT')).toUpperCase();
      const base = pair.replace(new RegExp(quoteAsset + '$', 'i'), '').toUpperCase()
                || (r['Coin'] || r['Asset'] || '').toUpperCase();
      const qty   = parseFloat(r['Executed'] || r['Amount'] || r['Quantity'] || 0);
      const price = parseFloat(r['Price'] || r['Avg Trading Price'] || 0);
      const total = parseFloat(r['Total'] || r['Executed Amount (Quote)'] || r['Turnover'] || 0)
                  || (price > 0 && qty > 0 ? price * qty : 0);
      const fee   = parseFloat(r['Fee'] || 0);
      const date  = r['Date(UTC)'] || r['Date'] || r['Time'] || '';
      // For BUY: spent `total` quoteAsset to receive `qty` base
      // For SELL: sold `qty` base, received `total` quoteAsset
      return normalizeTransaction({
        txHash: r['TxID'] || r['Order ID'] || r['OrderId'] || `bnb_${date}_${base}_${qty}`,
        date,
        type: side === 'BUY' ? 'buy' : side === 'SELL' ? 'sell' : 'trade',
        assetSymbol: base,
        amount: qty,
        inAsset: quoteAsset,
        inAmount: total,
        rawTradePrice: price,
        rawTradeCurrency: quoteAsset,
        feeSEK: fee,
        needsReview: true,
        notes: `Binance ${side} ${base} at ${price} ${quoteAsset}`,
      }, accountId, 'binance_csv');
    });
  }

  function parseKrakenCSV(text, accountId) {
    const rows = parseCSV(text);
    // Kraken exports two formats: Trade History and Ledger History
    // Trade History has: txid, ordertxid, pair, time, type, price, cost, fee, vol
    // Ledger History has: txid, refid, time, type, asset, amount, fee
    const isTradeHistory = rows.length > 0 && ('pair' in rows[0] || 'cost' in rows[0]);

    if (isTradeHistory) {
      return rows.map(r => {
        const side = (r['type'] || '').toLowerCase();
        const pair = (r['pair'] || '').toUpperCase();
        // Kraken pairs: XXBTZUSD, XETHZEUR, SOLUSD, ETHUSD etc.
        const quoteMatch = pair.match(/(USDT|USDC|ZUSD|ZEUR|USD|EUR|BTC|ETH|XBT)$/i);
        const rawQuote = quoteMatch ? quoteMatch[1].toUpperCase() : 'USD';
        const quoteAsset = rawQuote.replace(/^Z/, '').replace('XBT', 'BTC');
        // Base: strip leading X and trailing quote
        const base = pair.replace(/^X/, '').replace(new RegExp(quoteMatch?.[0] || '$'), '')
                        .replace(/^X/, '').replace('XBT', 'BTC') || 'UNKNOWN';
        const vol    = parseFloat(r['vol'] || 0);
        const price  = parseFloat(r['price'] || 0);
        const cost   = parseFloat(r['cost'] || 0) || (vol * price);
        const fee    = parseFloat(r['fee'] || 0);
        return normalizeTransaction({
          txHash: r['txid'] || r['ordertxid'] || `krk_${r['time']}_${base}_${vol}`,
          date: r['time'],
          type: side === 'buy' ? 'buy' : 'sell',
          assetSymbol: base,
          amount: vol,
          inAsset: quoteAsset,
          inAmount: cost,
          rawTradePrice: price,
          rawTradeCurrency: quoteAsset,
          feeSEK: fee,
          needsReview: true,
          notes: `Kraken ${side} ${base} at ${price} ${quoteAsset}`,
        }, accountId, 'kraken_csv');
      });
    }

    // Ledger format (one asset per row — can't determine pair directly)
    return rows.map(r => {
      const type  = (r['type'] || '').toLowerCase();
      const asset = (r['asset'] || '').replace(/^X(?=[A-Z]{2,4}$)/, '').replace(/^Z/, '')
                      .replace(/\.S$/, '').replace('XBT', 'BTC').toUpperCase();
      const amount = Math.abs(parseFloat(r['amount'] || r['vol'] || 0));
      return normalizeTransaction({
        txHash: r['txid'] || r['refid'] || `krk_${r['time']}_${asset}`,
        date: r['time'],
        type,
        assetSymbol: asset,
        amount,
        feeSEK: parseFloat(r['fee'] || 0),
        needsReview: true,
        notes: `Kraken ${type} ${asset}`,
      }, accountId, 'kraken_csv');
    });
  }

  function parseBybitCSV(text, accountId) {
    const rows = parseCSV(text);
    return rows.map(r => {
      const side = (r['Side'] || '').toUpperCase();
      const rawSymbol = r['Symbol'] || r['Coin'] || '';
      // Extract quote currency from symbol (e.g. BTCUSDT → USDT)
      const quoteMatch = rawSymbol.match(/(USDT|USDC|USD|BUSD|EUR|BTC|ETH)$/i);
      const quoteAsset = (quoteMatch ? quoteMatch[1] : 'USDT').toUpperCase();
      const sym = rawSymbol.replace(new RegExp(quoteAsset + '$', 'i'), '').toUpperCase()
               || (r['Coin'] || '').toUpperCase();
      const qty       = parseFloat(r['Qty'] || r['Quantity'] || r['Amount'] || 0);
      const execPrice = parseFloat(r['Avg Price'] || r['Order Price'] || r['Price'] || 0);
      // Exec Value = total quote amount of the trade
      const execValue = parseFloat(r['Exec Value'] || r['Order Amount (USDT)']
                       || r['Value (USDT)'] || r['Turnover'] || 0)
                     || (execPrice > 0 && qty > 0 ? execPrice * qty : 0);
      const fee = parseFloat(r['Trading Fee'] || r['Fee'] || 0);
      const date = r['Date'] || r['Time'] || r['Create Time'] || '';
      return normalizeTransaction({
        txHash: r['Order ID'] || r['Trade ID'] || `bybit_${date}_${sym}_${qty}`,
        date,
        type: side === 'BUY' ? 'buy' : 'sell',
        assetSymbol: sym,
        amount: qty,
        inAsset: quoteAsset,
        inAmount: execValue,
        rawTradePrice: execPrice,
        rawTradeCurrency: quoteAsset,
        feeSEK: fee,
        needsReview: true,
        notes: `Bybit ${side} ${sym} at ${execPrice} ${quoteAsset}`,
      }, accountId, 'bybit_csv');
    });
  }

  function parseCoinbaseCSV(text, accountId) {
    const rows = parseCSV(text);
    return rows.map(r => {
      const type = (r['Transaction Type'] || r['Type'] || '').toLowerCase();
      const asset = (r['Asset'] || r['Coin Type'] || '').toUpperCase();
      const qty = parseFloat(r['Quantity Transacted'] || r['Amount'] || 0);
      // Coinbase Advanced Trade CSV has Spot Price Currency + Spot Price at Transaction
      // Coinbase Simple CSV may have Total (USD) or Subtotal
      const quoteCurrency = (r['Spot Price Currency'] || r['Price / Share Currency'] || 'USD').toUpperCase();
      const spotPrice = parseFloat(r['Spot Price at Transaction'] || r['Price / Share'] || 0);
      // Subtotal is total trade value excluding fees
      const subtotal = parseFloat(r['Subtotal'] || r['Total (inclusive of fees and/or spread)']
                      || r['USD Total (inclusive of fees)'] || r['Total'] || 0)
                    || (spotPrice > 0 && qty > 0 ? spotPrice * qty : 0);
      const fee = parseFloat(r['Fees and/or Spread'] || r['Fee'] || r['Fees'] || 0);
      return normalizeTransaction({
        txHash: r['ID'] || r['Transaction ID'] || `cb_${r['Timestamp']}_${asset}_${qty}`,
        date: r['Timestamp'] || r['Date'],
        type,
        assetSymbol: asset,
        amount: qty,
        inAsset: STABLES.has(quoteCurrency) || quoteCurrency === 'USD' || quoteCurrency === 'EUR'
                   ? quoteCurrency : null,
        inAmount: subtotal,
        rawTradePrice: spotPrice,
        rawTradeCurrency: quoteCurrency,
        feeSEK: fee,
        needsReview: true,
        notes: `Coinbase ${type} ${asset} at ${spotPrice} ${quoteCurrency}`,
      }, accountId, 'coinbase_csv');
    });
  }

  function parseGenericCSV(text, accountId) {
    const rows = parseCSV(text);
    return rows.map(r => {
      const lc = Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase().replace(/[\s/]/g, '_'), v]));
      return normalizeTransaction({
        txHash: lc.txhash || lc.hash || lc.id || lc.order_id || `gen_${Date.now()}_${Math.random()}`,
        date: lc.date || lc.datetime || lc.timestamp || lc.time || '',
        type: lc.type || lc.category || lc.side || '',
        assetSymbol: (lc.asset || lc.symbol || lc.coin || lc.currency || '').toUpperCase(),
        amount: parseFloat(lc.amount || lc.quantity || lc.qty || 0),
        priceSEKPerUnit: parseFloat(lc.price_sek || lc.pricesek || lc.price || 0),
        costBasisSEK: parseFloat(lc.total_sek || lc.totalsek || lc.total || 0),
        feeSEK: parseFloat(lc.fee || lc.fee_sek || 0),
        needsReview: true,
        notes: 'Generic CSV import',
      }, accountId, 'generic_csv');
    });
  }

  // ── Revolut CSV parser ─────────────────────────────────────
  // ── Solscan CSV parser ────────────────────────────────────
  // Solscan offers several CSV export formats depending on which tab
  // is open. This parser handles the two most common:
  //
  // Format A — DeFi activity export (most useful for swap history):
  //   "Time","Signature","Category","Action","Token","Amount","Usd","Status"
  //
  // Format B — Token transfer export:
  //   "Block Time","Signature","From","To","Token","Amount","Status"
  //
  // Both formats produce TRADE transactions where an Action column
  // says "swap" or "buy"/"sell". Transfers produce RECEIVE/SEND.
  // Unknown rows are flagged needsReview for manual classification.
  function parseSolscanCSV(text, accountId) {
    const rows = parseCSV(text);
    const out  = [];

    for (const r of rows) {
      // Status check (skip failed/pending if present)
      const status = (r['Status'] || r['status'] || 'success').toUpperCase();
      if (status === 'FAIL' || status === 'ERROR' || status === 'FAILED') continue;

      const txHash = r['Signature'] || r['signature'] || r['TxHash'] || r['txhash'] || '';
      // Date: Solscan uses "2024-01-15 14:30:22" or ISO formats
      const rawDate = r['Time'] || r['Block Time'] || r['Timestamp'] || r['date'] || '';
      const date    = parseDate(rawDate);
      if (!date) continue;

      const token   = (r['Token'] || r['Symbol'] || r['Asset'] || '').trim().toUpperCase();
      const rawAmt  = parseFloat(r['Amount'] || r['amount'] || 0);
      const amount  = Math.abs(rawAmt);
      if (isNaN(amount) || amount === 0) continue;

      // Normalise token symbol (handle Solscan's occasional full mint addresses)
      const resolvedSym = looksLikeContractAddress(token)
        ? (mintToSym(token) || token.slice(0, 8))
        : normalizeAssetSymbol(token);

      // Classify by Action / Category
      const action   = (r['Action']   || r['action']   || '').toLowerCase();
      const category = (r['Category'] || r['category'] || '').toLowerCase();

      let txType = 'receive'; // default
      let txNotes = `Solscan: ${r['Action'] || category || 'transfer'}`;

      if (action.includes('swap') || action.includes('buy') || category.includes('swap')) {
        // Swap row — we get the single leg; mark as trade needing review
        txType = 'trade';
        txNotes = `Solscan swap (one leg) — pair opposite side not in this row`;
      } else if (action.includes('sell') && rawAmt < 0) {
        txType = 'sell';
      } else if (action.includes('sell') || rawAmt < 0) {
        txType = 'send';
      } else if (action.includes('receive') || action.includes('transfer in') || rawAmt > 0) {
        txType = 'receive';
      } else if (action.includes('send') || action.includes('transfer out')) {
        txType = 'send';
      } else if (action.includes('stake') || action.includes('deposit')) {
        txType = 'transfer_out';
      } else if (action.includes('unstake') || action.includes('withdraw')) {
        txType = 'transfer_in';
      }

      out.push(normalizeTransaction({
        txHash: txHash || ('solscan_' + date + '_' + resolvedSym),
        date,
        type: txType,
        assetSymbol: resolvedSym,
        amount,
        contractAddress: looksLikeContractAddress(token) ? token : null,
        feeSEK: 0,
        needsReview: txType === 'trade',
        reviewReason: txType === 'trade' ? 'solscan_swap_single_leg' : null,
        notes: txNotes,
      }, accountId, 'solscan_csv'));
    }

    return out;
  }

  // Revolut exports a CSV with columns:
  // Type, Product, Started Date, Completed Date, Description,
  // Amount, Currency, Fiat amount, Fiat amount (inc. fees), Fee, Base currency, State, Balance
  function parseRevolutCSV(text, accountId) {
    const rows = parseCSV(text);
    const out = [];
    for (const r of rows) {
      const state = (r['State'] || '').toUpperCase();
      if (state !== 'COMPLETED') continue; // skip pending/failed
      const type = (r['Type'] || '').toUpperCase();
      const sym = (r['Currency'] || '').toUpperCase();
      const amount = Math.abs(parseFloat(r['Amount'] || 0));
      if (!sym || amount === 0) continue;
      const date = r['Completed Date'] || r['Started Date'] || '';
      const fiat = Math.abs(parseFloat(r['Fiat amount (inc. fees)'] || r['Fiat amount'] || 0));
      const fee = Math.abs(parseFloat(r['Fee'] || 0));
      const baseCcy = (r['Base currency'] || '').toUpperCase();
      const fiatSEK = (baseCcy === 'SEK' || baseCcy === '') ? fiat : 0;
      const isStable = STABLES.has(sym);
      let txType = 'receive';
      if (type === 'EXCHANGE') txType = amount > 0 ? 'trade' : 'trade';
      else if (type === 'TRANSFER' && parseFloat(r['Amount'] || 0) < 0) txType = 'send';
      else if (type === 'TRANSFER') txType = 'receive';
      else if (type === 'CARD_PAYMENT' || type === 'PAYMENT') txType = 'sell';
      else if (type === 'TOPUP') txType = 'buy';
      out.push(normalizeTransaction({
        txHash: r['Reference'] || `rev_${date}_${sym}_${amount}`,
        date,
        type: txType,
        assetSymbol: sym,
        amount,
        costBasisSEK: fiatSEK > 0 ? fiatSEK : undefined,
        feeSEK: fee > 0 && baseCcy === 'SEK' ? fee : 0,
        needsReview: !fiatSEK,
        notes: `Revolut ${r['Type'] || ''} — ${r['Description'] || ''}`.trim(),
      }, accountId, 'revolut_csv'));
    }
    return out;
  }

  // ── MEXC CSV parser ────────────────────────────────────────
  // MEXC exports: Date, Pairs, Type, Price, Order Amount, Order Total, Trade Amount, Trade Total, Avg.Price, Status
  function parseMEXCCSV(text, accountId) {
    const rows = parseCSV(text);
    return rows.map(r => {
      const pair = (r['Pairs'] || r['Symbol'] || r['Market'] || '').toUpperCase();
      const side = (r['Type'] || r['Side'] || '').toUpperCase();
      const quoteMatch = pair.match(/(USDT|USDC|BUSD|BTC|ETH|BNB|EUR|USD)$/i);
      const quoteAsset = quoteMatch ? quoteMatch[1].toUpperCase() : 'USDT';
      const base = pair.replace(new RegExp(quoteAsset + '$', 'i'), '').toUpperCase() || 'UNKNOWN';
      const tradeAmt = parseFloat(r['Trade Amount'] || r['Order Amount'] || r['Amount'] || 0);
      const tradeTotal = parseFloat(r['Trade Total'] || r['Order Total'] || r['Total'] || 0);
      const price = parseFloat(r['Avg.Price'] || r['Price'] || 0) || (tradeAmt > 0 && tradeTotal > 0 ? tradeTotal / tradeAmt : 0);
      const fee = parseFloat(r['Fee'] || 0);
      const date = r['Date'] || r['Time'] || r['Timestamp'] || '';
      return normalizeTransaction({
        txHash: r['Order ID'] || r['Trade ID'] || `mexc_${date}_${base}_${tradeAmt}`,
        date,
        type: side.includes('BUY') ? 'buy' : side.includes('SELL') ? 'sell' : 'trade',
        assetSymbol: base,
        amount: tradeAmt,
        inAsset: quoteAsset,
        inAmount: tradeTotal,
        rawTradePrice: price,
        rawTradeCurrency: quoteAsset,
        feeSEK: fee,
        needsReview: true,
        notes: `MEXC ${side} ${base} at ${price} ${quoteAsset}`,
      }, accountId, 'mexc_csv');
    }).filter(t => t.amount > 0);
  }

  // ════════════════════════════════════════════════════════════
  // BLOCKCHAIN IMPORT — full history pagination
  // ════════════════════════════════════════════════════════════

  // Solana via Helius — paginates through ALL transactions
  // IMPORTANT: raw Helius JSON (5–20 KB/tx) is normalized and discarded per page.
  // Never accumulate allRaw — 8000 raw txns ≈ 100 MB in V8, which crashes Chrome.
  async function importSolanaWallet(address, accountId, onProgress) {
    const keys = (typeof ChainAPIs !== 'undefined' && ChainAPIs.getKeys) ? ChainAPIs.getKeys() : {};
    const heliusKey = keys.helius || '';
    if (!heliusKey) return { txns: [], error: 'No Helius API key configured. Add it in Admin → API Keys.', missingKey: true };

    let allTxns = [], totalFetched = 0, before = null, hasMore = true;
    setImportStatus(accountId, { status: 'syncing', source: 'solana', address });

    try {
      while (hasMore) {
        const qs = `api-key=${heliusKey}&limit=100${before ? `&before=${before}` : ''}`;
        const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?${qs}`;
        const r = await fetch(url);

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
        before = page[page.length - 1].signature;
        hasMore = page.length === 100;

        const filteredOut = totalFetched - allTxns.length;
        if (onProgress) onProgress({
          step: 'import',
          msg: `Fetched ${totalFetched} raw · ${allTxns.length} valid${filteredOut > 0 ? ` · ${filteredOut} failed/non-economic skipped` : ''}`,
        });
        await tick(); // yield to browser between pages
      }

      const start = allTxns.length ? allTxns.reduce((a, b) => a.date < b.date ? a : b).date : null;
      const end = allTxns.length ? allTxns.reduce((a, b) => a.date > b.date ? a : b).date : null;

      const filteredCount = totalFetched - allTxns.length;
      setImportStatus(accountId, {
        status: 'synced',
        totalFetched,
        totalTxns: allTxns.length,
        filteredFailed: filteredCount,
        startDate: start,
        endDate: end,
      });
      if (filteredCount > 0) {
        console.log(`[Solana] Filtered ${filteredCount} failed/non-economic transactions from ${address.slice(0,8)}…`);
      }
      return { txns: allTxns, totalFetched, filteredCount };
    } catch (e) {
      setImportStatus(accountId, { status: 'failed', error: e.message });
      return { txns: [], error: e.message };
    }
  }

  // ════════════════════════════════════════════════════════════
  // SOLANA SWAP RECONSTRUCTION
  //
  // Helius API returns raw Solana transactions with separate
  // nativeTransfers (SOL) and tokenTransfers arrays. A Jupiter/
  // Raydium/Orca swap may involve 5–20 token transfer legs from
  // routing hops and liquidity pools — none of which are the
  // user's wallet address. The key insight is to compute NET
  // flows for the wallet and collapse everything into ONE trade.
  //
  // Root causes of "fake profits" in prior version:
  //   1. SOL→Token buy: out=null (SOL in nativeTransfers, not
  //      tokenTransfers), so swap detection fails → only a
  //      transfer_out SOL is stored; token never enters inventory
  //   2. Token→SOL sell: inc=null, same failure → only a
  //      transfer_in SOL is stored; token disposal never fires
  //   3. Result: every SOL→token→SOL round-trip generates a
  //      phantom SOL "income" and the token gain/loss = 0 for the
  //      token (since it has no history) while any later SOL sale
  //      gets full proceeds treated as gain
  // ════════════════════════════════════════════════════════════

  // Rough SOL→SEK rate used only for transaction fee estimation at
  // import time (the pricing pipeline will use real historical prices).
  const SOL_FEE_PRICE_SEK = 2000; // ≈ $200 USD × 10 SEK/USD

  // ════════════════════════════════════════════════════════════
  // NET-DELTA RECONSTRUCTION HELPERS
  // ════════════════════════════════════════════════════════════

  // Wrapped SOL mint (economically identical to SOL)
  const WSOL_MINT = 'So11111111111111111111111111111111111111112';

  // Dust thresholds — below these are rounding noise / spam
  const SOL_DUST_LAMPORTS = 1_000;          // 0.000001 SOL
  const TOKEN_DUST        = 1e-9;           // essentially zero

  // DEX names from Helius tx.source field
  const HELIUS_DEX_MAP = {
    JUPITER: 'Jupiter', JUPITER_DCA: 'Jupiter DCA',
    JUPITER_LIMIT_ORDER: 'Jupiter', RAYDIUM: 'Raydium',
    RAYDIUM_CLMM: 'Raydium', ORCA: 'Orca', WHIRLPOOL: 'Orca',
    PUMP_FUN: 'Pump.fun', METEORA: 'Meteora', LIFINITY: 'Lifinity',
    PHOENIX: 'Phoenix', OPENBOOK: 'OpenBook', DRIFT: 'Drift',
  };

  // ── buildOwnedAccounts ───────────────────────────────────────
  // Returns a Set of account addresses that belong to the user:
  //   • the wallet itself
  //   • every ATA (associated token account) whose userAccount === wallet
  //     (found in accountData[].tokenBalanceChanges and tokenTransfers)
  function buildOwnedAccounts(tx, walletAddr) {
    const owned = new Set([walletAddr]);
    // accountData path (Helius enhanced)
    for (const ad of (tx.accountData || [])) {
      for (const tc of (ad.tokenBalanceChanges || [])) {
        if (tc.userAccount === walletAddr) owned.add(ad.account);
      }
    }
    // tokenTransfers path (belt-and-suspenders)
    for (const tt of (tx.tokenTransfers || [])) {
      if (tt.fromUserAccount === walletAddr && tt.fromTokenAccount)
        owned.add(tt.fromTokenAccount);
      if (tt.toUserAccount === walletAddr && tt.toTokenAccount)
        owned.add(tt.toTokenAccount);
    }
    return owned;
  }

  // ── computeNetDeltas ────────────────────────────────────────
  // Returns:
  //   economicSolLamports  – net SOL from intentional trade (fee removed)
  //   tokenNet             – { mint: humanReadableDelta } (WSOL already removed)
  //   feeLamports          – tx network fee in lamports
  //   dex                  – detected DEX name or null
  //   usedAccountData      – whether the accountData path was used
  //   collapsedInfo        – debug info for UI panel
  function computeNetDeltas(tx, walletAddr, ownedAccounts) {
    const feeLamports   = tx.fee || 0;
    const accountData   = tx.accountData || [];
    const dex           = HELIUS_DEX_MAP[tx.source] || null;
    const collapsedInfo = { ignoredMints: [], wsolCollapsed: false, usedAccountData: accountData.length > 0 };

    let rawSolLamports = 0;
    const tokenNet     = {}; // mint → human-readable delta

    if (accountData.length > 0) {
      // ── Primary path: Helius accountData ─────────────────────
      // nativeBalanceChange is the net SOL change PER account (includes fee
      // for the fee-payer account). tokenBalanceChanges is the net token delta.
      for (const ad of accountData) {
        if (!ownedAccounts.has(ad.account)) continue;
        rawSolLamports += (ad.nativeBalanceChange || 0);
        for (const tc of (ad.tokenBalanceChanges || [])) {
          const mint    = tc.mint;
          const dec     = tc.rawTokenAmount?.decimals ?? 0;
          const rawStr  = tc.rawTokenAmount?.tokenAmount || '0';
          const delta   = Number(rawStr) / Math.pow(10, dec || 1);
          tokenNet[mint] = (tokenNet[mint] || 0) + delta;
        }
      }
      // rawSolLamports already includes fee deduction (fee payer's balance changed)
      // economicSolLamports = what the user intentionally sent/received
    } else {
      // ── Fallback path: nativeTransfers + tokenTransfers ──────
      // nativeTransfers does NOT include fee, so we subtract it here
      // to make both paths consistent.
      for (const n of (tx.nativeTransfers || [])) {
        if (n.fromUserAccount === walletAddr) rawSolLamports -= (n.amount || 0);
        if (n.toUserAccount   === walletAddr) rawSolLamports += (n.amount || 0);
      }
      rawSolLamports -= feeLamports; // simulate fee deduction so formula is identical
      for (const t of (tx.tokenTransfers || [])) {
        const mint = t.mint;
        if (!mint) continue;
        // tokenAmount is already human-readable in the Helius enhanced format
        if (t.fromUserAccount === walletAddr) tokenNet[mint] = (tokenNet[mint] || 0) - (t.tokenAmount || 0);
        if (t.toUserAccount   === walletAddr) tokenNet[mint] = (tokenNet[mint] || 0) + (t.tokenAmount || 0);
      }
    }

    // Economic SOL = rawSol + fee (add back to exclude fee from trade amount)
    const economicSolLamports = rawSolLamports + feeLamports;

    // ── Normalize WSOL → SOL ─────────────────────────────────
    // WSOL is Wrapped SOL — economically identical. Its SOL value is already
    // captured in nativeBalanceChange (accountData path) or via nativeTransfers.
    // Remove from tokenNet to prevent fake "buy WSOL" / "sell WSOL" entries.
    if (WSOL_MINT in tokenNet) {
      collapsedInfo.wsolCollapsed = true;
      // In the fallback path, WSOL tokenAmount is in SOL (human-readable).
      // If the nativeTransfers did NOT capture this flow (edge case: wallet's
      // WSOL ATA is NOT the walletAddr itself), fold it into economicSolLamports.
      // In accountData path this is already handled via nativeBalanceChange.
      delete tokenNet[WSOL_MINT];
    }

    // ── Remove true dust ─────────────────────────────────────
    for (const mint of Object.keys(tokenNet)) {
      if (Math.abs(tokenNet[mint]) < TOKEN_DUST) delete tokenNet[mint];
    }

    return { economicSolLamports, tokenNet, feeLamports, dex, collapsedInfo };
  }

  // ── normalizeSolanaTx ────────────────────────────────────────
  // Converts a single Helius Enhanced Transaction into 0 or 1 canonical
  // economic events (TRADE / SEND / RECEIVE / null) by:
  //   1. Skipping failures and non-economic system instructions
  //   2. Building user-owned account set (wallet + all ATAs)
  //   3. Computing net SOL + token deltas across ALL owned accounts
  //   4. Normalizing WSOL → SOL
  //   5. Classifying the resulting net shape into one event
  //
  // This prevents routing hops, LP vault movements, and WSOL wraps from
  // being treated as separate trades.
  function normalizeSolanaTx(tx, walletAddr, accountId) {
    try {
      // ── Guard 1: Skip failed transactions ───────────────────
      if (tx.transactionError !== null && tx.transactionError !== undefined) return null;

      // ── Guard 2: Skip pure system / non-economic types ──────
      const SKIP_TYPES = new Set([
        'ACCOUNT_DATA', 'CREATE_ACCOUNT', 'CLOSE_ACCOUNT',
        'ACCOUNT_CREATION', 'FREEZE_ACCOUNT', 'THAW_ACCOUNT',
        'APPROVE', 'REVOKE', 'SET_AUTHORITY', 'INIT_MINT', 'MINT_TO',
      ]);
      if (SKIP_TYPES.has(tx.type)) return null;

      const ts  = new Date((tx.timestamp || 0) * 1000).toISOString();
      const sig = tx.signature;

      // ── Step 1–4: Reconstruct net deltas ────────────────────
      const ownedAccounts = buildOwnedAccounts(tx, walletAddr);
      const { economicSolLamports, tokenNet, feeLamports, dex, collapsedInfo } =
        computeNetDeltas(tx, walletAddr, ownedAccounts);

      const economicSol = economicSolLamports / 1e9;
      const feeSol      = feeLamports / 1e9;
      const feeSEK      = feeSol * SOL_FEE_PRICE_SEK;

      // ── Guard 3: Sanity-cap on net SOL flow ─────────────────
      const MAX_REALISTIC_SOL = 10_000;
      if (Math.abs(economicSol) > MAX_REALISTIC_SOL) {
        console.warn(`[SolTx] Implausible economicSol=${economicSol.toFixed(2)} in ${sig?.slice(0,12)}… — flagging`);
        return normalizeTransaction({
          txHash: sig, date: ts, category: CAT.TRANSFER_OUT,
          assetSymbol: 'SOL', amount: Math.abs(economicSol), feeSEK,
          needsReview: true, reviewReason: 'outlier',
          notes: `Implausible net SOL flow (${economicSol.toFixed(2)} SOL). LP routing artefact — verify manually.`,
        }, accountId, 'solana_wallet');
      }

      // ── Step 5: Build clean in/out lists ────────────────────
      const msym    = mint => mintToSym(mint) || mint?.slice(0, 8) || 'UNKNOWN';
      const biggest = list => list.reduce((a, b) => Math.abs(a[1]) >= Math.abs(b[1]) ? a : b);

      const tokenIn  = Object.entries(tokenNet).filter(([, v]) => v >  TOKEN_DUST);
      const tokenOut = Object.entries(tokenNet).filter(([, v]) => v < -TOKEN_DUST);

      const hasSolIn  = economicSol >  SOL_DUST_LAMPORTS / 1e9;
      const hasSolOut = economicSol < -SOL_DUST_LAMPORTS / 1e9;

      // How many route hops were collapsed (extra in/outs beyond the dominant pair)
      const extraLegs = Math.max(0, tokenIn.length + tokenOut.length - 2);
      const dexLabel  = dex ? `DEX: ${dex}` : null;
      const mkNotes   = desc => [desc, dexLabel, extraLegs > 0 ? `${extraLegs} route hop(s) collapsed` : null]
        .filter(Boolean).join(' | ');
      // Reconstruction metadata stored for the "How we reconstructed" UI panel
      const recon = {
        dex,
        ownedAccountCount : ownedAccounts.size,
        wsolCollapsed     : collapsedInfo.wsolCollapsed,
        routeHopsIgnored  : extraLegs,
        usedAccountData   : collapsedInfo.usedAccountData,
        economicSol,
        tokenNet          : Object.fromEntries(
          Object.entries(tokenNet).map(([m, v]) => [msym(m), +v.toFixed(9)])
        ),
      };

      // ── Step 6: Classify event shape ────────────────────────

      // Case A: SOL out + token(s) in → BUY / SOL→Token swap
      if (hasSolOut && tokenIn.length >= 1 && tokenOut.length === 0) {
        const [inMint, inAmt] = biggest(tokenIn);
        const inSym = msym(inMint);
        const solSpent = Math.abs(economicSol);
        return normalizeTransaction({
          txHash: sig, date: ts, category: CAT.TRADE,
          assetSymbol: 'SOL',  amount: solSpent,
          inAsset: inSym,      inAmount: Math.abs(inAmt),
          feeSEK, contractAddress: inMint, needsReview: false,
          notes: mkNotes(`DEX buy: ${solSpent.toFixed(6)} SOL → ${Math.abs(inAmt).toLocaleString()} ${inSym}`),
          solanaSwapType: 'sol_to_token', _reconstruction: recon,
        }, accountId, 'solana_wallet');
      }

      // Case B: token(s) out + SOL in → SELL / Token→SOL swap
      if (hasSolIn && tokenOut.length >= 1 && tokenIn.length === 0) {
        const [outMint, outAmt] = biggest(tokenOut);
        const outSym = msym(outMint);
        const solReceived = Math.abs(economicSol);
        return normalizeTransaction({
          txHash: sig, date: ts, category: CAT.TRADE,
          assetSymbol: outSym,  amount: Math.abs(outAmt),
          inAsset: 'SOL',       inAmount: solReceived,
          feeSEK, contractAddress: outMint, needsReview: false,
          notes: mkNotes(`DEX sell: ${Math.abs(outAmt).toLocaleString()} ${outSym} → ${solReceived.toFixed(6)} SOL`),
          solanaSwapType: 'token_to_sol', _reconstruction: recon,
        }, accountId, 'solana_wallet');
      }

      // Case C: token(s) out + token(s) in, no significant SOL change → Token→Token swap
      // Also covers the common case where a tiny SOL refund (< 0.01) accompanies a token swap
      if (tokenOut.length >= 1 && tokenIn.length >= 1 &&
          !hasSolOut && Math.abs(economicSol) < 0.01) {
        const [outMint, outAmt] = biggest(tokenOut);
        const [inMint,  inAmt]  = biggest(tokenIn);
        const outSym = msym(outMint);
        const inSym  = msym(inMint);
        return normalizeTransaction({
          txHash: sig, date: ts, category: CAT.TRADE,
          assetSymbol: outSym,  amount: Math.abs(outAmt),
          inAsset: inSym,       inAmount: Math.abs(inAmt),
          feeSEK, contractAddress: outMint, needsReview: false,
          notes: mkNotes(`DEX swap: ${outSym} → ${inSym}`),
          solanaSwapType: 'token_to_token', _reconstruction: recon,
        }, accountId, 'solana_wallet');
      }

      // Case D: SOL out + token out + token in → complex (LP deposit, multi-asset)
      if (hasSolOut && tokenIn.length >= 1 && tokenOut.length >= 1) {
        const [inMint,  inAmt]  = biggest(tokenIn);
        const inSym = msym(inMint);
        return normalizeTransaction({
          txHash: sig, date: ts, category: CAT.TRADE,
          assetSymbol: 'SOL',  amount: Math.abs(economicSol),
          inAsset: inSym,      inAmount: Math.abs(inAmt),
          feeSEK, contractAddress: inMint, needsReview: true,
          reviewReason: 'unresolved_solana_swap',
          notes: mkNotes('Complex DEX/LP interaction — verify (LP deposit or multi-hop)'),
          _reconstruction: recon,
        }, accountId, 'solana_wallet');
      }

      // Case E: SOL in + token in + token out → complex (LP withdrawal, multi-asset)
      if (hasSolIn && tokenOut.length >= 1 && tokenIn.length >= 1) {
        const [outMint, outAmt] = biggest(tokenOut);
        const outSym = msym(outMint);
        return normalizeTransaction({
          txHash: sig, date: ts, category: CAT.TRADE,
          assetSymbol: outSym,  amount: Math.abs(outAmt),
          inAsset: 'SOL',       inAmount: Math.abs(economicSol),
          feeSEK, contractAddress: outMint, needsReview: true,
          reviewReason: 'unresolved_solana_swap',
          notes: mkNotes('Complex DEX/LP interaction — verify (LP withdrawal or multi-hop)'),
          _reconstruction: recon,
        }, accountId, 'solana_wallet');
      }

      // Case F: Only SOL moved (pure SOL transfer)
      if (Math.abs(economicSol) > SOL_DUST_LAMPORTS / 1e9 &&
          tokenIn.length === 0 && tokenOut.length === 0) {
        const isOut = economicSol < 0;
        return normalizeTransaction({
          txHash: sig, date: ts,
          category: isOut ? CAT.SEND : CAT.RECEIVE,
          assetSymbol: 'SOL', amount: Math.abs(economicSol),
          feeSEK, needsReview: false,
          notes: `SOL ${isOut ? 'sent' : 'received'}`,
          _reconstruction: recon,
        }, accountId, 'solana_wallet');
      }

      // Case G: Pure token receive (airdrop / bridge in / unmatched leg)
      if (tokenIn.length > 0 && tokenOut.length === 0 && !hasSolOut) {
        const [inMint, inAmt] = biggest(tokenIn);
        const inSym = msym(inMint);
        return normalizeTransaction({
          txHash: sig, date: ts, category: CAT.RECEIVE,
          assetSymbol: inSym, amount: Math.abs(inAmt),
          feeSEK, contractAddress: inMint,
          needsReview: true, reviewReason: 'unmatched_solana_receive',
          notes: 'Token received — verify source (airdrop, bridge, or transfer)',
          _reconstruction: recon,
        }, accountId, 'solana_wallet');
      }

      // Case H: Pure token send (bridge out / unmatched leg)
      if (tokenOut.length > 0 && tokenIn.length === 0 && !hasSolIn) {
        const [outMint, outAmt] = biggest(tokenOut);
        const outSym = msym(outMint);
        return normalizeTransaction({
          txHash: sig, date: ts, category: CAT.SEND,
          assetSymbol: outSym, amount: Math.abs(outAmt),
          feeSEK, contractAddress: outMint,
          needsReview: true, reviewReason: 'unmatched_solana_send',
          notes: 'Token sent — verify destination (transfer or bridge)',
          _reconstruction: recon,
        }, accountId, 'solana_wallet');
      }

      // Pure fee / no-op (only lamports moved for fee, nothing else)
      return null;

    } catch (e) {
      console.warn('[SolTx] normalization error:', e.message, tx?.signature);
      return null;
    }
  }

  // ════════════════════════════════════════════════════════════
  // SOLANA SWAP POST-PROCESSOR
  //
  // For previously-imported Solana transactions that were split
  // into separate transfer_in/transfer_out rows (the old bug),
  // this function groups by txHash, finds matching pairs on the
  // same account, and merges them into a single TRADE.
  //
  // Call via:  TaxEngine.reprocessSolanaSwaps(accountId)
  // The caller receives {toDelete:[], toAdd:[]} and should then
  // call addTransactions(toAdd) + delete toDelete ids.
  // ════════════════════════════════════════════════════════════
  function reprocessSolanaSwaps(accountId) {
    const allTxns = getTransactions();
    const solanaTxns = allTxns.filter(t =>
      t.source === 'solana_wallet' &&
      (accountId ? t.accountId === accountId : true)
    );

    // Group by txHash (only hashes with >1 transaction — those are the split ones)
    const byHash = {};
    for (const t of solanaTxns) {
      if (!t.txHash) continue;
      if (!byHash[t.txHash]) byHash[t.txHash] = [];
      byHash[t.txHash].push(t);
    }

    const toDelete = [];
    const toAdd    = [];
    let merged = 0;

    for (const [, txns] of Object.entries(byHash)) {
      if (txns.length < 2) continue;

      // We're looking for: one "out" tx and one "in" tx from same hash
      // This pattern = old broken swap reconstruction
      const outs = txns.filter(t => [CAT.SEND, CAT.TRANSFER_OUT].includes(t.category));
      const ins  = txns.filter(t => [CAT.RECEIVE, CAT.TRANSFER_IN].includes(t.category));

      if (outs.length === 0 || ins.length === 0) continue;

      // Pick primary out and primary in by amount (largest)
      const outTx = outs.reduce((a, b) => (a.amount || 0) >= (b.amount || 0) ? a : b);
      const inTx  = ins.reduce((a, b) => (a.amount || 0) >= (b.amount || 0) ? a : b);

      // Skip if same asset — this is probably a self-transfer, not a swap
      if (outTx.assetSymbol === inTx.assetSymbol) continue;

      const tradeTx = normalizeTransaction({
        id: outTx.id,  // keep original id for dedup key
        txHash: outTx.txHash,
        date: outTx.date,
        category: CAT.TRADE,
        assetSymbol: outTx.assetSymbol,
        amount: outTx.amount,
        inAsset: inTx.assetSymbol,
        inAmount: inTx.amount,
        feeSEK: (outTx.feeSEK || 0) + (inTx.feeSEK || 0),
        priceSEKPerUnit: outTx.priceSEKPerUnit || 0,
        costBasisSEK: outTx.costBasisSEK || 0,
        contractAddress: outTx.contractAddress || inTx.contractAddress,
        needsReview: false,
        notes: `Reconstructed swap: ${outTx.assetSymbol} → ${inTx.assetSymbol} (was split)`,
        solanaSwapType: outTx.assetSymbol === 'SOL' ? 'sol_to_token'
                      : inTx.assetSymbol  === 'SOL' ? 'token_to_sol'
                      : 'token_to_token',
      }, outTx.accountId, outTx.source);

      // Mark ALL txns with this hash for deletion (including any extra legs)
      txns.forEach(t => toDelete.push(t.id));
      toAdd.push(tradeTx);
      merged++;
    }

    console.log(`[SolanaReprocess] Merged ${merged} split swap pairs into TRADE transactions`);
    return { toDelete, toAdd, merged };
  }

  // Full mint address → symbol (Solana)
  const KNOWN_MINTS = {
    // Native SOL
    'So11111111111111111111111111111111111111112': 'SOL',
    // Stablecoins
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',  // fixed: was 'u'
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
    'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX': 'USDH',
    // Major DeFi / ecosystem
    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 'JUP',
    '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': 'RAY',
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': 'MSOL',
    'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE': 'ORCA',
    'SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt': 'SRM',
    'MangoCzJ36AjZyKwVj3VnYU4GTonjfVEnJmvvWaxLac': 'MNGO',
    'StepAscQoEioFxxWGnh2sLBDFp9d8rvKz2Xjdsc8bnF': 'STEP',
    'Saber2gLauYim4Mvftnrasomsv6NvAunSsNgQIkmjnK': 'SBR',
    'SHDWyBxihqiCj6YekG2GUr7wqKLeLAMK1gHZck9pL6y': 'SHDW',
    // Meme coins
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': 'WIF',
    'MEFNBXixkEbait3xn9bkm8WsJzXtVsaJEn4c8Sam21Y': 'MEME',
    'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82': 'BOME',
    '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU': 'SAMO',
    // Oracles / infra
    'HZ1JovNiVvGqWz8f9P7pVMKgBfQ5bHUi7t5RhHCRWRJo': 'PYTH',
    'DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7': 'DRIFT',
    'TNSRxcUxoT9xBG3de7NiJo5YBkNzMzMgaEgVgUt5PV': 'TNSR',
    'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk': 'WEN',
    // Gaming / metaverse
    'ATLASXmbPQxBUYbxPsV97usA3fPQYEqzQBUHgiFCUsXx': 'ATLAS',
    'poLisWXnNRwC6oBu1vHiuKQzFjGL4XDSu4g9qjz9qVk': 'POLIS',
    // Bridged assets
    '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 'WETH',
    '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E': 'WBTC',
    // Helium
    'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux': 'HNT',
    'mb1eu7TzEc71KxDpsmsKoucSSuuoGLv1drys1oP2jh6': 'MOBILE',
    'iotEVVZLEywoTn1QdwNPddxPWszn3zFhEot3MfL9fns': 'IOT',
  };

  // Human-readable full names for known symbols
  const TOKEN_DISPLAY_NAMES = {
    SOL: 'Solana', ETH: 'Ethereum', BTC: 'Bitcoin', BNB: 'BNB',
    USDC: 'USD Coin', USDT: 'Tether USD', USDH: 'USDH', DAI: 'Dai', BUSD: 'Binance USD',
    JUP: 'Jupiter', RAY: 'Raydium', MSOL: 'Marinade SOL', ORCA: 'Orca',
    SRM: 'Serum', MNGO: 'Mango', STEP: 'Step Finance', SBR: 'Saber', SHDW: 'Shadow Token',
    BONK: 'Bonk', WIF: 'dogwifhat', MEME: 'Memecoin', BOME: 'Book of Meme', SAMO: 'Samoyed Coin',
    PYTH: 'Pyth Network', DRIFT: 'Drift Protocol', TNSR: 'Tensor', WEN: 'Wen',
    ATLAS: 'Star Atlas', POLIS: 'Star Atlas POLIS',
    WETH: 'Wrapped ETH', WBTC: 'Wrapped BTC', WSOL: 'Wrapped SOL',
    HNT: 'Helium', MOBILE: 'Helium Mobile', IOT: 'Helium IOT',
    LINK: 'Chainlink', UNI: 'Uniswap', AAVE: 'Aave', COMP: 'Compound',
    AVAX: 'Avalanche', MATIC: 'Polygon', DOT: 'Polkadot', ADA: 'Cardano',
    DOGE: 'Dogecoin', SHIB: 'Shiba Inu', PEPE: 'Pepe',
    OP: 'Optimism', ARB: 'Arbitrum', INJ: 'Injective', APT: 'Aptos', SUI: 'Sui',
    SEI: 'Sei', TIA: 'Celestia', ATOM: 'Cosmos', NEAR: 'NEAR Protocol',
    XRP: 'XRP', LTC: 'Litecoin', TON: 'Toncoin',
    JTO: 'Jito', ZEUS: 'Zeus Network', BNSOL: 'Binance Staked SOL',
    DSYNC: 'Destra Network', PEPECOIN: 'PepeCoin', MON: 'Monad',
  };

  // Reverse lookup: first 8 chars of mint (uppercase) → symbol.
  // Built automatically from KNOWN_MINTS so it's always in sync.
  const MINT_PREFIX_TO_SYM = Object.fromEntries(
    Object.entries(KNOWN_MINTS).map(([mint, sym]) => [mint.slice(0, 8).toUpperCase(), sym])
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
    const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    let cache = {};
    try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { }
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
        const r = await fetchWithTimeout(url, 8000);
        if (!r || !r.ok) continue;
        const data = await r.json();
        // Find best match: prefer pair whose baseToken symbol exactly matches
        const pair = (data.pairs || []).find(
          p => p.baseToken?.symbol?.toUpperCase() === sym.toUpperCase()
        );
        if (pair?.baseToken?.name) {
          cache[sym.toUpperCase()] = {
            symbol: pair.baseToken.symbol,
            name: pair.baseToken.name,
            _ts: now,
          };
        }
      } catch { /* ignore individual lookup failures */ }
    }
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { }
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
  // chainId: 1=Ethereum, 137=Polygon, 8453=Base, 42161=Arbitrum → Etherscan V2
  //          56=BNB Chain → BSCScan API
  //          43114=Avalanche → Snowtrace (Routescan) API
  async function importEthWallet(address, accountId, onProgress, chainId = 1) {
    const isBSC     = chainId === 56;
    const isAVAX    = chainId === 43114;
    const isEVM     = !isBSC && !isAVAX; // Etherscan V2 covers eth, polygon, base, arbitrum

    const CHAIN_NATIVE = { 1: 'ETH', 137: 'MATIC', 8453: 'ETH', 42161: 'ETH', 56: 'BNB', 43114: 'AVAX' };
    const nativeSym = CHAIN_NATIVE[chainId] || 'ETH';
    const chainSource = isBSC ? 'bsc_wallet' : isAVAX ? 'avax_wallet' : 'eth_wallet';

    // Priority: ChainAPIs (Supabase) → config.js/keys.js (TCMD_KEYS)
    const keys = (typeof ChainAPIs !== 'undefined' && ChainAPIs.getKeys) ? ChainAPIs.getKeys() : {};
    const etherscanKey = isEVM
      ? (keys.etherscan   || (typeof window !== 'undefined' && window.TCMD_KEYS?.etherscan) || '')
      : isBSC
        ? (keys.bscscan   || (typeof window !== 'undefined' && window.TCMD_KEYS?.bscscan)   || '')
        : (keys.snowtrace || (typeof window !== 'undefined' && window.TCMD_KEYS?.snowtrace) || '');
    if (!etherscanKey) {
      const keyName = isBSC ? 'BSCScan' : isAVAX ? 'Snowtrace' : 'Etherscan';
      return {
        txns: [], error: `No ${keyName} API key configured. Add it in the Admin panel → API Keys.`,
        missingKey: true,
      };
    }

    const addrLow = address.toLowerCase();
    const chainLabel = isBSC ? 'bsc' : isAVAX ? 'avalanche' : `ethereum (chainId ${chainId})`;
    setImportStatus(accountId, { status: 'syncing', source: chainLabel, address });

    try {
      // Live native-asset price in SEK for accurate fee calculation
      const NATIVE_FALLBACK_SEK = { ETH: 28000, MATIC: 5, BNB: 3700, AVAX: 280 };
      let nativeSEK = NATIVE_FALLBACK_SEK[nativeSym] || 10000;
      try {
        const [sekRate, priceMap] = await Promise.all([
          fetchLiveSEKRate(),
          fetchLivePrices([nativeSym]),
        ]);
        const nativeUSD = priceMap.get(nativeSym)?.priceUsd || 0;
        if (sekRate && nativeUSD > 0) nativeSEK = nativeUSD * sekRate;
      } catch { /* use fallback */ }
      const ethSEK = nativeSEK; // alias kept for compatibility with code below

      // ── Etherscan paginator ──────────────────────────────────
      // Free tier: 3 req/s hard limit. We run txlist then tokentx
      // sequentially (never concurrent) and sleep 400ms between pages.
      // Rate-limit responses (status!='1', message contains "rate") are
      // retried once after a 1.2s back-off before throwing.
      // Build chain-specific URL
      function makeApiUrl(action, page) {
        if (isBSC) {
          return `https://api.bscscan.com/api?module=account&action=${action}` +
            `&address=${addrLow}&sort=asc&page=${page}&offset=100&apikey=${etherscanKey}`;
        }
        if (isAVAX) {
          // Routescan (Snowtrace) uses the same format as Etherscan
          return `https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api?module=account&action=${action}` +
            `&address=${addrLow}&sort=asc&page=${page}&offset=100&apikey=${etherscanKey}`;
        }
        // Etherscan V2 — supports all EVM chains via ?chainid=N
        return `https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=${action}` +
          `&address=${addrLow}&sort=asc&page=${page}&offset=100&apikey=${etherscanKey}`;
      }

      async function paginate(action, label) {
        const rows = [];
        let page = 1, hasMore = true;
        while (hasMore) {
          const url = makeApiUrl(action, page);

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
          if (onProgress) onProgress({ step: 'import', msg: `Fetching ${label}… ${rows.length} found` });
          if (hasMore) await sleep(400); // stay safely under 3 req/s
        }
        return rows;
      }

      // Run sequentially — never fire two Etherscan requests simultaneously
      if (onProgress) onProgress({ step: 'import', msg: 'Fetching ETH transactions…' });
      const nativeTxs = await paginate('txlist', 'ETH transactions').catch(e => {
        if (e?.message?.startsWith('Etherscan')) throw e;
        return [];
      });
      await sleep(450); // gap between the two endpoint types
      if (onProgress) onProgress({ step: 'import', msg: 'Fetching token transfers…' });
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
        if (!tokenGroups[tx.hash]) tokenGroups[tx.hash] = { ins: [], outs: [] };
        if (tx.to?.toLowerCase() === addrLow) tokenGroups[tx.hash].ins.push(tx);
        else if (tx.from?.toLowerCase() === addrLow) tokenGroups[tx.hash].outs.push(tx);
      }

      const txns = [];
      const seenHashes = new Set();

      // ── Process grouped token transfers ─────────────────────
      for (const [hash, { ins, outs }] of Object.entries(tokenGroups)) {
        seenHashes.add(hash);
        const native = nativeMap[hash];
        const gasSEK = native
          ? (parseInt(native.gasUsed || 0) * parseInt(native.gasPrice || 0) / 1e18) * ethSEK
          : 0;
        const ts = ins[0]?.timeStamp || outs[0]?.timeStamp || '0';
        const date = new Date(parseInt(ts) * 1000).toISOString();

        const parseAmt = tx => parseFloat(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal) || 18);

        if (ins.length > 0 && outs.length > 0) {
          // ── DEX Swap: token-out → token-in ───────────────────
          // Multiple outs/ins (e.g. multi-hop): collapse to totals
          const outSym = outs[0].tokenSymbol?.toUpperCase();
          const outAmt = outs.reduce((s, t) => s + parseAmt(t), 0);
          const inSym = ins[ins.length - 1].tokenSymbol?.toUpperCase(); // last in = final token
          const inAmt = ins.reduce((s, t) => s + parseAmt(t), 0);
          txns.push(normalizeTransaction({
            txHash: hash, date, type: 'swap',
            assetSymbol: outSym, assetName: outs[0].tokenName,
            amount: outAmt,
            inAsset: inSym, inAmount: inAmt,
            feeSEK: gasSEK,
            needsReview: false,
          }, accountId, chainSource));

        } else if (ins.length > 0) {
          // ── Token received ────────────────────────────────────
          // If the same tx also sent native coin out → it was a buy (native→token)
          const nativeEthOut = native?.from?.toLowerCase() === addrLow
            && parseInt(native.value || 0) > 0;
          const inTx = ins[0];
          txns.push(normalizeTransaction({
            txHash: hash, date,
            type: nativeEthOut ? 'buy' : 'receive',
            assetSymbol: inTx.tokenSymbol?.toUpperCase(),
            assetName: inTx.tokenName,
            amount: ins.reduce((s, t) => s + parseAmt(t), 0),
            feeSEK: gasSEK,
            needsReview: !nativeEthOut,
          }, accountId, chainSource));

        } else if (outs.length > 0) {
          // ── Token sent ────────────────────────────────────────
          // If same tx received native coin in → it was a sell (token→native)
          const nativeEthIn = native?.to?.toLowerCase() === addrLow
            && parseInt(native.value || 0) > 0;
          const outTx = outs[0];
          txns.push(normalizeTransaction({
            txHash: hash, date,
            type: nativeEthIn ? 'sell' : 'send',
            assetSymbol: outTx.tokenSymbol?.toUpperCase(),
            assetName: outTx.tokenName,
            amount: outs.reduce((s, t) => s + parseAmt(t), 0),
            feeSEK: gasSEK,
            needsReview: !nativeEthIn,
          }, accountId, chainSource));
        }
      }

      // ── Native ETH-only transactions ─────────────────────────
      // (not already covered by token transfer grouping above)
      for (const tx of nativeTxs) {
        if (tx.isError === '1') continue;
        if (seenHashes.has(tx.hash)) continue; // already processed as a token group
        if (parseInt(tx.value || 0) === 0) continue; // contract calls with no ETH value (approvals etc.)

        const isIn = tx.to?.toLowerCase() === addrLow;
        const gasSEK = isIn ? 0  // receiver doesn't pay gas
          : (parseInt(tx.gasUsed || 0) * parseInt(tx.gasPrice || 0) / 1e18) * ethSEK;
        const date = new Date(parseInt(tx.timeStamp) * 1000).toISOString();
        const CHAIN_NAMES = { ETH: 'Ethereum', MATIC: 'Polygon (MATIC)', BNB: 'BNB Chain', AVAX: 'Avalanche' };
        txns.push(normalizeTransaction({
          txHash: tx.hash, date,
          type: isIn ? 'receive' : 'send',
          assetSymbol: nativeSym,
          assetName: CHAIN_NAMES[nativeSym] || nativeSym,
          amount: parseInt(tx.value) / 1e18,
          feeSEK: gasSEK,
          needsReview: true,
        }, accountId, chainSource));
      }

      const totalFetched = nativeTxs.length + tokenTxs.length;
      const start = txns.length ? txns.reduce((a, b) => a.date < b.date ? a : b).date : null;
      const end = txns.length ? txns.reduce((a, b) => a.date > b.date ? a : b).date : null;
      setImportStatus(accountId, { status: 'synced', totalFetched, totalTxns: txns.length, startDate: start, endDate: end });
      return { txns, totalFetched };

    } catch (e) {
      setImportStatus(accountId, { status: 'failed', error: e.message });
      return { txns: [], error: e.message };
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

  // Fetch current USD prices + 24h change using CoinGecko (free, no auth required)
  // Returns Map<SYMBOL, { priceUsd: number, changePercent24Hr: number }>
  async function fetchLivePrices(symbols) {
    const result = new Map();
    const toFetch = [];
    const idToSym = {};
    for (const sym of symbols) {
      const cgId = CC_IDS[sym.toUpperCase()];
      if (cgId && !idToSym[cgId]) { toFetch.push(cgId); idToSym[cgId] = sym.toUpperCase(); }
    }
    if (!toFetch.length) return result;

    // CoinGecko /coins/markets — returns current_price (USD) + price_change_percentage_24h
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${toFetch.join(',')}&order=market_cap_desc&per_page=250&page=1&sparkline=false&price_change_percentage=24h`;
    try {
      const r = await fetchWithTimeout(url, 12000);
      if (!r || !r.ok) return result;
      const data = await r.json();
      for (const coin of (Array.isArray(data) ? data : [])) {
        const sym = idToSym[coin.id];
        if (sym) result.set(sym, {
          priceUsd:         parseFloat(coin.current_price) || 0,
          changePercent24Hr: parseFloat(coin.price_change_percentage_24h) || 0,
        });
      }
    } catch (e) {
      console.warn('[TaxEngine] CoinGecko price fetch failed:', e.message);
    }
    return result;
  }

  // Pure: enrich currentHoldings (from computeTaxYear) with live prices and aggregate totals
  function buildPortfolioSnapshot(currentHoldings, livePrices, sekRate, allTxns) {
    sekRate = sekRate || STABLE_SEK.USD; // fallback if FX fetch failed
    let totalValueSEK = 0;
    let totalCostSEK = 0;
    let totalUnrealizedSEK = 0;
    let fiatInvestedSEK = 0;
    let fiatProceedsSEK = 0;
    let totalFeesSEK = 0;

    const holdings = currentHoldings.map(h => {
      const live = livePrices.get(h.symbol);
      const currentPriceSEK = live ? live.priceUsd * sekRate : null;
      const currentValueSEK = currentPriceSEK != null ? currentPriceSEK * h.quantity : null;
      const unrealizedSEK = currentValueSEK != null ? currentValueSEK - h.totalCostSEK : null;
      const unrealizedPct = unrealizedSEK != null && h.totalCostSEK > 0
        ? (unrealizedSEK / h.totalCostSEK) * 100 : null;
      if (currentValueSEK != null) totalValueSEK += currentValueSEK;
      totalCostSEK += h.totalCostSEK;
      if (unrealizedSEK != null) totalUnrealizedSEK += unrealizedSEK;
      const changePercent24Hr = live?.changePercent24Hr ?? null;
      // 24h P&L in SEK: how much the current value changed over the last 24h
      const change24hSEK = (currentValueSEK != null && changePercent24Hr != null)
        ? currentValueSEK * changePercent24Hr / 100
        : null;
      return {
        ...h, currentPriceSEK, currentValueSEK, unrealizedSEK, unrealizedPct,
        changePercent24Hr, change24hSEK
      };
    });

    for (const t of (allTxns || [])) {
      if ((t.feeSEK || 0) > 0) totalFeesSEK += t.feeSEK;
      if (t.category === CAT.BUY && (t.costBasisSEK || 0) > 0) fiatInvestedSEK += t.costBasisSEK;
      if (t.category === CAT.SELL && (t.costBasisSEK || 0) > 0) fiatProceedsSEK += t.costBasisSEK;
    }

    return {
      holdings, totalValueSEK, totalCostSEK, totalUnrealizedSEK,
      fiatInvestedSEK, fiatProceedsSEK, totalFeesSEK, sekRate,
      fetchedAt: Date.now()
    };
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

    const hlds = {};   // sym → quantity
    function ens(sym) { if (!hlds[sym]) hlds[sym] = 0; }

    // Collect month-end snapshots from first tx date to today
    const first = new Date(sorted[0].date);
    const now = new Date();
    const months = [];
    const cur = new Date(first.getFullYear(), first.getMonth(), 1);
    while (cur <= now) { months.push(new Date(cur)); cur.setMonth(cur.getMonth() + 1); }

    const points = [];
    let tIdx = 0;

    for (const mStart of months) {
      const mEnd = new Date(mStart.getFullYear(), mStart.getMonth() + 1, 0);
      const dateStr = mEnd.toISOString().slice(0, 10);

      // Apply all txns up to end of month
      while (tIdx < sorted.length && new Date(sorted[tIdx].date) <= mEnd) {
        const t = sorted[tIdx++];
        const sym = t.assetSymbol; if (!sym) continue;
        ens(sym);
        const cat = t.category;
        if ([CAT.BUY, CAT.TRANSFER_IN, CAT.RECEIVE, CAT.INCOME].includes(cat))
          hlds[sym] = (hlds[sym] || 0) + (t.amount || 0);
        else if ([CAT.SELL, CAT.SEND, CAT.TRANSFER_OUT].includes(cat))
          hlds[sym] = Math.max(0, (hlds[sym] || 0) - (t.amount || 0));
        else if (cat === CAT.TRADE) {
          hlds[sym] = Math.max(0, (hlds[sym] || 0) - (t.amount || 0));
          if (t.inAsset && t.inAmount > 0) { ens(t.inAsset); hlds[t.inAsset] = (hlds[t.inAsset] || 0) + t.inAmount; }
        }
      }

      // Value at month end using price cache
      let valueSEK = 0, hasPrice = false;
      for (const [sym, qty] of Object.entries(hlds)) {
        if (qty <= 1e-9) continue;
        const ccId = CC_IDS[sym]; if (!ccId) continue;
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
    const now = new Date();
    const cur = new Date(first.getFullYear(), first.getMonth(), 1);
    const months = [];
    while (cur <= now) { months.push(new Date(cur)); cur.setMonth(cur.getMonth() + 1); }

    const points = [];
    let tIdx = 0;

    for (const mStart of months) {
      const mEnd = new Date(mStart.getFullYear(), mStart.getMonth() + 1, 0);
      const dateStr = mEnd.toISOString().slice(0, 10);

      // Replay all txns up to month end
      while (tIdx < sorted.length && new Date(sorted[tIdx].date) <= mEnd) {
        const t = sorted[tIdx++];
        const sym = t.assetSymbol; if (!sym) continue;
        ens(sym);
        const cost = t.costBasisSEK || 0;
        const cat = t.category;
        if ([CAT.BUY, CAT.TRANSFER_IN, CAT.RECEIVE, CAT.INCOME].includes(cat)) {
          hlds[sym].qty += (t.amount || 0);
          hlds[sym].totalCostSEK += cost;
        } else if ([CAT.SELL, CAT.SEND, CAT.TRANSFER_OUT].includes(cat)) {
          const qty = hlds[sym].qty;
          const remove = Math.min(t.amount || 0, qty);
          const avg = qty > 0 ? hlds[sym].totalCostSEK / qty : 0;
          hlds[sym].qty = Math.max(0, qty - remove);
          hlds[sym].totalCostSEK = Math.max(0, hlds[sym].totalCostSEK - avg * remove);
        } else if (cat === CAT.TRADE) {
          const qty = hlds[sym].qty;
          const remove = Math.min(t.amount || 0, qty);
          const avg = qty > 0 ? hlds[sym].totalCostSEK / qty : 0;
          hlds[sym].qty = Math.max(0, qty - remove);
          hlds[sym].totalCostSEK = Math.max(0, hlds[sym].totalCostSEK - avg * remove);
          if (t.inAsset && t.inAmount > 0) {
            ens(t.inAsset);
            hlds[t.inAsset].qty += t.inAmount;
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
  function formatSEK(amt, d = 0) {
    if (amt === null || amt === undefined || isNaN(amt)) return '—';
    return new Intl.NumberFormat('sv-SE', { style: 'currency', currency: 'SEK', minimumFractionDigits: d, maximumFractionDigits: d }).format(amt);
  }
  function formatCrypto(amt, d = 6) {
    if (!amt && amt !== 0) return '—';
    return parseFloat(amt).toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: d });
  }
  function getAvailableTaxYears() {
    const txns = getTransactions();
    if (!txns.length) { const y = new Date().getFullYear(); return [y - 1, y]; }
    const years = [...new Set(txns.map(t => new Date(t.date).getFullYear()))].sort();
    const cur = new Date().getFullYear();
    if (!years.includes(cur)) years.push(cur);
    return years;
  }

  // ── Public API ────────────────────────────────────────────
  return {
    CAT, PS, PC, REVIEW_DESCRIPTIONS,
    // Settings
    getSettings, saveSettings, loadSettings,
    // Accounts
    getAccounts, addAccount, removeAccount, updateAccount, loadAccounts, clearAllData,
    clearUserCache,  // call on login/logout to wipe stale user data from memory
    getImportStatus, setImportStatus, loadImportStatuses,
    // Transactions
    loadTransactions,
    getTransactions, saveTransactions, addTransactions,
    deleteTransaction, updateTransaction,
    // Cloud sync (cross-browser)
    syncToCloud: _pushTransactionsToCloud,
    normalizeTransaction,
    // Pipeline
    runPipeline, Events,
    // Pipeline steps (exposed for testing / manual re-run)
    decodeOnChainEvents, resolveAllTokenMetadata, detectSpamTokens,
    deduplicateTransactions, matchTransfers, autoClassifyAll,
    detectNegativeBalances,
    // Classification
    looksLikeContractAddress,
    // Re-sync / cleanup
    resyncAccount, purgeSolanaPhantoms,
    // Prices
    fetchAllSEKPrices, getPriceCache, savePriceCache,
    // Tax engine
    computeTaxYear, computeReportHealth,
    // K4 export
    generateK4Report, generateK4CSV, generateAuditCSV,
    // Review
    getReviewIssues, isTaxableCategory,
    // CSV parsers
    parseBinanceCSV, parseKrakenCSV, parseBybitCSV, parseCoinbaseCSV, parseGenericCSV,
    parseRevolutCSV, parseMEXCCSV, parseSolscanCSV,
    // Blockchain import
    importSolanaWallet, importEthWallet,
    // Solana post-processing
    reprocessSolanaSwaps,
    // Portfolio live data
    fetchLiveSEKRate, fetchLivePrices, buildPortfolioSnapshot, buildPortfolioHistory, buildCostBasisHistory,
    // Token name resolution
    resolveTokenDisplay, resolveUnknownTokenNames,
    // Utils
    formatSEK, formatCrypto, getAvailableTaxYears,
    isPipelineRunning: () => _pipelineRunning,
  };
})();
