/**
 * RugChecker — 12-signal rug risk analysis engine
 * Inputs  : token address + chain (auto-detects chain via DexScreener)
 * Outputs : { rugRiskScore 0-100, signals{}, pair, sec, analyzedAt }
 *
 * Data sources:
 *   DexScreener — market data (price, liquidity, volume, MC, price history)
 *   Birdeye     — token security (mint/freeze authority, LP lock, holders, taxes)
 *   Helius      — Solana on-chain (creator wallet, transaction history)
 *   localStorage — local rug deployer DB (grows over time)
 *
 * T-CMD · Trade Command
 */
const RugChecker = (() => {

  // ── Signal weights ────────────────────────────────────────────
  // Critical (LP removable, mintable, blacklist, tax): heavy
  // Medium   (concentration, low liq, wash trading): medium
  // Rep/ownership: medium-high
  const WEIGHTS = {
    devHoldings:          8,   // Medium
    lpNotLocked:         15,   // CRITICAL ★
    mintExists:          14,   // CRITICAL ★
    blacklist:           12,   // CRITICAL ★
    adjustableTax:       11,   // CRITICAL ★
    lowLiquidity:         7,   // Medium
    holderConcentration:  8,   // Medium
    liquidityRemoved:    12,   // CRITICAL ★
    washTrading:          7,   // Medium
    repeatWallets:        5,   // Low
    devPriorRugs:        10,   // Medium-High
    ownershipActive:      8    // Medium-High
  };
  const TOTAL_WEIGHT = Object.values(WEIGHTS).reduce((a, b) => a + b, 0); // 107

  // ── Local rug deployer DB ─────────────────────────────────────
  const RUG_DB_KEY = 'tcmd_rug_deployers';

  function getRugDb() {
    try { return JSON.parse(localStorage.getItem(RUG_DB_KEY) || '[]'); } catch { return []; }
  }

  function addToRugDb(deployer, tokenAddress, reason) {
    if (!deployer) return;
    const db = getRugDb();
    const existing = db.find(r => r.deployer?.toLowerCase() === deployer.toLowerCase());
    if (existing) {
      if (!existing.tokens.includes(tokenAddress)) existing.tokens.push(tokenAddress);
    } else {
      db.push({ deployer, tokens: [tokenAddress], reason, addedAt: Date.now() });
    }
    try { localStorage.setItem(RUG_DB_KEY, JSON.stringify(db.slice(-500))); } catch {}
  }

  // ── Helpers ───────────────────────────────────────────────────
  function flag(severity, reason) { return { flagged: true,  severity: Math.round(severity), reason }; }
  function pass(reason)           { return { flagged: false, severity: 0,                    reason }; }
  function skip(reason)           { return { flagged: false, severity: 0,                    reason, skipped: true }; }

  function short(addr) {
    if (!addr) return '?';
    return addr.length > 12 ? `${addr.slice(0, 5)}…${addr.slice(-4)}` : addr;
  }

  function fmtUsd(n) {
    if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
    return `$${Number(n).toFixed(0)}`;
  }

  /**
   * Normalize a Birdeye percentage field.
   * Most percentage fields come as 0–1 decimal (e.g. 0.05 = 5%).
   * A handful (lpLockedPercentage, lpBurntPercentage) come as 0–100.
   * Pass `alreadyPct = true` for the latter.
   */
  function normPct(val, alreadyPct = false) {
    if (val === null || val === undefined || isNaN(val)) return 0;
    const n = parseFloat(val);
    if (alreadyPct) return n;
    return n > 1 ? n : n * 100; // treat values > 1 as already a percentage
  }

  // ── SIGNAL 1 — Developer wallet large share ───────────────────
  function checkDevHoldings(ctx) {
    const { sec } = ctx;
    if (!sec) return skip('No creator data — add Birdeye API key');

    // creatorPercentage is 0–1 decimal in Birdeye
    const creatorPct = normPct(sec.creatorPercentage);
    const ownerPct   = normPct(sec.ownerPercentage);
    const pct        = Math.max(creatorPct, ownerPct);
    const addr       = sec.creatorAddress || sec.ownerAddress;

    if (pct > 20) return flag(100, `Dev/creator holds ${pct.toFixed(1)}% of supply (${short(addr)}) — extreme rug risk`);
    if (pct > 10) return flag(80,  `Dev/creator holds ${pct.toFixed(1)}% — high concentration`);
    if (pct > 5)  return flag(45,  `Dev/creator holds ${pct.toFixed(1)}% — elevated, watch closely`);
    if (pct > 0)  return pass(`Dev/creator holds ${pct.toFixed(2)}% — within safe range`);
    return pass('No significant dev wallet holdings detected');
  }

  // ── SIGNAL 2 — LP not locked / removable ──────────────────────
  function checkLPLocked(ctx) {
    const { sec, pair } = ctx;

    if (sec) {
      // lpLockedPercentage and lpBurntPercentage come as 0–100
      const locked = normPct(sec.lpLockedPercentage, true);
      const burnt  = normPct(sec.lpBurntPercentage,  true);
      const safe   = Math.min(locked + burnt, 100);

      if (safe >= 95) return pass(`${safe.toFixed(0)}% of LP is locked or burnt — very safe`);
      if (safe >= 75) return flag(25,  `${safe.toFixed(0)}% of LP locked/burnt — mostly safe`);
      if (safe >= 50) return flag(50,  `Only ${safe.toFixed(0)}% of LP locked/burnt — partial risk`);
      if (safe >= 20) return flag(75,  `Only ${safe.toFixed(0)}% of LP locked/burnt — high removability`);
      return flag(100, `Only ${safe.toFixed(0)}% of LP locked/burnt — LP removable at any time!`);
    }

    // Fallback: thin liquidity = easy rug even without lock data
    const liqUsd = pair?.liquidity?.usd || 0;
    if (liqUsd < 500)  return flag(90, 'Essentially no liquidity and no lock data — trivial rug');
    if (liqUsd < 5000) return flag(65, `Only ${fmtUsd(liqUsd)} liquidity — lock status unknown`);
    return skip('LP lock status unknown — Birdeye API key needed');
  }

  // ── SIGNAL 3 — Mint function / expandable supply ──────────────
  function checkMintExists(ctx) {
    const { sec, chain } = ctx;
    if (!sec) return skip('No contract data — add Birdeye API key');

    const isSolana = !chain || chain === 'solana';

    if (isSolana) {
      const mintAuth   = sec.mintAuthority;
      const isMintable = mintAuth && mintAuth !== 'null' && mintAuth !== '';

      if (isMintable) {
        return flag(95, `Mint authority active (${short(mintAuth)}) — supply can be inflated at will`);
      }
      // Token-2022: transfer fee is extractive even without explicit mint
      if (sec.isToken2022 && sec.transferFeeEnable) {
        const fp  = sec.transferFeeData?.transferFeeBasisPoints || 0;
        const pct = fp / 100;
        if (pct > 0) return flag(60, `Token-2022 transfer fee: ${pct.toFixed(1)}% — value extracted on every tx`);
        return flag(40, 'Token-2022 with transfer fee enabled — rate can be raised by authority');
      }
      return pass('No mint authority — supply is fixed and safe');
    }

    // EVM
    if (sec.mintable === true)  return flag(95, 'Contract is mintable — owner can inflate supply');
    if (sec.mintable === false) return pass('Contract is not mintable');
    return skip('EVM mint check requires ABI — unavailable without contract API');
  }

  // ── SIGNAL 4 — Blacklist / trading restriction ────────────────
  function checkBlacklist(ctx) {
    const { sec, chain } = ctx;
    if (!sec) return skip('No contract data — add Birdeye API key');

    const isSolana = !chain || chain === 'solana';

    if (isSolana) {
      const freezeAuth = sec.freezeAuthority;
      const freezeable = sec.freezeable;

      if (freezeAuth && freezeAuth !== 'null' && freezeAuth !== '') {
        return flag(90, `Freeze authority active (${short(freezeAuth)}) — any wallet can be frozen/blocked from selling`);
      }
      if (freezeable === true) {
        return flag(75, 'Token accounts are freezeable — trading can be restricted per address');
      }
      return pass('No freeze authority — cannot blacklist wallets');
    }

    // EVM: GoPlus / Birdeye flags
    if (sec.isBlacklisted === true || sec.hasBlacklist === true || sec.canBlacklist === true) {
      return flag(90, 'Contract has blacklist function — owner can block wallet from selling');
    }
    if (sec.tradingCooldown === true) {
      return flag(55, 'Trading cooldown function — owner can pause trading');
    }
    return pass('No blacklist or trading restriction detected');
  }

  // ── SIGNAL 5 — Adjustable transaction taxes ───────────────────
  function checkAdjustableTax(ctx) {
    const { sec, pair } = ctx;

    let buyTax  = 0;
    let sellTax = 0;
    let source  = '';

    // Birdeye Token-2022 transfer fee
    if (sec?.isToken2022 && sec.transferFeeEnable) {
      const fp  = sec.transferFeeData?.transferFeeBasisPoints || 0;
      const pct = fp / 100;
      if (pct > 15) return flag(95, `Token-2022 transfer fee: ${pct.toFixed(1)}% — honeypot-level extraction`);
      if (pct > 10) return flag(80, `Token-2022 transfer fee: ${pct.toFixed(1)}% — very high, adjustable`);
      if (pct > 5)  return flag(55, `Token-2022 transfer fee: ${pct.toFixed(1)}% — elevated, adjustable by authority`);
      if (pct > 0)  return flag(30, `Token-2022 transfer fee: ${pct.toFixed(1)}% — low but can be raised anytime`);
      return flag(35, 'Token-2022 with transfer fee enabled (currently 0%) — can be raised by authority');
    }

    // From DexScreener pair info (EVM pairs sometimes include tax data)
    if (pair?.info?.taxes) {
      buyTax  = parseFloat(pair.info.taxes.buy)  || 0;
      sellTax = parseFloat(pair.info.taxes.sell) || 0;
      source  = 'DexScreener';
    }

    // EVM Birdeye flags
    if (sec?.buyTax !== undefined)  buyTax  = Math.max(buyTax,  parseFloat(sec.buyTax)  || 0);
    if (sec?.sellTax !== undefined) sellTax = Math.max(sellTax, parseFloat(sec.sellTax) || 0);

    const maxTax = Math.max(buyTax, sellTax);
    if (maxTax > 15) return flag(95, `Tax ${buyTax.toFixed(0)}%/${sellTax.toFixed(0)}% buy/sell — honeypot territory`);
    if (maxTax > 10) return flag(75, `Tax ${buyTax.toFixed(0)}%/${sellTax.toFixed(0)}% buy/sell — very high`);
    if (maxTax > 5)  return flag(45, `Tax ${buyTax.toFixed(0)}%/${sellTax.toFixed(0)}% buy/sell — elevated`);
    if (maxTax > 0)  return pass(`Tax ${buyTax.toFixed(1)}%/${sellTax.toFixed(1)}% buy/sell — within normal range`);

    // EVM: check if fees are adjustable even if currently 0
    if (sec?.canChangeFee === true || sec?.feeSettable === true) {
      return flag(50, 'Tax setter function exists — owner can raise fees after launch');
    }

    return pass('No significant transaction tax detected');
  }

  // ── SIGNAL 6 — Very low liquidity vs market cap ───────────────
  function checkLowLiquidity(ctx) {
    const { pair } = ctx;
    if (!pair) return skip('No DEX pair data');

    const liqUsd = pair.liquidity?.usd || 0;
    const fdv    = pair.fdv || pair.marketCap || 0;

    if (liqUsd < 500)  return flag(100, `Liquidity is only ${fmtUsd(liqUsd)} — near-zero depth`);
    if (liqUsd < 2000) return flag(85,  `Only ${fmtUsd(liqUsd)} liquidity — trivially thin`);

    if (fdv > 0) {
      const ratio = (liqUsd / fdv) * 100;
      if (ratio < 1)   return flag(90, `Liq/MC: ${ratio.toFixed(2)}% — price collapses with tiny sells`);
      if (ratio < 3)   return flag(65, `Liq/MC: ${ratio.toFixed(2)}% — very thin vs market cap`);
      if (ratio < 7)   return flag(35, `Liq/MC: ${ratio.toFixed(1)}% — below healthy 7% threshold`);
      return pass(`Liq/MC: ${ratio.toFixed(1)}% — reasonable depth (${fmtUsd(liqUsd)} vs ${fmtUsd(fdv)} MC)`);
    }

    if (liqUsd < 10000) return flag(45, `${fmtUsd(liqUsd)} liquidity — low depth (no MC data)`);
    return pass(`${fmtUsd(liqUsd)} liquidity`);
  }

  // ── SIGNAL 7 — Top holders concentration ──────────────────────
  function checkHolderConcentration(ctx) {
    const { sec, holdersData } = ctx;

    // Primary: Birdeye security top10HolderPercent (0–1 decimal)
    if (sec?.top10HolderPercent !== undefined && sec.top10HolderPercent !== null) {
      const top10 = normPct(sec.top10HolderPercent);
      if (top10 > 70) return flag(95, `Top 10 holders control ${top10.toFixed(1)}% of supply — extreme bundling`);
      if (top10 > 50) return flag(80, `Top 10 holders control ${top10.toFixed(1)}% — massive concentration`);
      if (top10 > 35) return flag(55, `Top 10 holders control ${top10.toFixed(1)}% — notable concentration`);
      if (top10 > 20) return flag(25, `Top 10 holders control ${top10.toFixed(1)}% — mild concentration`);
      return pass(`Top 10 holders control ${top10.toFixed(1)}% — healthy distribution`);
    }

    // Fallback: compute from full holders list
    const items = holdersData?.items;
    if (items?.length) {
      const totalAmt = items.reduce((s, h) => s + (h.ui_amount || h.amount || 0), 0);
      if (totalAmt === 0) return skip('Could not compute holder distribution');

      const top10Amt = items.slice(0, 10).reduce((s, h) => s + (h.ui_amount || h.amount || 0), 0);
      const pct      = (top10Amt / totalAmt) * 100;

      if (pct > 70) return flag(95, `Top 10 hold ${pct.toFixed(1)}% — extreme concentration`);
      if (pct > 50) return flag(80, `Top 10 hold ${pct.toFixed(1)}% — high concentration`);
      if (pct > 35) return flag(55, `Top 10 hold ${pct.toFixed(1)}% — notable`);
      return pass(`Top 10 hold ${pct.toFixed(1)}% — reasonable distribution`);
    }

    return skip('Holder data unavailable — add Birdeye API key');
  }

  // ── SIGNAL 8 — Liquidity suddenly removed ─────────────────────
  async function checkLiquidityRemoved(ctx) {
    const { tokenAddress, chain, pair } = ctx;

    // Hard DexScreener price-change signals
    const h1  = parseFloat(pair?.priceChange?.h1)  || 0;
    const h6  = parseFloat(pair?.priceChange?.h6)  || 0;
    const h24 = parseFloat(pair?.priceChange?.h24) || 0;
    const liqUsd = pair?.liquidity?.usd || 0;

    // Try Birdeye 1-hour price history for finer resolution
    const now       = Math.floor(Date.now() / 1000);
    const oneHrAgo  = now - 3600;
    const history   = await ChainAPIs.bePriceHistory(tokenAddress, chain || 'solana', oneHrAgo, now);
    const items     = history?.data?.items;

    if (items?.length >= 3) {
      const prices   = items.map(i => i.value).filter(v => v > 0);
      const peakIdx  = prices.indexOf(Math.max(...prices));
      const lastPx   = prices[prices.length - 1];
      const peakPx   = prices[peakIdx];
      const dropPct  = peakPx > 0 ? ((peakPx - lastPx) / peakPx) * 100 : 0;

      if (dropPct > 85) return flag(98, `Price crashed ${dropPct.toFixed(0)}% from peak in 1h — rug in progress`);
      if (dropPct > 60) return flag(80, `Price down ${dropPct.toFixed(0)}% from 1h peak — likely LP removal`);
      if (dropPct > 40) return flag(55, `Price dropped ${dropPct.toFixed(0)}% from peak — suspicious`);
    }

    // Fallback to DexScreener % changes
    if (h1  < -75 && liqUsd < 5000) return flag(95, `Price −${Math.abs(h1).toFixed(0)}% in 1h + thin liq — active rug`);
    if (h1  < -60)                  return flag(75, `Price −${Math.abs(h1).toFixed(0)}% in last hour — suspicious`);
    if (h6  < -85 && liqUsd < 10000) return flag(85, `Price −${Math.abs(h6).toFixed(0)}% in 6h + low liq — rug likely`);
    if (h24 < -90 && liqUsd < 5000)  return flag(80, `Price −${Math.abs(h24).toFixed(0)}% in 24h + near-zero liq — rugged`);

    return pass('No sudden liquidity removal signal detected');
  }

  // ── SIGNAL 9 — High volume, very few unique traders ───────────
  function checkWashTrading(ctx) {
    const { tradesData, pair } = ctx;

    const vol24  = pair?.volume?.h24 || 0;
    const mc     = pair?.fdv || pair?.marketCap || 0;

    if (!tradesData?.items?.length) {
      // Ratio-only fallback
      if (mc > 0 && vol24 / mc > 5) {
        return flag(55, `Vol/MC ${(vol24 / mc).toFixed(1)}x — suspicious but no trade detail (add Birdeye key)`);
      }
      return skip('No trade data — add Birdeye API key for wash-trade detection');
    }

    const trades        = tradesData.items;
    const uniqueSet     = new Set(trades.map(t => t.owner || t.source || t.wallet).filter(Boolean));
    const uniqueTraders = uniqueSet.size;
    const totalTrades   = trades.length;
    const volMcRatio    = mc > 0 ? vol24 / mc : 0;

    const avgPerWallet  = totalTrades / (uniqueTraders || 1);

    if (uniqueTraders < 10 && vol24 > 5000) {
      return flag(95, `Only ${uniqueTraders} unique traders generating ${fmtUsd(vol24)} — strong wash trade signal`);
    }
    if (uniqueTraders < 25 && volMcRatio > 3) {
      return flag(80, `${uniqueTraders} traders, ${volMcRatio.toFixed(1)}× vol/MC — highly coordinated volume`);
    }
    if (uniqueTraders < 50 && volMcRatio > 1) {
      return flag(45, `${uniqueTraders} unique traders for this volume level — low diversity`);
    }
    if (avgPerWallet > 8) {
      return flag(40, `Avg ${avgPerWallet.toFixed(1)} trades/wallet — very few wallets generating most volume`);
    }

    return pass(`${uniqueTraders} unique traders — volume appears organic`);
  }

  // ── SIGNAL 10 — Same wallets trading repeatedly ───────────────
  function checkRepeatWallets(ctx) {
    const { tradesData } = ctx;
    if (!tradesData?.items?.length) return skip('No trade data available');

    const trades = tradesData.items;

    // Trades per wallet
    const walletTradeCount = {};
    const walletSides = {};
    trades.forEach(t => {
      const w = t.owner || t.source || t.wallet;
      if (!w) return;
      walletTradeCount[w] = (walletTradeCount[w] || 0) + 1;
      if (!walletSides[w]) walletSides[w] = { buys: 0, sells: 0, times: [] };
      const side = t.side || t.type || '';
      if (side === 'buy')  walletSides[w].buys++;
      else                 walletSides[w].sells++;
      if (t.blockUnixTime) walletSides[w].times.push(t.blockUnixTime * 1000);
    });

    const sorted    = Object.entries(walletTradeCount).sort((a, b) => b[1] - a[1]);
    const top5Trades = sorted.slice(0, 5).reduce((s, [, c]) => s + c, 0);
    const top5Pct    = (top5Trades / trades.length) * 100;

    // Detect buy→sell cyclers
    const cyclers = Object.entries(walletSides).filter(([, v]) => v.buys >= 2 && v.sells >= 2);

    // Quick-flip detection (sells within 5 min of buys, based on time deltas)
    let quickFlips = 0;
    Object.values(walletSides).forEach(w => {
      const times = w.times.sort();
      for (let i = 1; i < times.length; i++) {
        if (times[i] - times[i - 1] < 300000) quickFlips++; // <5 min between trades
      }
    });

    if (top5Pct > 65 && cyclers.length >= 3) {
      return flag(90, `Top 5 wallets = ${top5Pct.toFixed(0)}% of trades; ${cyclers.length} wallets in buy/sell loops`);
    }
    if (top5Pct > 55) {
      return flag(60, `Top 5 wallets account for ${top5Pct.toFixed(0)}% of all trades — high concentration`);
    }
    if (cyclers.length >= 5) {
      return flag(55, `${cyclers.length} wallets repeatedly cycling buy→sell`);
    }
    if (quickFlips > 20) {
      return flag(40, `${quickFlips} sub-5-minute trades detected — possible bot/wash activity`);
    }

    return pass(`Trade distribution appears organic (top 5 wallets = ${top5Pct.toFixed(0)}%)`);
  }

  // ── SIGNAL 11 — Developer wallet linked to prior rugs ─────────
  async function checkDevPriorRugs(ctx) {
    const { sec, tokenAddress, chain } = ctx;
    const deployer = sec?.creatorAddress || sec?.ownerAddress;
    if (!deployer) return skip('No deployer address — cannot check history');

    // 1. Check our local DB
    const rugDb   = getRugDb();
    const dbMatch = rugDb.find(r => r.deployer?.toLowerCase() === deployer.toLowerCase());
    if (dbMatch) {
      return flag(100, `Deployer ${short(deployer)} has ${dbMatch.tokens.length} previous rug(s) in T-CMD database`);
    }

    // 2. For Solana: check how many tokens the deployer has created via Helius
    const isSolana = !chain || chain === 'solana';
    if (isSolana && ChainAPIs.getKeys().helius) {
      const txns = await ChainAPIs.heliusTxns(deployer, 50);
      if (Array.isArray(txns)) {
        // Look for token mint/creation events
        const mintTxns = txns.filter(t =>
          t.type === 'TOKEN_MINT'           ||
          t.type === 'CREATE_ACCOUNT'       ||
          t.type === 'INITIALIZE_MINT'      ||
          (t.description || '').toLowerCase().includes('mint') ||
          (t.description || '').toLowerCase().includes('creat')
        );

        const otherTokens = [...new Set(
          mintTxns
            .map(t => t.tokenTransfers?.[0]?.mint || t.accountData?.[0]?.account)
            .filter(a => a && a !== tokenAddress)
        )];

        if (otherTokens.length >= 8) {
          return flag(85, `Deployer ${short(deployer)} created ${otherTokens.length}+ other tokens — serial launcher`);
        }
        if (otherTokens.length >= 3) {
          return flag(45, `Deployer ${short(deployer)} created ${otherTokens.length} other tokens — check their history`);
        }
      }
    }

    return pass(`Deployer ${short(deployer)} has no rug history in our database`);
  }

  // ── SIGNAL 12 — Ownership not renounced ──────────────────────
  function checkOwnership(ctx) {
    const { sec, chain } = ctx;
    if (!sec) return skip('No contract data — add Birdeye API key');

    const isSolana = !chain || chain === 'solana';

    if (isSolana) {
      const updateAuth   = sec.metaplexUpdateAuthority;
      const mutable      = sec.mutableMetadata;
      const mintAuth     = sec.mintAuthority;
      const freezeAuth   = sec.freezeAuthority;

      const activeDangerPerms = [mintAuth, freezeAuth].filter(a => a && a !== 'null' && a !== '');

      if (mutable && updateAuth && activeDangerPerms.length > 0) {
        return flag(90, `Metadata mutable + ${activeDangerPerms.length} active dangerous authority/ies — full owner control`);
      }
      if (mutable && updateAuth) {
        return flag(40, `Metadata mutable (controlled by ${short(updateAuth)}) — name/image/links can change`);
      }
      if (!mutable && activeDangerPerms.length === 0) {
        return pass('Metadata immutable, no dangerous authorities — effectively renounced');
      }
      return pass('No unrenounced dangerous permissions detected');
    }

    // EVM
    const ZERO = '0x0000000000000000000000000000000000000000';
    const DEAD  = '0x000000000000000000000000000000000000dead';
    const owner = (sec.ownerAddress || '').toLowerCase();

    if (!owner || owner === ZERO.toLowerCase() || owner === DEAD.toLowerCase()) {
      return pass('Ownership renounced — zero/dead address is owner');
    }
    if (sec.ownershipRenounced === true) {
      return pass('Ownership renounced per Birdeye security data');
    }
    return flag(70, `Ownership NOT renounced — ${short(sec.ownerAddress)} still controls contract`);
  }

  // ── SCORING ────────────────────────────────────────────────────
  function computeScore(signals) {
    let weightedSum = 0;
    let usedWeight  = 0;
    for (const [key, result] of Object.entries(signals)) {
      if (!result || result.skipped) continue; // don't penalise missing data
      const w  = WEIGHTS[key] || 5;
      const sv = Math.min(result.severity || 0, 100);
      weightedSum += w * sv;
      usedWeight  += w;
    }
    return usedWeight > 0 ? Math.round(weightedSum / usedWeight) : 0;
  }

  // ── MAIN ENTRY ─────────────────────────────────────────────────
  /**
   * analyzeToken(tokenAddress, chainOverride?)
   * → { rugRiskScore, signals, pair, sec, chain, tokenAddress, analyzedAt }
   */
  async function analyzeToken(tokenAddress, chainOverride = null) {
    if (!tokenAddress) throw new Error('Token address required');

    // 1. Auto-discover chain + pair from DexScreener
    const dexData = await ChainAPIs.dsToken(tokenAddress);
    const pairs   = dexData?.pairs || [];
    const pair    = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] || null;
    const chain   = chainOverride || pair?.chainId || 'solana';

    // 2. Fetch Birdeye security, holders, trades in parallel
    const [secRes, holdersRes, tradesRes] = await Promise.all([
      ChainAPIs.beTokenSecurity(tokenAddress, chain),
      ChainAPIs.beTopHolders(tokenAddress, chain, 20),
      ChainAPIs.beTrades(tokenAddress, chain, 100)
    ]);

    const sec        = secRes?.data    || null;
    const holdersData = holdersRes?.data || null;
    const tradesData  = tradesRes?.data  || null;

    const ctx = { tokenAddress, chain, pair, dexData, sec, holdersData, tradesData };

    // 3. Run all 12 signals (sync + async)
    const [
      devHoldings, lpNotLocked, mintExists, blacklist, adjustableTax,
      lowLiquidity, holderConcentration, liquidityRemoved,
      washTrading, repeatWallets, devPriorRugs, ownershipActive
    ] = await Promise.all([
      Promise.resolve(checkDevHoldings(ctx)),
      Promise.resolve(checkLPLocked(ctx)),
      Promise.resolve(checkMintExists(ctx)),
      Promise.resolve(checkBlacklist(ctx)),
      Promise.resolve(checkAdjustableTax(ctx)),
      Promise.resolve(checkLowLiquidity(ctx)),
      Promise.resolve(checkHolderConcentration(ctx)),
      checkLiquidityRemoved(ctx),   // async: price history
      Promise.resolve(checkWashTrading(ctx)),
      Promise.resolve(checkRepeatWallets(ctx)),
      checkDevPriorRugs(ctx),       // async: Helius tx history
      Promise.resolve(checkOwnership(ctx))
    ]);

    const signals = {
      devHoldings, lpNotLocked, mintExists, blacklist, adjustableTax,
      lowLiquidity, holderConcentration, liquidityRemoved,
      washTrading, repeatWallets, devPriorRugs, ownershipActive
    };

    const rugRiskScore = computeScore(signals);

    // Auto-record high-risk deployers for future checks
    const deployer = sec?.creatorAddress || sec?.ownerAddress;
    if (deployer && rugRiskScore >= 75) {
      addToRugDb(deployer, tokenAddress, `Auto-flagged score ${rugRiskScore} on ${new Date().toISOString().slice(0, 10)}`);
    }

    return { tokenAddress, chain, rugRiskScore, signals, pair, sec, analyzedAt: Date.now() };
  }

  return { analyzeToken, WEIGHTS, TOTAL_WEIGHT, getRugDb, addToRugDb };
})();
