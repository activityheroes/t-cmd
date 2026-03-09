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

  // ── CoinGecko symbol → ID mapping ────────────────────────
  const CG_IDS = {
    BTC:'bitcoin',ETH:'ethereum',SOL:'solana',BNB:'binancecoin',
    ADA:'cardano',DOT:'polkadot',AVAX:'avalanche-2',MATIC:'matic-network',
    LINK:'chainlink',UNI:'uniswap',ATOM:'cosmos',NEAR:'near',
    OP:'optimism',ARB:'arbitrum',INJ:'injective-protocol',APT:'aptos',
    SUI:'sui',DOGE:'dogecoin',LTC:'litecoin',XRP:'ripple',
    SHIB:'shiba-inu',PEPE:'pepe',WIF:'dogwifhat',BONK:'bonk',
    JUP:'jupiter',PYTH:'pyth-network',SEI:'sei-network',TIA:'celestia',
    STRK:'starknet',TON:'the-open-network',TRUMP:'maga',FARTCOIN:'fartcoin',
    USDT:'tether',USDC:'usd-coin',BUSD:'binance-usd',DAI:'dai',
    WETH:'weth',WBTC:'wrapped-bitcoin',WSOL:'wrapped-solana',
    ALGO:'algorand',FTM:'fantom',SAND:'the-sandbox',MANA:'decentraland',
    CRV:'curve-dao-token',AAVE:'aave',COMP:'compound-governance-token',
    SNX:'havven',MKR:'maker',LDO:'lido-dao',RPL:'rocket-pool',
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
    const def = { currency:'SEK', taxYear: new Date().getFullYear()-1, country:'SE', method:'genomsnittsmetoden' };
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

  // ── Transactions ──────────────────────────────────────────
  function getTransactions() { try { return JSON.parse(localStorage.getItem(LS.TRANSACTIONS)||'[]'); } catch { return []; } }
  function saveTransactions(txns) { localStorage.setItem(LS.TRANSACTIONS, JSON.stringify(txns)); }

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
      coinGeckoId:    raw.coinGeckoId || CG_IDS[(raw.assetSymbol||'').toUpperCase()] || null,
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
      _raw:           raw,
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
    const raw     = t._raw || {};
    const rawType = (raw.type || raw.side || raw.category || raw.transactionType || '').toLowerCase();
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
  // SEK PRICE PIPELINE  (CoinGecko free API, rate-limited)
  // ════════════════════════════════════════════════════════════
  let _cgQueue = Promise.resolve();
  const CG_DELAY_MS = 1500; // ~40 req/min on free tier

  function getPriceCache() { try { return JSON.parse(localStorage.getItem(LS.PRICES)||'{}'); } catch { return {}; } }
  function savePriceCache(c) { localStorage.setItem(LS.PRICES, JSON.stringify(c)); }

  function cgDateStr(isoDate) {
    const d = new Date(isoDate);
    const dd = String(d.getDate()).padStart(2,'0');
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const yy = d.getFullYear();
    return `${dd}-${mm}-${yy}`; // CoinGecko format
  }

  function cacheKey(coinId, isoDate) {
    return `${coinId}_${isoDate.slice(0,10)}`;
  }

  // Rate-limited single fetch
  async function cgFetchOne(coinId, isoDate) {
    const cache = getPriceCache();
    const key   = cacheKey(coinId, isoDate);
    if (cache[key] !== undefined) return cache[key];

    return new Promise(resolve => {
      _cgQueue = _cgQueue
        .then(() => sleep(CG_DELAY_MS))
        .then(async () => {
          try {
            const date = cgDateStr(isoDate);
            const url  = `https://api.coingecko.com/api/v3/coins/${coinId}/history?date=${date}&localization=false`;
            const r    = await fetch(url);
            if (r.status === 429) { await sleep(60000); return null; }
            if (!r.ok)            return null;
            const data  = await r.json();
            const price = data?.market_data?.current_price?.sek || null;
            if (price !== null) {
              const c = getPriceCache();
              c[key] = price;
              savePriceCache(c);
            }
            resolve(price);
            return price;
          } catch { resolve(null); return null; }
        });
    });
  }

  function stableSEKPrice(sym) {
    const EUR = ['EUROC','EURC','EURT','EURS'];
    if (EUR.includes(sym)) return STABLE_SEK.EUR;
    return STABLE_SEK.USD; // USDT, USDC, BUSD, DAI etc.
  }

  // Fetch SEK prices for all transactions that are missing them
  async function fetchAllSEKPrices(txns, onProgress) {
    // Collect unique (coinId, date) pairs needed
    const needed = [];
    for (const t of txns) {
      if (t.isInternalTransfer) continue;
      if (!isTaxableCategory(t.category)) continue;
      if (t.priceSEKPerUnit > 0) continue;     // Already have price
      if (STABLES.has(t.assetSymbol)) continue; // Will use stable price

      const cgId = t.coinGeckoId || CG_IDS[t.assetSymbol];
      if (!cgId) continue;

      const key = cacheKey(cgId, t.date);
      const cache = getPriceCache();
      if (cache[key] !== undefined) continue;

      if (!needed.find(n => n.key === key)) {
        needed.push({ key, cgId, date: t.date });
      }
    }

    let fetched = 0;
    for (const item of needed) {
      await cgFetchOne(item.cgId, item.date);
      fetched++;
      if (onProgress) onProgress({
        step: 'price',
        pct:  Math.round((fetched / needed.length) * 100),
        msg:  `Fetching prices… ${fetched}/${needed.length}`,
      });
    }

    // Now stamp prices onto transactions
    const cache = getPriceCache();
    return txns.map(t => {
      if (t.priceSEKPerUnit > 0) return t; // Already has price
      if (t.isInternalTransfer) return t;

      let price = null;
      let priceSource = null;

      if (STABLES.has(t.assetSymbol)) {
        price = stableSEKPrice(t.assetSymbol);
        priceSource = 'stable_approx';
      } else {
        const cgId = t.coinGeckoId || CG_IDS[t.assetSymbol];
        if (cgId) {
          price       = cache[cacheKey(cgId, t.date)] || null;
          priceSource = price ? 'coingecko' : null;
        }
      }

      if (!price) return t; // Still missing — goes to review

      const amount       = t.amount || 0;
      const costBasisSEK = price * amount;
      return {
        ...t,
        priceSEKPerUnit: price,
        costBasisSEK:    costBasisSEK,
        priceSource,
        needsReview:  false,
        reviewReason: null,
      };
    });
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
    const taxableGain  = netGainLoss > 0 ? netGainLoss : 0;
    const deductLoss   = totalLosses * LOSS_DEDUCTION;
    const estimatedTax = taxableGain * TAX_RATE;
    const totalIncome  = income.reduce((s,i) => s + i.valueSEK, 0);

    // Target-year transactions only (for stats)
    const yearTxns = txns.filter(t => new Date(t.date).getFullYear() === year);

    // Current holdings
    const currentHoldings = Object.entries(holdings)
      .filter(([,h]) => h.totalQty > 1e-9)
      .map(([sym, h]) => ({
        symbol:       sym,
        quantity:     h.totalQty,
        avgCostSEK:   h.totalQty > 0 ? h.totalCostSEK / h.totalQty : 0,
        totalCostSEK: h.totalCostSEK,
      }))
      .sort((a,b) => b.totalCostSEK - a.totalCostSEK);

    return {
      year, disposals, income, currentHoldings,
      summary: {
        totalTransactions:  yearTxns.length,
        totalDisposals:     disposals.length,
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
      if (gains.length > 0) {
        const qty  = gains.reduce((s,d) => s + d.amountSold, 0);
        const proc = gains.reduce((s,d) => s + d.proceedsSEK, 0);
        const cost = gains.reduce((s,d) => s + d.costBasisSEK, 0);
        const gain = gains.reduce((s,d) => s + d.gainLossSEK, 0);
        k4Rows.push({ sym, side:'gain', qty, proc, cost, gain, loss:0 });
      }
      if (losses.length > 0) {
        const qty  = losses.reduce((s,d) => s + d.amountSold, 0);
        const proc = losses.reduce((s,d) => s + d.proceedsSEK, 0);
        const cost = losses.reduce((s,d) => s + d.costBasisSEK, 0);
        const loss = Math.abs(losses.reduce((s,d) => s + d.gainLossSEK, 0));
        k4Rows.push({ sym, side:'loss', qty, proc, cost, gain:0, loss });
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
          const beteckning = r.side === 'gain'
            ? `${r.sym} kryptovaluta (vinst)`
            : `${r.sym} kryptovaluta (förlust)`;
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
  async function importSolanaWallet(address, accountId, onProgress) {
    const heliusKey = localStorage.getItem('tcmd_helius_key');
    if (!heliusKey) return { txns:[], error:'No Helius API key configured', missingKey:true };

    let allRaw = [], before = null, hasMore = true;
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

        allRaw  = allRaw.concat(page);
        before  = page[page.length-1].signature;
        hasMore = page.length === 100;

        if (onProgress) onProgress({ step:'import', msg:`Fetched ${allRaw.length} Solana transactions…` });
        await sleep(250);
      }

      const txns = allRaw.flatMap(tx => normalizeSolanaTx(tx, address, accountId)||[]).filter(Boolean);
      const start = txns.length ? txns.reduce((a,b) => a.date < b.date ? a : b).date : null;
      const end   = txns.length ? txns.reduce((a,b) => a.date > b.date ? a : b).date : null;

      setImportStatus(accountId, { status:'synced', totalFetched:allRaw.length, totalTxns:txns.length, startDate:start, endDate:end });
      return { txns, totalFetched:allRaw.length };
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

  const KNOWN_MINTS = {
    'So11111111111111111111111111111111111111112':'SOL',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1u':'USDC',
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB':'USDT',
  };
  function mintToSym(mint) { return KNOWN_MINTS[mint] || null; }

  // Ethereum via Etherscan — paginate ALL token transfers
  async function importEthWallet(address, accountId, onProgress) {
    let allTxns = [], page = 1, hasMore = true;
    setImportStatus(accountId, { status:'syncing', source:'ethereum', address });

    try {
      while (hasMore) {
        const url = `https://api.etherscan.io/api?module=account&action=tokentx&address=${address}&sort=desc&page=${page}&offset=100&apikey=YourApiKeyToken`;
        const r   = await fetch(url);
        if (!r.ok) break;
        const data = await r.json();
        if (data.status !== '1' || !data.result?.length) { hasMore = false; break; }
        allTxns = allTxns.concat(data.result);
        hasMore = data.result.length === 100;
        page++;
        if (onProgress) onProgress({ step:'import', msg:`Fetched ${allTxns.length} Ethereum transactions…` });
        await sleep(250);
      }

      const txns = allTxns.map(tx => {
        const isIn = tx.to.toLowerCase() === address.toLowerCase();
        return normalizeTransaction({
          txHash:  tx.hash, date: new Date(parseInt(tx.timeStamp)*1000).toISOString(),
          type:    isIn ? 'transfer_in' : 'transfer_out',
          assetSymbol: tx.tokenSymbol?.toUpperCase(),
          assetName:   tx.tokenName,
          amount:  parseInt(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal)||18),
          feeSEK:  (parseInt(tx.gasUsed) * parseInt(tx.gasPrice) / 1e18) * 110, // approx ETH→SEK
          needsReview: true,
        }, accountId, 'eth_wallet');
      });

      const start = txns.length ? txns.reduce((a,b) => a.date < b.date ? a : b).date : null;
      setImportStatus(accountId, { status:'synced', totalFetched:allTxns.length, totalTxns:txns.length, startDate:start, endDate:new Date().toISOString() });
      return { txns, totalFetched:allTxns.length };
    } catch (e) {
      setImportStatus(accountId, { status:'failed', error:e.message });
      return { txns:[], error:e.message };
    }
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
    generateK4Report, generateK4CSV,
    // Review
    getReviewIssues, isTaxableCategory,
    // CSV parsers
    parseBinanceCSV, parseKrakenCSV, parseBybitCSV, parseCoinbaseCSV, parseGenericCSV,
    // Blockchain import
    importSolanaWallet, importEthWallet,
    // Utils
    formatSEK, formatCrypto, getAvailableTaxYears,
    isPipelineRunning: () => _pipelineRunning,
  };
})();
