/**
 * MomentumDetector — Early Momentum Analysis for meme coin launches
 * Analyzes the first 5–30 minutes after launch to detect 10–100× runners.
 *
 * 7 Base Signals + 5 Advanced Signals → Momentum Score 0-100
 * 💎 GEM flag if score ≥ 75
 *
 * Data sources:
 *   DexScreener — price, volume, liquidity, buy pressure (always available)
 *   Birdeye     — unique buyers, holder distribution, trade history (if key set)
 *   WalletTracker — smart wallet cross-reference (local DB)
 *
 * Target: < 2s per token analysis
 * T-CMD · Trade Command
 */
const MomentumDetector = (() => {

  // ── Weight tables ──────────────────────────────────────────
  // Base signals: use available DexScreener + Birdeye data
  const BASE_W = {
    holderGrowth:   20,
    uniqueBuyers:   20,
    liquidity:      15,
    distribution:   15,
    volumeGrowth:   15,
    buyPressure:    10,
    socialActivity:  5
  };
  const BASE_TOTAL = 100; // weights sum to 100

  // Advanced signals: strong bonus indicators (added to base, capped at 100)
  const ADV_W = {
    smartWalletInflow:  25,
    liquidityStability: 15,
    holderVelocity:     20,
    whaleAbsence:       15,
    buyWallFormation:   10
  };

  // Gem thresholds
  const GEM_SCORE    = 75;
  const HIGH_SCORE   = 60;
  const MEDIUM_SCORE = 35;

  // Cache to avoid duplicate API calls (cleared each scan batch)
  const _cache = new Map();

  // ── Helpers ────────────────────────────────────────────────
  function sig(active, score, reason) { return { active, score: Math.round(score), reason }; }
  function fmtU(n) {
    if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
    return `$${Number(n || 0).toFixed(0)}`;
  }

  // ── BASE SIGNAL 1 — Rapid holder count growth ──────────────
  function computeHolderGrowth(token, overviewData, trades) {
    // Primary: Birdeye overview holderCount + launch age
    const holders = overviewData?.holder || overviewData?.holders || 0;
    const ageMin  = token.createdAt ? (Date.now() - token.createdAt) / 60000 : 60;
    const buys24h = token.txns?.h24?.buys || 0;

    if (holders > 0 && ageMin > 0) {
      const ratePerMin = holders / Math.max(ageMin, 1);
      if (ratePerMin > 10 && holders > 150) return sig(true,  95, `${holders} holders in ${Math.round(ageMin)}m — ${ratePerMin.toFixed(1)}/min growth`);
      if (ratePerMin > 5  && holders > 50)  return sig(true,  75, `${holders} holders, ${ratePerMin.toFixed(1)}/min growth rate`);
      if (holders > 50)                     return sig(true,  50, `${holders} holders — decent early distribution`);
      return sig(false, 15, `Only ${holders} holders so far`);
    }

    // Proxy: buys in 24h as holder count estimate
    if (buys24h > 500) return sig(true,  80, `${buys24h} buy txns — strong organic demand`);
    if (buys24h > 200) return sig(true,  55, `${buys24h} buy txns in 24h`);
    if (buys24h > 50)  return sig(false, 30, `${buys24h} buy txns — moderate interest`);
    return sig(false, 10, `Low buy activity (${buys24h} txns)`);
  }

  // ── BASE SIGNAL 2 — Steady growth in unique buyers ─────────
  function computeUniqueBuyers(token, trades) {
    if (!trades?.length) {
      // Fallback: use DexScreener txns as proxy
      const h1Buys = token.txns?.h1?.buys || 0;
      const m5Buys = Math.round((token.volume?.m5 || 0) / Math.max(token.priceUSD || 0.001, 0.000001) * 0.01);
      if (h1Buys > 200) return sig(true,  80, `${h1Buys} buy txns/hr — high unique activity`);
      if (h1Buys > 80)  return sig(true,  55, `${h1Buys} buy txns/hr`);
      if (h1Buys > 20)  return sig(false, 30, `${h1Buys} buy txns/hr — early stage`);
      return sig(false, 10, 'Low buyer activity — add Birdeye key for detail');
    }

    // Birdeye trade data: count unique buyer wallets in different time windows
    const now     = Date.now();
    const win1m   = trades.filter(t => (now - (t.blockUnixTime || 0) * 1000) < 60000    && (t.side === 'buy' || t.type === 'buy'));
    const win5m   = trades.filter(t => (now - (t.blockUnixTime || 0) * 1000) < 300000   && (t.side === 'buy' || t.type === 'buy'));
    const win10m  = trades.filter(t => (now - (t.blockUnixTime || 0) * 1000) < 600000   && (t.side === 'buy' || t.type === 'buy'));

    const unique1m  = new Set(win1m.map(t => t.owner || t.wallet)).size;
    const unique5m  = new Set(win5m.map(t => t.owner || t.wallet)).size;
    const unique10m = new Set(win10m.map(t => t.owner || t.wallet)).size;

    // Check if growing (minute1 < minute5 < minute10 unique buyers)
    const isGrowing = unique5m > unique1m && unique10m > unique5m;

    if (isGrowing && unique10m > 80)  return sig(true,  95, `${unique1m}→${unique5m}→${unique10m} unique buyers (1m/5m/10m) — viral growth`);
    if (isGrowing && unique10m > 30)  return sig(true,  70, `${unique10m} unique buyers in 10m — steady growth`);
    if (unique5m > 20)                return sig(true,  50, `${unique5m} unique buyers in 5m`);
    if (unique5m > 5)                 return sig(false, 25, `Only ${unique5m} unique buyers so far`);
    return sig(false, 10, 'Very few unique buyers detected');
  }

  // ── BASE SIGNAL 3 — Liquidity strength ─────────────────────
  function computeLiquidity(token) {
    const liq = token.liquidity || 0;
    if (liq >= 200000) return sig(true,  100, `${fmtU(liq)} liquidity — institutional-grade launch`);
    if (liq >= 100000) return sig(true,   90, `${fmtU(liq)} liquidity — strong launch depth`);
    if (liq >= 50000)  return sig(true,   75, `${fmtU(liq)} liquidity — solid backing`);
    if (liq >= 20000)  return sig(true,   55, `${fmtU(liq)} liquidity — decent depth`);
    if (liq >= 10000)  return sig(false,  30, `${fmtU(liq)} liquidity — below average`);
    return sig(false, 5, `Only ${fmtU(liq)} liquidity — very thin`);
  }

  // ── BASE SIGNAL 4 — Balanced distribution ──────────────────
  function computeDistribution(token, holdersData, secData) {
    // From Birdeye security
    const top10Pct = secData ? ((secData.top10HolderPercent || 0) > 1
      ? secData.top10HolderPercent
      : (secData.top10HolderPercent || 0) * 100) : null;
    const creatorPct = secData ? ((secData.creatorPercentage || 0) > 1
      ? secData.creatorPercentage
      : (secData.creatorPercentage || 0) * 100) : null;

    if (top10Pct !== null) {
      if (top10Pct < 15 && (creatorPct || 0) < 3) return sig(true,  100, `Top 10 hold ${top10Pct.toFixed(1)}% — near-perfect distribution`);
      if (top10Pct < 25 && (creatorPct || 0) < 5) return sig(true,   80, `Top 10 hold ${top10Pct.toFixed(1)}%, creator ${(creatorPct||0).toFixed(1)}%`);
      if (top10Pct < 40)                           return sig(true,   50, `Top 10 hold ${top10Pct.toFixed(1)}% — moderate concentration`);
      if (top10Pct < 60)                           return sig(false,  25, `Top 10 hold ${top10Pct.toFixed(1)}% — high concentration risk`);
      return sig(false, 5, `Top 10 hold ${top10Pct.toFixed(1)}% — whale-dominated`);
    }

    // Fallback: FDV/MC ratio as distribution proxy
    const fdv = token.fdv || 0;
    const mc  = token.mktCap || 0;
    if (fdv > 0 && mc > 0) {
      const ratio = fdv / mc;
      if (ratio < 1.2) return sig(true,  70, 'Low FDV/MC ratio — supply well distributed');
      if (ratio < 3)   return sig(false, 35, `FDV/MC = ${ratio.toFixed(1)}× — some locked/unvested supply`);
      return sig(false, 10, `FDV/MC = ${ratio.toFixed(1)}× — large unlocked supply risk`);
    }
    return sig(false, 40, 'Distribution data unavailable — add Birdeye key');
  }

  // ── BASE SIGNAL 5 — Volume accelerating ────────────────────
  function computeVolumeGrowth(token) {
    const vol5m  = token.volume?.m5  || 0;
    const vol1h  = token.volume?.h1  || 0;
    const vol24h = token.volume?.h24 || 0;

    // Compare 5-min rate to 1h per-minute average
    const v5mRate   = vol5m / 5;    // per minute
    const v1hRate   = vol1h / 60;   // per minute
    const v24hRate  = vol24h / 1440;

    const accel5v1 = v1hRate > 0 ? v5mRate / v1hRate : 1;
    const accel1v24 = v24hRate > 0 ? v1hRate / v24hRate : 1;

    if (accel5v1 > 5 && vol5m > 50000)  return sig(true,  100, `Vol 5m: ${fmtU(vol5m)} — ${accel5v1.toFixed(0)}× vs 1h avg — EXPLODING`);
    if (accel5v1 > 3 && vol5m > 10000)  return sig(true,   85, `Vol 5m: ${fmtU(vol5m)} — ${accel5v1.toFixed(0)}× acceleration`);
    if (accel5v1 > 2)                   return sig(true,   65, `Volume accelerating ${accel5v1.toFixed(1)}× vs hourly rate`);
    if (accel1v24 > 3 && vol1h > 5000)  return sig(true,   60, `Last 1h vol ${fmtU(vol1h)} — ${accel1v24.toFixed(0)}× vs daily avg`);
    if (vol5m > 5000)                   return sig(false,  35, `${fmtU(vol5m)} in 5m — moderate activity`);
    return sig(false, 10, 'Low volume acceleration');
  }

  // ── BASE SIGNAL 6 — Strong buy pressure ────────────────────
  function computeBuyPressure(token, trades) {
    let buyRatio = 0;
    let source   = '';

    if (trades?.length) {
      const buys  = trades.filter(t => t.side === 'buy' || t.type === 'buy').length;
      const total = trades.length;
      buyRatio = total > 0 ? buys / total : 0;
      source   = `from ${total} recent trades`;
    } else {
      // DexScreener txns fallback
      const buys  = token.txns?.h24?.buys  || 0;
      const sells = token.txns?.h24?.sells || 0;
      const total = buys + sells;
      buyRatio = total > 0 ? buys / total : 0;
      source   = '24h txns';
    }

    if (buyRatio >= 0.80) return sig(true,  100, `Buy ratio: ${(buyRatio*100).toFixed(0)}% (${source}) — extremely bullish`);
    if (buyRatio >= 0.70) return sig(true,   85, `Buy ratio: ${(buyRatio*100).toFixed(0)}% — strong demand`);
    if (buyRatio >= 0.60) return sig(true,   65, `Buy ratio: ${(buyRatio*100).toFixed(0)}% — more buyers than sellers`);
    if (buyRatio >= 0.50) return sig(false,  35, `Buy ratio: ${(buyRatio*100).toFixed(0)}% — balanced`);
    return sig(false, 10, `Buy ratio: ${(buyRatio*100).toFixed(0)}% — sell pressure`);
  }

  // ── BASE SIGNAL 7 — Social activity ────────────────────────
  function computeSocialActivity(token) {
    const socialsCount  = (token.socials  || []).length;
    const websiteCount  = (token.websites || []).length;
    const boostAmt      = token.boostAmount || 0;
    let score = 0;
    const reasons = [];

    if (socialsCount >= 2) { score += 40; reasons.push(`${socialsCount} social channels`); }
    else if (socialsCount === 1) { score += 20; reasons.push('1 social channel'); }
    if (websiteCount >= 1) { score += 20; reasons.push('has website'); }
    if (boostAmt > 1000) { score += 40; reasons.push(`${boostAmt} boost — heavily promoted`); }
    else if (boostAmt > 500) { score += 25; reasons.push(`${boostAmt} boost`); }
    else if (boostAmt > 100) { score += 15; reasons.push(`${boostAmt} boost`); }

    score = Math.min(score, 100);
    const active = score >= 40;
    return sig(active, score, active ? `Social presence: ${reasons.join(', ')}` : `Minimal social presence (${socialsCount} social, ${boostAmt} boost)`);
  }

  // ── ADVANCED SIGNAL 1 — Smart wallet inflow ────────────────
  function computeSmartWalletInflow(trades) {
    if (!trades?.length) return sig(false, 0, 'No trade data — add Birdeye key');

    // Get wallets from WalletTracker (admin-saved smart wallets)
    let knownSmartWallets = new Set();
    try {
      if (typeof WalletTracker !== 'undefined') {
        const tracked = WalletTracker._loadLocal?.() || [];
        tracked.forEach(w => { if (w.address) knownSmartWallets.add(w.address.toLowerCase()); });
      }
    } catch {}

    if (knownSmartWallets.size === 0) return sig(false, 0, 'No smart wallets tracked — add wallets in Whales & Wallets');

    const earlyBuyers = [...new Set(
      trades.filter(t => t.side === 'buy' || t.type === 'buy').map(t => (t.owner || t.wallet || '').toLowerCase())
    )];
    const smartBuys = earlyBuyers.filter(w => knownSmartWallets.has(w));

    if (smartBuys.length >= 5)  return sig(true,  100, `${smartBuys.length} tracked smart wallets bought early — very strong`);
    if (smartBuys.length >= 3)  return sig(true,   85, `${smartBuys.length} smart wallets in early buyers`);
    if (smartBuys.length >= 1)  return sig(true,   55, `${smartBuys.length} tracked wallet entered early`);
    return sig(false, 10, 'No tracked smart wallets in early buyers');
  }

  // ── ADVANCED SIGNAL 2 — Liquidity stability ────────────────
  function computeLiquidityStability(token) {
    const h1Change  = parseFloat(token.priceChange?.h1  || 0);
    const h6Change  = parseFloat(token.priceChange?.h6  || 0);
    const liq       = token.liquidity || 0;

    // Stable liquidity = price not crashing + liquidity > threshold
    if (liq >= 20000 && h1Change > -15 && h6Change > -30) {
      return sig(true,  100, `Liquidity stable (${fmtU(liq)}, price ${h1Change >= 0 ? '+' : ''}${h1Change.toFixed(0)}% 1h)`);
    }
    if (liq >= 10000 && h1Change > -30) {
      return sig(true,   65, `Liq ${fmtU(liq)} — minor volatility (${h1Change.toFixed(0)}% 1h)`);
    }
    if (h1Change < -50 || h6Change < -70) {
      return sig(false,  0, `Price crashed ${h1Change.toFixed(0)}% in 1h — possible rug`);
    }
    return sig(false, 25, `Liq ${fmtU(liq)} — unstable or low depth`);
  }

  // ── ADVANCED SIGNAL 3 — Holder velocity (viral distribution) ─
  function computeHolderVelocity(token, overviewData) {
    const holders = overviewData?.holder || overviewData?.holders || 0;
    const ageMin  = token.createdAt ? (Date.now() - token.createdAt) / 60000 : 60;

    if (holders <= 0 || ageMin <= 0) return sig(false, 0, 'Holder velocity data unavailable — add Birdeye key');

    const velocity = holders / Math.max(ageMin, 1); // holders per minute

    if (velocity > 20)  return sig(true,  100, `${velocity.toFixed(0)} new holders/min — going viral`);
    if (velocity > 15)  return sig(true,   90, `${velocity.toFixed(1)} holders/min — very fast spread`);
    if (velocity > 8)   return sig(true,   70, `${velocity.toFixed(1)} holders/min — strong distribution`);
    if (velocity > 3)   return sig(true,   45, `${velocity.toFixed(1)} holders/min — moderate growth`);
    return sig(false, 15, `${velocity.toFixed(2)} holders/min — slow distribution`);
  }

  // ── ADVANCED SIGNAL 4 — Whale absence ─────────────────────
  function computeWhaleAbsence(token, secData) {
    const creatorPct  = secData ? ((secData.creatorPercentage || 0) > 1 ? secData.creatorPercentage : (secData.creatorPercentage || 0) * 100) : null;
    const top10Pct    = secData ? ((secData.top10HolderPercent || 0) > 1 ? secData.top10HolderPercent : (secData.top10HolderPercent || 0) * 100) : null;

    if (creatorPct !== null && top10Pct !== null) {
      if (creatorPct < 2 && top10Pct < 20) return sig(true,  100, `Creator: ${creatorPct.toFixed(1)}%, top10: ${top10Pct.toFixed(1)}% — ideal distribution`);
      if (creatorPct < 4 && top10Pct < 28) return sig(true,   75, `No dominant whale — creator ${creatorPct.toFixed(1)}%`);
      if (creatorPct < 8 && top10Pct < 40) return sig(false,  40, `Moderate concentration — creator ${creatorPct.toFixed(1)}%`);
      return sig(false, 5, `High concentration — creator ${creatorPct.toFixed(1)}%, top10 ${top10Pct.toFixed(1)}%`);
    }
    return sig(false, 0, 'Whale data unavailable — add Birdeye key');
  }

  // ── ADVANCED SIGNAL 5 — Buy wall formation ────────────────
  function computeBuyWall(token, trades) {
    let buyVol = 0, sellVol = 0;

    if (trades?.length) {
      const now = Date.now();
      trades.filter(t => (now - (t.blockUnixTime || 0) * 1000) < 300000).forEach(t => {
        const v = parseFloat(t.volumeUsd || t.volume || t.quoteAmount || 0);
        if (t.side === 'buy' || t.type === 'buy') buyVol += v;
        else sellVol += v;
      });
    } else {
      // DexScreener proxy: assume buy pressure ratio × vol5m
      const ratio = (token.txns?.h24?.buys || 0) / Math.max((token.txns?.h24?.buys || 0) + (token.txns?.h24?.sells || 0), 1);
      buyVol  = (token.volume?.m5 || 0) * ratio;
      sellVol = (token.volume?.m5 || 0) * (1 - ratio);
    }

    const total       = buyVol + sellVol;
    const buyPressure = total > 0 ? buyVol / sellVol : 0; // buy/sell ratio

    if (buyPressure >= 4) return sig(true,  100, `Buy pressure: ${buyPressure.toFixed(1)}× sells — massive buy wall`);
    if (buyPressure >= 2) return sig(true,   80, `Buy pressure: ${buyPressure.toFixed(1)}× sells — strong wall`);
    if (buyPressure >= 1.5) return sig(true, 55, `Buy volume ${buyPressure.toFixed(1)}× sell volume`);
    if (buyPressure >= 1)   return sig(false, 25, 'Balanced buy/sell pressure');
    return sig(false, 5, 'Sell pressure exceeds buys');
  }

  // ── Score computation ──────────────────────────────────────
  function computeScore(base, advanced) {
    // Base score (0-100)
    let baseScore = 0;
    let baseDivisor = 0;
    for (const [key, s] of Object.entries(base)) {
      const w = BASE_W[key] || 0;
      if (s.score === 0 && !s.active) continue; // skip completely missing data
      baseScore  += w * (s.score / 100);
      baseDivisor += w;
    }
    const normalizedBase = baseDivisor > 0 ? (baseScore / baseDivisor) * 100 : 0;

    // Advanced bonus (0-30 extra points)
    let advBonus = 0;
    for (const [key, s] of Object.entries(advanced)) {
      if (!s.active || s.score === 0) continue;
      const w = ADV_W[key] || 0;
      advBonus += (w / 100) * (s.score / 100) * 25; // max +25 from all advanced
    }

    return Math.min(Math.round(normalizedBase + advBonus), 100);
  }

  // ── Main analysis ──────────────────────────────────────────
  /**
   * analyze(token, pair?)
   * token: scanner token object (has .address, .chainId, .volume, .liquidity etc.)
   * pair:  optional DexScreener pair object (same data as token mostly)
   * → { momentumScore, label, isGem, signals, advanced, analyzedAt }
   */
  async function analyze(token) {
    if (!token?.address) return empty();

    const cacheKey = `${token.address}_${Math.floor(Date.now() / 120000)}`; // 2-min cache
    if (_cache.has(cacheKey)) return _cache.get(cacheKey);

    try {
      const chain = token.chainId || 'solana';

      // Fetch Birdeye data in parallel (gracefully degrades if no key)
      const [tradesRes, holdersRes, secRes, overviewRes] = await Promise.all([
        ChainAPIs.beTrades(token.address, chain, 100).catch(() => null),
        ChainAPIs.beTopHolders(token.address, chain, 20).catch(() => null),
        ChainAPIs.beTokenSecurity(token.address, chain).catch(() => null),
        ChainAPIs.beTokenOverview(token.address, chain).catch(() => null)
      ]);

      const trades      = tradesRes?.data?.items    || [];
      const holdersData = holdersRes?.data?.items   || [];
      const secData     = secRes?.data              || null;
      const overviewData = overviewRes?.data        || null;

      // ── Base signals ───────────────────────────────────────
      const signals = {
        holderGrowth:   computeHolderGrowth(token, overviewData, trades),
        uniqueBuyers:   computeUniqueBuyers(token, trades),
        liquidity:      computeLiquidity(token),
        distribution:   computeDistribution(token, holdersData, secData),
        volumeGrowth:   computeVolumeGrowth(token),
        buyPressure:    computeBuyPressure(token, trades),
        socialActivity: computeSocialActivity(token)
      };

      // ── Advanced signals ───────────────────────────────────
      const advanced = {
        smartWalletInflow:  computeSmartWalletInflow(trades),
        liquidityStability: computeLiquidityStability(token),
        holderVelocity:     computeHolderVelocity(token, overviewData),
        whaleAbsence:       computeWhaleAbsence(token, secData),
        buyWallFormation:   computeBuyWall(token, trades)
      };

      const momentumScore = computeScore(signals, advanced);
      const isGem         = momentumScore >= GEM_SCORE;
      const label         = momentumScore >= HIGH_SCORE   ? 'HIGH POTENTIAL' :
                            momentumScore >= MEDIUM_SCORE ? 'MEDIUM'         : 'LOW MOMENTUM';

      // Acceleration metric
      const volAccel     = (token.volume?.m5 || 0) / 5 / Math.max((token.volume?.h1 || 1) / 60, 0.001);
      const holderVelNum = (overviewData?.holder || 0) / Math.max((Date.now() - (token.createdAt || Date.now())) / 60000, 1);

      const result = {
        momentumScore,
        label,
        isGem,
        signals,
        advanced,
        acceleration: {
          volumeAccel: parseFloat(volAccel.toFixed(2)),
          holderVelocity: parseFloat(holderVelNum.toFixed(2))
        },
        activeSignalCount: Object.values(signals).filter(s => s.active).length +
                           Object.values(advanced).filter(s => s.active).length,
        analyzedAt: Date.now()
      };

      _cache.set(cacheKey, result);
      // Auto-clear cache after 5 minutes
      setTimeout(() => _cache.delete(cacheKey), 300000);

      return result;

    } catch (err) {
      console.warn('[MomentumDetector]', token.symbol, err.message);
      return empty();
    }
  }

  function empty() {
    return { momentumScore: 0, label: 'LOW MOMENTUM', isGem: false, signals: {}, advanced: {}, analyzedAt: Date.now() };
  }

  function clearCache() { _cache.clear(); }

  // Metadata for UI rendering
  const SIGNAL_META = [
    { key: 'holderGrowth',       icon: '👥', label: 'Holder Growth',       group: 'base' },
    { key: 'uniqueBuyers',       icon: '🛒', label: 'Unique Buyers',        group: 'base' },
    { key: 'liquidity',          icon: '💧', label: 'Liquidity Depth',      group: 'base' },
    { key: 'distribution',       icon: '📊', label: 'Token Distribution',   group: 'base' },
    { key: 'volumeGrowth',       icon: '📈', label: 'Volume Acceleration',  group: 'base' },
    { key: 'buyPressure',        icon: '🟢', label: 'Buy Pressure',         group: 'base' },
    { key: 'socialActivity',     icon: '📣', label: 'Social Activity',      group: 'base' },
    { key: 'smartWalletInflow',  icon: '🧠', label: 'Smart Wallet Inflow',  group: 'advanced' },
    { key: 'liquidityStability', icon: '🔒', label: 'Liquidity Stability',  group: 'advanced' },
    { key: 'holderVelocity',     icon: '🚀', label: 'Holder Velocity',      group: 'advanced' },
    { key: 'whaleAbsence',       icon: '🐳', label: 'Whale-Free Launch',    group: 'advanced' },
    { key: 'buyWallFormation',   icon: '🧱', label: 'Buy Wall Formation',   group: 'advanced' }
  ];

  return { analyze, clearCache, SIGNAL_META, GEM_SCORE, HIGH_SCORE, MEDIUM_SCORE };
})();

window.MomentumDetector = MomentumDetector;
