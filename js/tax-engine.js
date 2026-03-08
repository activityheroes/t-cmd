/* ============================================================
   T-CMD — Swedish Crypto Tax Engine
   Implements Genomsnittsmetoden (average cost method)
   as required by Skatteverket for crypto assets.
   Produces K4-compatible gain/loss records.
   ============================================================ */

const TaxEngine = (() => {

  // ── Constants ─────────────────────────────────────────────
  const TAX_RATE_GAIN  = 0.30;   // 30% on capital gains
  const LOSS_DEDUCTION = 0.70;   // 70% of losses deductible
  const CRYPTO_BOX     = 'D';    // K4 box for crypto (Övriga tillgångar)

  // ── Transaction Categories ─────────────────────────────────
  const CATEGORIES = {
    BUY:          'buy',
    SELL:         'sell',
    TRADE:        'trade',       // crypto-to-crypto (treated as sell+buy)
    RECEIVE:      'receive',     // gift / airdrop / mining income
    SEND:         'send',        // gift / transfer out
    INCOME:       'income',      // staking rewards, interest (income tax)
    FEE:          'fee',
    TRANSFER_IN:  'transfer_in',
    TRANSFER_OUT: 'transfer_out',
  };

  // ── State Storage Keys ────────────────────────────────────
  const LS_ACCOUNTS     = 'tcmd_tax_accounts';
  const LS_TRANSACTIONS = 'tcmd_tax_transactions';
  const LS_SETTINGS     = 'tcmd_tax_settings';
  const LS_PRICE_CACHE  = 'tcmd_tax_price_cache';

  // ── Settings ──────────────────────────────────────────────
  function getSettings() {
    const defaults = {
      currency: 'SEK',
      taxYear:  new Date().getFullYear() - 1,
      country:  'SE',
      method:   'genomsnittsmetoden',
    };
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
    } catch { return defaults; }
  }

  function saveSettings(s) {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
  }

  // ── Accounts ──────────────────────────────────────────────
  function getAccounts() {
    try {
      return JSON.parse(localStorage.getItem(LS_ACCOUNTS) || '[]');
    } catch { return []; }
  }

  function saveAccounts(accs) {
    localStorage.setItem(LS_ACCOUNTS, JSON.stringify(accs));
  }

  function addAccount(account) {
    const accs = getAccounts();
    const id = 'acc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const newAcc = { id, addedAt: new Date().toISOString(), ...account };
    accs.push(newAcc);
    saveAccounts(accs);
    return newAcc;
  }

  function removeAccount(id) {
    const accs = getAccounts().filter(a => a.id !== id);
    saveAccounts(accs);
    // Also remove its transactions
    const txns = getTransactions().filter(t => t.accountId !== id);
    saveTransactions(txns);
  }

  // ── Transactions ──────────────────────────────────────────
  function getTransactions() {
    try {
      return JSON.parse(localStorage.getItem(LS_TRANSACTIONS) || '[]');
    } catch { return []; }
  }

  function saveTransactions(txns) {
    localStorage.setItem(LS_TRANSACTIONS, JSON.stringify(txns));
  }

  function addTransactions(newTxns) {
    const existing = getTransactions();
    // Deduplicate by txHash + accountId
    const seen = new Set(existing.map(t => `${t.txHash}|${t.accountId}`));
    const added = [];
    for (const t of newTxns) {
      const key = `${t.txHash}|${t.accountId}`;
      if (!seen.has(key)) {
        seen.add(key);
        existing.push(t);
        added.push(t);
      }
    }
    saveTransactions(existing);
    return added.length;
  }

  function deleteTransaction(id) {
    saveTransactions(getTransactions().filter(t => t.id !== id));
  }

  function updateTransaction(id, data) {
    const txns = getTransactions().map(t => t.id === id ? { ...t, ...data } : t);
    saveTransactions(txns);
  }

  // ── Price Cache ───────────────────────────────────────────
  function getPriceCache() {
    try { return JSON.parse(localStorage.getItem(LS_PRICE_CACHE) || '{}'); }
    catch { return {}; }
  }

  function savePriceCache(cache) {
    localStorage.setItem(LS_PRICE_CACHE, JSON.stringify(cache));
  }

  // Fetch historical price from CoinGecko (SEK per coin on a specific date)
  async function fetchHistoricalPrice(coinId, dateStr) {
    // dateStr = 'YYYY-MM-DD'
    const cache = getPriceCache();
    const key = `${coinId}_${dateStr}`;
    if (cache[key]) return cache[key];

    try {
      // CoinGecko expects DD-MM-YYYY
      const [y, m, d] = dateStr.split('-');
      const cgDate = `${d}-${m}-${y}`;
      const url = `https://api.coingecko.com/api/v3/coins/${coinId}/history?date=${cgDate}&localization=false`;
      const r = await fetch(url);
      if (!r.ok) return null;
      const data = await r.json();
      const priceSEK = data?.market_data?.current_price?.sek;
      if (priceSEK) {
        cache[key] = priceSEK;
        savePriceCache(cache);
      }
      return priceSEK || null;
    } catch {
      return null;
    }
  }

  // ── Normalization ─────────────────────────────────────────
  // Normalize a raw transaction from any source into our standard format
  function normalizeTransaction(raw, accountId, source) {
    const base = {
      id:          'txn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      accountId,
      source,
      txHash:      raw.txHash || raw.hash || raw.id || ('manual_' + Date.now()),
      date:        raw.date || raw.timestamp || new Date().toISOString(),
      category:    raw.category || inferCategory(raw),
      assetSymbol: (raw.assetSymbol || raw.symbol || raw.asset || '').toUpperCase(),
      assetName:   raw.assetName || raw.name || '',
      coinGeckoId: raw.coinGeckoId || null,
      amount:      parseFloat(raw.amount || raw.quantity || 0),
      // Incoming side (for trades)
      inAsset:     (raw.inAsset || '').toUpperCase(),
      inAmount:    parseFloat(raw.inAmount || 0),
      // Cost / value in SEK at time of transaction
      costBasisSEK:   parseFloat(raw.costBasisSEK || raw.priceSEK * raw.amount || 0),
      priceSEKPerUnit: parseFloat(raw.priceSEKPerUnit || raw.priceSEK || 0),
      feeSEK:          parseFloat(raw.feeSEK || raw.fee || 0),
      // Manual review flag
      needsReview: raw.needsReview || (!raw.priceSEK && !raw.costBasisSEK),
      notes:       raw.notes || '',
      labels:      raw.labels || [],
      // Raw source data for debugging
      _raw: raw,
    };
    return base;
  }

  function inferCategory(raw) {
    const type = (raw.type || raw.category || '').toLowerCase();
    if (type.includes('buy') || type.includes('purchase')) return CATEGORIES.BUY;
    if (type.includes('sell')) return CATEGORIES.SELL;
    if (type.includes('trade') || type.includes('swap') || type.includes('convert')) return CATEGORIES.TRADE;
    if (type.includes('deposit') || type.includes('receive') || type.includes('credit')) return CATEGORIES.RECEIVE;
    if (type.includes('withdraw') || type.includes('send') || type.includes('debit')) return CATEGORIES.SEND;
    if (type.includes('staking') || type.includes('reward') || type.includes('interest') || type.includes('earn')) return CATEGORIES.INCOME;
    if (type.includes('fee')) return CATEGORIES.FEE;
    if (type.includes('transfer')) {
      return (raw.direction === 'in' || raw.direction === 'credit') ? CATEGORIES.TRANSFER_IN : CATEGORIES.TRANSFER_OUT;
    }
    return CATEGORIES.BUY;
  }

  // ── CSV Parsers ───────────────────────────────────────────
  function parseCSV(text) {
    const lines = text.trim().split('\n');
    const header = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    return lines.slice(1).map(line => {
      // Handle quoted commas
      const cols = [];
      let current = '';
      let inQuote = false;
      for (const ch of line) {
        if (ch === '"') { inQuote = !inQuote; }
        else if (ch === ',' && !inQuote) { cols.push(current.trim()); current = ''; }
        else { current += ch; }
      }
      cols.push(current.trim());
      const obj = {};
      header.forEach((h, i) => { obj[h] = cols[i] || ''; });
      return obj;
    }).filter(row => Object.values(row).some(v => v));
  }

  function parseBinanceCSV(text, accountId) {
    const rows = parseCSV(text);
    return rows.map(r => {
      const isBuy  = (r['Side'] || r['Type'] || '').toUpperCase() === 'BUY';
      const isSell = (r['Side'] || r['Type'] || '').toUpperCase() === 'SELL';
      const asset   = (r['Coin'] || r['Asset'] || '').replace('USDT', '').replace('BUSD', '');
      const quoteAmt = parseFloat(r['Total'] || r['Executed Amount (Quote)'] || 0);
      const price    = parseFloat(r['Price'] || r['Avg Trading Price'] || 0);
      const qty      = parseFloat(r['Executed'] || r['Amount'] || r['Quantity'] || 0);
      const fee      = parseFloat(r['Fee'] || 0);

      return normalizeTransaction({
        txHash:      r['TxID'] || r['Order ID'] || '',
        date:        r['Date(UTC)'] || r['Date'] || r['Time'],
        category:    isBuy ? CATEGORIES.BUY : isSell ? CATEGORIES.SELL : CATEGORIES.TRADE,
        assetSymbol: asset,
        amount:      qty,
        // Price in quote currency (usually USDT) — will need SEK conversion
        priceSEKPerUnit: price, // placeholder, SEK fetch needed
        feeSEK:      fee,
        needsReview: true, // Binance prices are in USDT, need SEK conversion
        notes:       `Binance import — price in ${r['Quote Asset'] || 'USDT'}, SEK conversion needed`,
      }, accountId, 'binance_csv');
    });
  }

  function parseKrakenCSV(text, accountId) {
    const rows = parseCSV(text);
    return rows.map(r => {
      const type = (r['type'] || '').toLowerCase();
      const asset = (r['asset'] || r['pair'] || '').replace(/^X/, '').replace(/Z?EUR$|Z?USD$/, '').toUpperCase();
      return normalizeTransaction({
        txHash:      r['txid'] || r['refid'] || '',
        date:        r['time'],
        category:    type === 'buy' ? CATEGORIES.BUY : type === 'sell' ? CATEGORIES.SELL :
                     type === 'deposit' ? CATEGORIES.RECEIVE : type === 'withdrawal' ? CATEGORIES.SEND :
                     type === 'staking' ? CATEGORIES.INCOME : CATEGORIES.TRADE,
        assetSymbol: asset,
        amount:      parseFloat(r['vol'] || r['amount'] || 0),
        priceSEKPerUnit: parseFloat(r['price'] || 0),
        feeSEK:      parseFloat(r['fee'] || 0),
        needsReview: true,
        notes:       'Kraken import — verify SEK price',
      }, accountId, 'kraken_csv');
    });
  }

  function parseBybitCSV(text, accountId) {
    const rows = parseCSV(text);
    return rows.map(r => {
      const side = (r['Side'] || '').toUpperCase();
      return normalizeTransaction({
        txHash:      r['Order ID'] || r['Trade ID'] || '',
        date:        r['Date'] || r['Time'],
        category:    side === 'BUY' ? CATEGORIES.BUY : side === 'SELL' ? CATEGORIES.SELL : CATEGORIES.TRADE,
        assetSymbol: (r['Symbol'] || '').replace('USDT', ''),
        amount:      parseFloat(r['Qty'] || r['Amount'] || 0),
        priceSEKPerUnit: parseFloat(r['Price'] || 0),
        feeSEK:      parseFloat(r['Trading Fee'] || 0),
        needsReview: true,
        notes:       'Bybit import — verify SEK price',
      }, accountId, 'bybit_csv');
    });
  }

  function parseCoinbaseCSV(text, accountId) {
    const rows = parseCSV(text);
    return rows.map(r => {
      const type = (r['Transaction Type'] || '').toLowerCase();
      const spotPrice = parseFloat(r['Spot Price at Transaction'] || 0);
      const subtotal  = parseFloat(r['Subtotal'] || 0);
      const total     = parseFloat(r['Total (inclusive of fees and/or spread)'] || 0);
      const fees      = parseFloat(r['Fees and/or Spread'] || 0);
      return normalizeTransaction({
        txHash:      r['ID'] || r['Notes'] || '',
        date:        r['Timestamp'],
        category:    type.includes('buy') ? CATEGORIES.BUY :
                     type.includes('sell') ? CATEGORIES.SELL :
                     type.includes('receive') || type.includes('reward') || type.includes('earn') ? CATEGORIES.INCOME :
                     type.includes('send') || type.includes('convert') ? CATEGORIES.TRADE : CATEGORIES.RECEIVE,
        assetSymbol: (r['Asset'] || r['Coin Type'] || '').toUpperCase(),
        amount:      parseFloat(r['Quantity Transacted'] || 0),
        priceSEKPerUnit: spotPrice, // USD, needs conversion
        feeSEK:      fees,
        needsReview: true,
        notes:       `Coinbase import — price in ${r['Spot Price Currency'] || 'USD'}`,
      }, accountId, 'coinbase_csv');
    });
  }

  function parseGenericCSV(text, accountId) {
    // Auto-detect column mapping from common headers
    const rows = parseCSV(text);
    if (!rows.length) return [];
    return rows.map(r => {
      const lc = Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v]));
      return normalizeTransaction({
        txHash:      lc['txhash'] || lc['hash'] || lc['id'] || lc['orderid'] || '',
        date:        lc['date'] || lc['datetime'] || lc['timestamp'] || lc['time'] || '',
        category:    lc['type'] || lc['category'] || lc['side'] || '',
        assetSymbol: (lc['asset'] || lc['symbol'] || lc['coin'] || lc['currency'] || '').toUpperCase(),
        amount:      parseFloat(lc['amount'] || lc['quantity'] || lc['qty'] || 0),
        priceSEKPerUnit: parseFloat(lc['pricesek'] || lc['price_sek'] || lc['price'] || 0),
        feeSEK:      parseFloat(lc['fee'] || lc['feesek'] || lc['fee_sek'] || 0),
        costBasisSEK: parseFloat(lc['totalsek'] || lc['total_sek'] || 0),
        needsReview: true,
        notes:       'Generic CSV import',
      }, accountId, 'generic_csv');
    });
  }

  // ── Blockchain Import ─────────────────────────────────────
  // Solana — uses Helius if available, falls back to public RPC
  async function importSolanaWallet(address, accountId) {
    const txns = [];
    try {
      // Try Helius enhanced API
      const heliusKey = localStorage.getItem('tcmd_helius_key');
      if (heliusKey) {
        const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${heliusKey}&limit=100&type=SWAP`;
        const r = await fetch(url);
        if (r.ok) {
          const data = await r.json();
          for (const tx of data) {
            const t = normalizeSolanaTx(tx, address, accountId);
            if (t) txns.push(t);
          }
        }
      }
    } catch (e) {
      console.warn('Helius import failed:', e.message);
    }
    return txns;
  }

  function normalizeSolanaTx(tx, walletAddr, accountId) {
    try {
      const isSwap = tx.type === 'SWAP' || tx.type === 'UNKNOWN';
      const ts = new Date((tx.timestamp || 0) * 1000).toISOString();
      const tokenTransfers = tx.tokenTransfers || [];
      if (!tokenTransfers.length) return null;

      // Find what went out and what came in
      const outgoing = tokenTransfers.filter(t => t.fromUserAccount === walletAddr);
      const incoming = tokenTransfers.filter(t => t.toUserAccount === walletAddr);

      if (isSwap && outgoing.length && incoming.length) {
        const out = outgoing[0];
        const inc = incoming[0];
        return normalizeTransaction({
          txHash:      tx.signature,
          date:        ts,
          category:    CATEGORIES.TRADE,
          assetSymbol: out.mint || 'SOL',
          amount:      out.tokenAmount || 0,
          inAsset:     inc.mint || 'SOL',
          inAmount:    inc.tokenAmount || 0,
          feeSEK:      (tx.fee || 0) / 1e9 * 150, // approx SOL fee in SEK
          needsReview: true,
          notes:       'Solana swap — verify SEK price',
        }, accountId, 'solana_wallet');
      }

      // Simple transfer in/out
      if (incoming.length) {
        const inc = incoming[0];
        return normalizeTransaction({
          txHash:      tx.signature,
          date:        ts,
          category:    CATEGORIES.RECEIVE,
          assetSymbol: inc.mint || 'SOL',
          amount:      inc.tokenAmount || 0,
          needsReview: true,
        }, accountId, 'solana_wallet');
      }
    } catch { return null; }
    return null;
  }

  // Ethereum — uses Etherscan
  async function importEthWallet(address, accountId) {
    const txns = [];
    try {
      const url = `https://api.etherscan.io/api?module=account&action=tokentx&address=${address}&sort=desc&apikey=YourApiKeyToken`;
      const r = await fetch(url);
      if (!r.ok) return txns;
      const data = await r.json();
      if (data.status !== '1') return txns;
      for (const tx of (data.result || []).slice(0, 200)) {
        const isIn = tx.to.toLowerCase() === address.toLowerCase();
        txns.push(normalizeTransaction({
          txHash:      tx.hash,
          date:        new Date(parseInt(tx.timeStamp) * 1000).toISOString(),
          category:    isIn ? CATEGORIES.RECEIVE : CATEGORIES.SEND,
          assetSymbol: tx.tokenSymbol,
          assetName:   tx.tokenName,
          amount:      parseInt(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal)),
          needsReview: true,
          notes:       'ETH wallet import',
        }, accountId, 'eth_wallet'));
      }
    } catch (e) {
      console.warn('ETH import failed:', e.message);
    }
    return txns;
  }

  // ── Genomsnittsmetoden (Swedish Average Cost) ─────────────
  /*
   * For each asset, we track:
   *   - totalQuantity: total units currently held
   *   - totalCostSEK:  total cost basis in SEK (after fees)
   *   - avgCostSEK:    totalCostSEK / totalQuantity
   *
   * On SELL:
   *   gainLoss = (salePriceSEK - avgCostSEK) * quantitySold - feeSEK
   *
   * Fees on BUY increase cost basis.
   * Fees on SELL reduce proceeds (thus increase loss or reduce gain).
   */

  function computeTaxYear(year) {
    const allTxns = getTransactions()
      .filter(t => {
        const d = new Date(t.date);
        return d.getFullYear() === parseInt(year);
      })
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    // Holdings map: symbol → { totalQty, totalCostSEK }
    // Carry over from previous years by processing all history
    const allHistory = getTransactions()
      .filter(t => new Date(t.date).getFullYear() <= parseInt(year))
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    const holdings = {};  // symbol → { totalQty, totalCostSEK }
    const disposals = []; // All disposal events in target year
    const income = [];    // Income events (staking etc.)

    function ensureHolding(sym) {
      if (!holdings[sym]) holdings[sym] = { totalQty: 0, totalCostSEK: 0 };
    }

    function avgCost(sym) {
      const h = holdings[sym];
      if (!h || h.totalQty === 0) return 0;
      return h.totalCostSEK / h.totalQty;
    }

    // Process in chronological order
    for (const t of allHistory) {
      const sym = t.assetSymbol;
      if (!sym) continue;
      ensureHolding(sym);
      const h = holdings[sym];
      const inTargetYear = new Date(t.date).getFullYear() === parseInt(year);

      switch (t.category) {
        case CATEGORIES.BUY:
        case CATEGORIES.RECEIVE:
        case CATEGORIES.INCOME:
        case CATEGORIES.TRANSFER_IN: {
          const costSEK = t.costBasisSEK || (t.priceSEKPerUnit * t.amount) || 0;
          const feeSEK  = t.feeSEK || 0;
          h.totalQty     += t.amount;
          h.totalCostSEK += costSEK + feeSEK; // fees are added to cost basis on buy

          if (inTargetYear && t.category === CATEGORIES.INCOME) {
            income.push({
              date:        t.date,
              assetSymbol: sym,
              amount:      t.amount,
              valueSEK:    costSEK,
              category:    'income',
              id:          t.id,
              notes:       t.notes,
            });
          }
          break;
        }

        case CATEGORIES.SELL:
        case CATEGORIES.SEND: {
          const proceedsSEK = t.costBasisSEK || (t.priceSEKPerUnit * t.amount) || 0;
          const feeSEK      = t.feeSEK || 0;
          const costBasis   = avgCost(sym) * t.amount;
          const gainLoss    = proceedsSEK - feeSEK - costBasis;

          if (inTargetYear && t.category === CATEGORIES.SELL) {
            disposals.push({
              date:          t.date,
              assetSymbol:   sym,
              assetName:     t.assetName || sym,
              amountSold:    t.amount,
              proceedsSEK:   proceedsSEK,
              feeSEK:        feeSEK,
              costBasisSEK:  costBasis,
              gainLossSEK:   gainLoss,
              avgCostAtSale: avgCost(sym),
              id:            t.id,
              needsReview:   t.needsReview,
            });
          }

          // Update holdings
          h.totalQty     = Math.max(0, h.totalQty - t.amount);
          h.totalCostSEK = Math.max(0, h.totalCostSEK - costBasis);
          break;
        }

        case CATEGORIES.TRADE: {
          // Treated as: sell outgoing asset, buy incoming asset
          const outSym  = sym;
          const inSym   = t.inAsset;
          const outAmt  = t.amount;
          const inAmt   = t.inAmount;
          const outProc = t.costBasisSEK || (t.priceSEKPerUnit * outAmt) || 0;
          const feeSEK  = t.feeSEK || 0;

          // Process sell side
          ensureHolding(outSym);
          const hOut = holdings[outSym];
          const costBasisOut = avgCost(outSym) * outAmt;
          const gainLossOut  = outProc - feeSEK - costBasisOut;

          if (inTargetYear) {
            disposals.push({
              date:          t.date,
              assetSymbol:   outSym,
              assetName:     t.assetName || outSym,
              amountSold:    outAmt,
              proceedsSEK:   outProc,
              feeSEK:        feeSEK,
              costBasisSEK:  costBasisOut,
              gainLossSEK:   gainLossOut,
              avgCostAtSale: avgCost(outSym),
              id:            t.id,
              isTrade:       true,
              inAsset:       inSym,
              inAmount:      inAmt,
              needsReview:   t.needsReview,
            });
          }

          hOut.totalQty     = Math.max(0, hOut.totalQty - outAmt);
          hOut.totalCostSEK = Math.max(0, hOut.totalCostSEK - costBasisOut);

          // Process buy side
          if (inSym && inAmt > 0) {
            ensureHolding(inSym);
            const hIn = holdings[inSym];
            // Cost basis of incoming = fair market value (same as sale proceeds)
            hIn.totalQty     += inAmt;
            hIn.totalCostSEK += outProc;
          }
          break;
        }

        case CATEGORIES.TRANSFER_OUT: {
          // No taxable event, just reduce holdings
          ensureHolding(sym);
          const h2 = holdings[sym];
          const costToRemove = avgCost(sym) * t.amount;
          h2.totalQty     = Math.max(0, h2.totalQty - t.amount);
          h2.totalCostSEK = Math.max(0, h2.totalCostSEK - costToRemove);
          break;
        }
      }
    }

    // ── Summary ────────────────────────────────────────────
    const totalGains  = disposals.filter(d => d.gainLossSEK > 0).reduce((s, d) => s + d.gainLossSEK, 0);
    const totalLosses = disposals.filter(d => d.gainLossSEK < 0).reduce((s, d) => s + Math.abs(d.gainLossSEK), 0);
    const netGainLoss = totalGains - totalLosses;
    const taxableGain = netGainLoss > 0 ? netGainLoss : 0;
    const deductibleLoss = netGainLoss < 0 ? Math.abs(netGainLoss) * LOSS_DEDUCTION : 0;
    const estimatedTax = taxableGain * TAX_RATE_GAIN;

    const totalIncome = income.reduce((s, i) => s + i.valueSEK, 0);

    // Current holdings snapshot
    const currentHoldings = Object.entries(holdings)
      .filter(([, h]) => h.totalQty > 0.0000001)
      .map(([sym, h]) => ({
        symbol:       sym,
        quantity:     h.totalQty,
        avgCostSEK:   h.totalQty > 0 ? h.totalCostSEK / h.totalQty : 0,
        totalCostSEK: h.totalCostSEK,
      }));

    return {
      year,
      disposals,
      income,
      summary: {
        totalTransactions: allTxns.length,
        totalDisposals:    disposals.length,
        totalGains,
        totalLosses,
        netGainLoss,
        taxableGain,
        deductibleLoss,
        estimatedTax,
        totalIncome,
      },
      currentHoldings,
    };
  }

  // ── K4 Export — SKV 2104 Section D (kryptovalutor) ───────
  /*
   * Generates a CSV that directly mirrors the K4 paper form (SKV 2104).
   * Crypto assets belong in Section D:
   *   "Övriga värdepapper, andra tillgångar — t.ex. råvaror, kryptovalutor"
   *
   * Each K4 form can hold 7 rows (Section D, rows 1–7).
   * If more than 7 disposals, the output is split across multiple K4 pages
   * (each with its own header, rows 1–7, and summary rows).
   *
   * Column order matches the printed form exactly:
   *   Antal/Belopp | Beteckning/Valutakod | Försäljningspris (SEK) | Omkostnadsbelopp (SEK) | Vinst | Förlust
   *
   * Transfer to Inkomstdeklaration 1:
   *   Summa vinst  → ruta 7.5
   *   Summa förlust → ruta 8.4 (70% avdragsgill, dvs × 0,70)
   */
  function generateK4CSV(result, userInfo = {}) {
    const { disposals, year } = result;
    const today = new Date().toLocaleDateString('sv-SE');
    const ROWS_PER_PAGE = 7;

    // Split into pages of 7
    const pages = [];
    for (let i = 0; i < Math.max(disposals.length, 1); i += ROWS_PER_PAGE) {
      pages.push(disposals.slice(i, i + ROWS_PER_PAGE));
    }

    const sections = [];

    // ── Global summary block at top ─────────────────────────
    const totalGains  = disposals.filter(d => d.gainLossSEK > 0).reduce((s, d) => s + d.gainLossSEK, 0);
    const totalLosses = disposals.filter(d => d.gainLossSEK < 0).reduce((s, d) => s + Math.abs(d.gainLossSEK), 0);

    sections.push([
      `; ═══════════════════════════════════════════════════════════════`,
      `; SKV 2104 — Försäljning Värdepapper m.m. — BILAGA K4`,
      `; Sektion D: Övriga tillgångar (kryptovalutor)`,
      `; Inkomstår:,${year}`,
      `; Datum:,${today}`,
      `; Framtagen av:,T-CMD Tax Calculator (Genomsnittsmetoden)`,
      userInfo.name        ? `; Namn:,${userInfo.name}` : '',
      userInfo.personnummer ? `; Personnummer:,${userInfo.personnummer}` : '',
      `; `,
      `; SAMMANFATTNING — för Inkomstdeklaration 1:`,
      `; Summa vinst  → ruta 7.5 på Inkomstdeklaration 1:,${Math.round(totalGains)} kr`,
      `; Summa förlust → ruta 8.4 (avdragsgill del 70%):,${Math.round(totalLosses * 0.70)} kr`,
      `; `,
      `; Antal avyttringar:,${disposals.length}`,
      `; Antal K4-blanketter:,${pages.length}`,
      `; ═══════════════════════════════════════════════════════════════`,
      ``,
    ].filter(l => l !== '').join('\n'));

    // ── One K4 page per 7 disposals ─────────────────────────
    pages.forEach((pageDisposals, pageIdx) => {
      const pageNum = pageIdx + 1;
      const isLastPage = pageIdx === pages.length - 1;

      // Partial sums for this page
      const pageGain  = pageDisposals.filter(d => d.gainLossSEK > 0).reduce((s, d) => s + d.gainLossSEK, 0);
      const pageLoss  = pageDisposals.filter(d => d.gainLossSEK < 0).reduce((s, d) => s + Math.abs(d.gainLossSEK), 0);
      const pageProc  = pageDisposals.reduce((s, d) => s + d.proceedsSEK, 0);
      const pageCost  = pageDisposals.reduce((s, d) => s + d.costBasisSEK, 0);

      const block = [];

      // Page header
      block.push(
        `; ─────────────────────────────────────────────────────────────`,
        `; K4 BLANKETT ${pageNum} av ${pages.length}  |  Inkomstår ${year}`,
        `; Sektion D — Övriga värdepapper/andra tillgångar (kryptovalutor)`,
        `; ─────────────────────────────────────────────────────────────`,
        `;`,
        `; D. Övriga värdepapper / andra tillgångar / kryptovalutor`,
        `;`,
      );

      // Column headers — exact match to K4 form Section D
      block.push(
        `Rad,` +
        `Antal/Belopp,` +
        `Beteckning/Valutakod,` +
        `Försäljningspris omräknat till svenska kronor,` +
        `Omkostnadsbelopp omräknat till svenska kronor,` +
        `Vinst,` +
        `Förlust`
      );

      // Rows 1–7 (pad with empty rows if fewer than 7)
      for (let row = 1; row <= ROWS_PER_PAGE; row++) {
        const d = pageDisposals[row - 1];
        if (d) {
          const gain = d.gainLossSEK > 0 ? Math.round(d.gainLossSEK) : '';
          const loss = d.gainLossSEK < 0 ? Math.round(Math.abs(d.gainLossSEK)) : '';
          // Beteckning: e.g. "BTC (kryptovaluta)" or "ETH/BTC byta (kryptovaluta)"
          const beteckning = d.isTrade
            ? `${d.assetSymbol} → ${d.inAsset || '?'} (kryptovaluta byte)`
            : `${d.assetSymbol} (kryptovaluta)`;
          block.push(
            `${row},` +
            `"${parseFloat(d.amountSold).toFixed(8)}",` +
            `"${beteckning}",` +
            `${Math.round(d.proceedsSEK)},` +
            `${Math.round(d.costBasisSEK)},` +
            `${gain},` +
            `${loss}`
          );
        } else {
          // Empty row placeholder
          block.push(`${row},,,,,,`);
        }
      }

      // Summary rows for this page (required on each K4 form)
      block.push(
        ``,
        `; SUMMERING (rad 1–7 på denna blankett):`,
        `; Summa vinst (Sektion D),,,${Math.round(pageProc)},${Math.round(pageCost)},${Math.round(pageGain)},`,
        `; Summa förlust (Sektion D),,,,,,${Math.round(pageLoss)}`,
      );

      // If last page, add the carry-forward instructions
      if (isLastPage) {
        block.push(
          ``,
          `; ─────────────────────────────────────────────────────────────`,
          `; TOTALBELOPP ATT FÖR ÖVER TILL INKOMSTDEKLARATION 1:`,
          `; ─────────────────────────────────────────────────────────────`,
          `; Summa vinst alla blanketter → ruta 7.5 på Inkomstdeklaration 1:,${Math.round(totalGains)} kr`,
          `; Summa förlust alla blanketter → ruta 8.4 på Inkomstdeklaration 1:,${Math.round(totalLosses)} kr`,
          `; Avdragsgill förlust (70% av förlust) → ruta 8.4:,${Math.round(totalLosses * 0.70)} kr`,
          `; ─────────────────────────────────────────────────────────────`,
          `; OBS! Belopp avrundas till hela kronor enligt Skatteverkets regler.`,
          `; Genomsnittsmetoden (SFS 1999:1229 44 kap. 7§) har använts.`,
        );
      }

      block.push('');
      sections.push(block.join('\n'));
    });

    return sections.join('\n');
  }

  function generateK4Summary(result) {
    const { disposals } = result;

    // Group: gains vs losses
    const gains  = disposals.filter(d => d.gainLossSEK >= 0);
    const losses = disposals.filter(d => d.gainLossSEK < 0);

    const sumProc = (arr) => arr.reduce((s, d) => s + d.proceedsSEK, 0);
    const sumCost = (arr) => arr.reduce((s, d) => s + d.costBasisSEK, 0);
    const sumGL   = (arr) => arr.reduce((s, d) => s + d.gainLossSEK, 0);

    return {
      box_d_gains: {
        proceeds:    sumProc(gains),
        costBasis:   sumCost(gains),
        gain:        sumGL(gains),
      },
      box_d_losses: {
        proceeds:    sumProc(losses),
        costBasis:   sumCost(losses),
        loss:        Math.abs(sumGL(losses)),
      },
      deductibleLoss: result.summary.deductibleLoss,
      // How many K4 forms needed
      formsNeeded: Math.max(1, Math.ceil(disposals.length / 7)),
    };
  }

  // ── Utility ───────────────────────────────────────────────
  function formatSEK(amt, decimals = 0) {
    if (amt === null || amt === undefined || isNaN(amt)) return '—';
    return new Intl.NumberFormat('sv-SE', {
      style: 'currency', currency: 'SEK',
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(amt);
  }

  function formatCrypto(amt, decimals = 6) {
    if (!amt && amt !== 0) return '—';
    return parseFloat(amt).toLocaleString('sv-SE', {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimals,
    });
  }

  // ── Available tax years ────────────────────────────────────
  function getAvailableTaxYears() {
    const txns = getTransactions();
    if (!txns.length) {
      const y = new Date().getFullYear();
      return [y - 1, y];
    }
    const years = [...new Set(txns.map(t => new Date(t.date).getFullYear()))].sort();
    // Add current year
    const cur = new Date().getFullYear();
    if (!years.includes(cur)) years.push(cur);
    return years;
  }

  // ── Public API ────────────────────────────────────────────
  return {
    // Settings
    getSettings, saveSettings,
    // Accounts
    getAccounts, saveAccounts, addAccount, removeAccount,
    // Transactions
    getTransactions, saveTransactions, addTransactions,
    deleteTransaction, updateTransaction,
    // Import
    parseBinanceCSV, parseKrakenCSV, parseBybitCSV, parseCoinbaseCSV, parseGenericCSV,
    importSolanaWallet, importEthWallet,
    normalizeTransaction,
    // Tax calculation
    computeTaxYear, generateK4CSV, generateK4Summary,
    // Helpers
    fetchHistoricalPrice, formatSEK, formatCrypto, getAvailableTaxYears,
    CATEGORIES,
  };
})();
