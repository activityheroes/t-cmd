/**
 * BundleDetector — 4-pattern bundle detection for meme-coin launches
 *
 * Patterns:
 *   1. Same Funder Bundle      — multiple early buyers funded by same wallet (Stage 2, Helius)
 *   2. Fixed-Size Buy Bundle   — identical/near-identical buy amounts (±2% tolerance)
 *   3. Same-Block/Burst Bundle — 4+ wallets in same block, or 6+ in 10-second window
 *   4. Staggered Insider Bundle— coordinated sells + suspiciously regular timing
 *
 * Stage 1: Fast screen using trade data only (Birdeye)
 * Stage 2: Deep funding-graph analysis (Helius — only if key present)
 *
 * Output: { bundle_risk_score 0-100, tier, detected_patterns[], clusters[],
 *           estimated_cluster_supply_pct, summary, stage }
 *
 * T-CMD · Trade Command
 */
const BundleDetector = (() => {

  // ── Pattern weights ───────────────────────────────────────────
  const W = {
    sameFunder:       50,   // Strongest — shared wallet funding = deliberate obfuscation
    sameBlock:        25,   // Same-block execution = on-chain coordination
    fixedBuySize:     15,   // Identical amounts = templated script
    burstTiming:      10,   // Burst within 10s = coordinated bots
    coordinatedSells: 20,   // Early buyers sell together = insider exit
    regularTiming:    10,   // Robotic interval = scripted launcher
    relatedFunding:   20    // Wallets created/funded around same time = pre-staged
  };

  // ── Risk tiers ────────────────────────────────────────────────
  function bundleTier(score) {
    if (score >= 80) return { label: 'Strong Bundle',  cls: 'bd-crit', color: '#ef4444', emoji: '🚨' };
    if (score >= 60) return { label: 'Likely Bundled', cls: 'bd-high', color: '#f59e0b', emoji: '⚠️' };
    if (score >= 40) return { label: 'Suspicious',     cls: 'bd-med',  color: '#3b82f6', emoji: '🔍' };
    return               { label: 'Low Risk',          cls: 'bd-low',  color: '#22c55e', emoji: '✅' };
  }

  // ── Helpers ───────────────────────────────────────────────────
  function short(a) {
    return a ? `${a.slice(0, 5)}…${a.slice(-4)}` : '?';
  }

  function pctMatch(a, b, tol = 0.02) {
    if (!a || !b || a === 0) return false;
    return Math.abs(a - b) / a <= tol;
  }

  // Get first maxMs milliseconds of buy-side trades, sorted oldest-first
  function getEarlyBuys(trades, maxMs = 300000) {
    const buys = trades
      .filter(t => (t.side || '').toLowerCase() === 'buy' && t.owner)
      .sort((a, b) => a.blockUnixTime - b.blockUnixTime);
    if (!buys.length) return [];
    const launchTs = buys[0].blockUnixTime * 1000;
    return maxMs > 0
      ? buys.filter(t => t.blockUnixTime * 1000 - launchTs <= maxMs)
      : buys;
  }

  // ── Pattern 2: Fixed-Size Buy Bundle ─────────────────────────
  function detectFixedSizeBuys(earlyBuys) {
    if (earlyBuys.length < 4) return null;

    // For a buy trade: 'from' is the quote spent (SOL/USDC), 'to' is the token received
    const withAmt = earlyBuys
      .map(t => ({
        owner:  t.owner,
        ts:     t.blockUnixTime,
        amount: t.from?.uiAmount || t.from?.amount || 0
      }))
      .filter(t => t.amount > 0);

    if (withAmt.length < 4) return null;

    // Group by amount within ±2% tolerance
    const groups = [];
    const used   = new Set();

    for (let i = 0; i < withAmt.length; i++) {
      if (used.has(i)) continue;
      const rep   = withAmt[i].amount;
      const group = [withAmt[i].owner];
      used.add(i);

      for (let j = i + 1; j < withAmt.length; j++) {
        if (used.has(j)) continue;
        if (pctMatch(rep, withAmt[j].amount)) {
          group.push(withAmt[j].owner);
          used.add(j);
        }
      }

      if (group.length >= 4) {
        groups.push({ amount: rep, wallets: group });
      }
    }

    if (!groups.length) return null;

    // Largest matching group
    const best   = groups.sort((a, b) => b.wallets.length - a.wallets.length)[0];
    const amtStr = best.amount < 0.001
      ? best.amount.toExponential(2)
      : best.amount.toFixed(4);

    return {
      pattern:    'fixedBuySize',
      wallets:    best.wallets,
      confidence: Math.min(100, 40 + best.wallets.length * 8),
      weight:     W.fixedBuySize,
      details:    `${best.wallets.length} wallets bought identical size (~${amtStr} ±2%)`
    };
  }

  // ── Pattern 3: Same-Block / Burst Timing ─────────────────────
  function detectSameBlockBurst(earlyBuys) {
    if (earlyBuys.length < 4) return null;

    const results = [];

    // ─ Same block: group by exact blockUnixTime ─
    const byBlock = {};
    earlyBuys.forEach(t => {
      if (!byBlock[t.blockUnixTime]) byBlock[t.blockUnixTime] = [];
      byBlock[t.blockUnixTime].push(t.owner);
    });

    const sameBlocks = Object.entries(byBlock)
      .filter(([, ws]) => ws.length >= 4)
      .sort((a, b) => b[1].length - a[1].length);

    if (sameBlocks.length > 0) {
      const [ts, ws]   = sameBlocks[0];
      const uniq        = [...new Set(ws)];
      results.push({
        pattern:    'sameBlock',
        wallets:    uniq,
        confidence: Math.min(100, 50 + uniq.length * 7),
        weight:     W.sameBlock,
        details:    `${uniq.length} wallets bought in the same block (block time ${ts})`
      });
    }

    // ─ Burst: 6+ unique wallets in any 10-second window ─
    const sorted = [...earlyBuys].sort((a, b) => a.blockUnixTime - b.blockUnixTime);
    let bestBurst = [];

    for (let i = 0; i < sorted.length; i++) {
      const windowEnd = sorted[i].blockUnixTime + 10;
      const inWin     = sorted.filter(t =>
        t.blockUnixTime >= sorted[i].blockUnixTime &&
        t.blockUnixTime <= windowEnd
      );
      const uniq = [...new Set(inWin.map(t => t.owner))];
      if (uniq.length >= 6 && uniq.length > bestBurst.length) {
        bestBurst = uniq;
      }
    }

    if (bestBurst.length >= 6) {
      results.push({
        pattern:    'burstTiming',
        wallets:    bestBurst,
        confidence: Math.min(100, 40 + bestBurst.length * 6),
        weight:     W.burstTiming,
        details:    `${bestBurst.length} unique wallets bought within a 10-second burst at launch`
      });
    }

    return results.length > 0 ? results : null;
  }

  // ── Pattern 4: Staggered Insider (Stage 1 partial) ───────────
  function detectStaggeredInsider(trades, earlyBuys) {
    if (earlyBuys.length < 5) return null;

    const results           = [];
    const earlyBuyWallets   = new Set(earlyBuys.map(t => t.owner));

    // ─ Coordinated sells: early buyers that sold in a tight 5-min window ─
    const sells = trades.filter(t =>
      (t.side || '').toLowerCase() === 'sell' && earlyBuyWallets.has(t.owner)
    );

    if (sells.length >= 3) {
      const byWindow = {};
      sells.forEach(t => {
        const bucket = Math.floor(t.blockUnixTime / 300); // 5-min buckets
        if (!byWindow[bucket]) byWindow[bucket] = [];
        byWindow[bucket].push(t.owner);
      });

      const bigWindows = Object.entries(byWindow)
        .filter(([, ws]) => ws.length >= 3)
        .sort((a, b) => b[1].length - a[1].length);

      if (bigWindows.length > 0) {
        const [, ws] = bigWindows[0];
        const uniq    = [...new Set(ws)];
        results.push({
          pattern:    'coordinatedSells',
          wallets:    uniq,
          confidence: Math.min(100, 35 + uniq.length * 10),
          weight:     W.coordinatedSells,
          details:    `${uniq.length} early buyers executed coordinated sells in the same 5-min window`
        });
      }
    }

    // ─ Robotic interval: suspiciously regular buy timing ─
    if (earlyBuys.length >= 6) {
      const uniqTs = [...new Set(earlyBuys.map(t => t.blockUnixTime))].sort((a, b) => a - b);
      if (uniqTs.length >= 5) {
        const gaps   = [];
        for (let i = 1; i < uniqTs.length; i++) gaps.push(uniqTs[i] - uniqTs[i - 1]);
        const avg    = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        const stdDev = Math.sqrt(gaps.reduce((a, g) => a + (g - avg) ** 2, 0) / gaps.length);
        const cv     = avg > 0 ? stdDev / avg : 1; // coefficient of variation

        // Very low CV + fast pace = robotic launcher
        if (cv < 0.35 && avg >= 1 && avg <= 15 && uniqTs.length >= 6) {
          const robotWallets = [...new Set(earlyBuys.map(t => t.owner))];
          results.push({
            pattern:    'regularTiming',
            wallets:    robotWallets,
            confidence: Math.min(100, Math.round((1 - cv) * 85)),
            weight:     W.regularTiming,
            details:    `${robotWallets.length} wallets bought at robotic regular intervals (avg ${avg.toFixed(1)}s, regularity ${((1 - cv) * 100).toFixed(0)}%)`
          });
        }
      }
    }

    return results.length > 0 ? results : null;
  }

  // ── Pattern 1: Same Funder (Stage 2 — Helius) ────────────────
  async function detectSameFunder(earlyWallets, launchTs) {
    const { helius } = ChainAPIs.getKeys();
    if (!helius || !earlyWallets.length) return null;

    const walletsToCheck = earlyWallets.slice(0, 20);
    const fundersMap     = new Map(); // funder → Set<wallet>
    const BATCH          = 4;

    for (let i = 0; i < walletsToCheck.length; i += BATCH) {
      const batch = walletsToCheck.slice(i, i + BATCH);
      await Promise.all(batch.map(async wallet => {
        try {
          const txns = await ChainAPIs.heliusTxns(wallet, 20, 'TRANSFER');
          if (!Array.isArray(txns)) return;

          // Look for inbound SOL transfers before/around token launch (within 24h prior)
          const cutoff = launchTs - 86400;
          txns.forEach(t => {
            if (t.timestamp && t.timestamp > launchTs + 3600) return; // after 1h post-launch skip
            (t.nativeTransfers || []).forEach(tr => {
              if (
                tr.toUserAccount   === wallet &&
                tr.fromUserAccount &&
                (tr.amount || 0) > 0.01e9 // > 0.01 SOL
              ) {
                if (!fundersMap.has(tr.fromUserAccount)) fundersMap.set(tr.fromUserAccount, new Set());
                fundersMap.get(tr.fromUserAccount).add(wallet);
              }
            });
          });
        } catch (_) {}
      }));
    }

    // Find funders that funded 3+ different wallets
    let bestFunder  = null;
    let bestWallets = [];

    for (const [funder, wallets] of fundersMap) {
      const arr = [...wallets];
      if (arr.length >= 3 && arr.length > bestWallets.length) {
        bestFunder  = funder;
        bestWallets = arr;
      }
    }

    if (!bestFunder) return null;

    return {
      pattern:    'sameFunder',
      wallets:    bestWallets,
      funder:     bestFunder,
      confidence: Math.min(100, 55 + bestWallets.length * 8),
      weight:     W.sameFunder,
      details:    `${bestWallets.length} early buyers were all funded by the same wallet (${short(bestFunder)})`
    };
  }

  // ── Related Funding: wallets created/first-funded near same time (Helius) ──
  async function detectRelatedFunding(earlyWallets, launchTs) {
    const { helius } = ChainAPIs.getKeys();
    if (!helius || earlyWallets.length < 4) return null;

    const walletsToCheck = earlyWallets.slice(0, 15);
    const firstTxTimes   = [];
    const BATCH          = 5;

    for (let i = 0; i < walletsToCheck.length; i += BATCH) {
      const batch = walletsToCheck.slice(i, i + BATCH);
      await Promise.all(batch.map(async wallet => {
        try {
          // Get oldest transaction = wallet creation / first funding
          const res = await ChainAPIs.heliusRPC('getSignaturesForAddress', [
            wallet,
            { limit: 5, commitment: 'confirmed' }
          ]);
          const sigs = res?.result;
          if (!sigs?.length) return;
          const oldest = sigs[sigs.length - 1]; // Solana returns newest-first
          if (oldest?.blockTime) {
            firstTxTimes.push({ wallet, firstTs: oldest.blockTime });
          }
        } catch (_) {}
      }));
    }

    if (firstTxTimes.length < 4) return null;

    // Find wallets created/funded within 1h of each other, before launch
    const prelaunch = firstTxTimes.filter(f => f.firstTs < launchTs + 3600);
    if (prelaunch.length < 4) return null;

    prelaunch.sort((a, b) => a.firstTs - b.firstTs);

    // Sliding 60-minute window → find biggest co-created group
    let bestGroup = [];
    for (let i = 0; i < prelaunch.length; i++) {
      const windowEnd = prelaunch[i].firstTs + 3600;
      const group     = prelaunch.filter(f =>
        f.firstTs >= prelaunch[i].firstTs && f.firstTs <= windowEnd
      );
      if (group.length > bestGroup.length) bestGroup = group;
    }

    if (bestGroup.length < 4) return null;

    const wallets = bestGroup.map(f => f.wallet);
    return {
      pattern:    'relatedFunding',
      wallets,
      confidence: Math.min(100, 25 + wallets.length * 8),
      weight:     W.relatedFunding,
      details:    `${wallets.length} early buyers were created/funded within 1h of each other before launch`
    };
  }

  // ── Supply estimation from top-holders list ───────────────────
  function estimateClusterSupply(clusterWallets, holdersData) {
    const items = holdersData?.items;
    if (!items?.length || !clusterWallets?.length) return 0;

    const addrSet = new Set(clusterWallets.map(w => w.toLowerCase()));
    const total   = items.reduce((s, h) => s + (h.ui_amount || h.uiAmount || h.amount || 0), 0);
    if (total === 0) return 0;

    const clusterAmt = items
      .filter(h => addrSet.has((h.address || '').toLowerCase()))
      .reduce((s, h) => s + (h.ui_amount || h.uiAmount || h.amount || 0), 0);

    return parseFloat(((clusterAmt / total) * 100).toFixed(1));
  }

  // ── Score aggregation ─────────────────────────────────────────
  function computeScore(patterns) {
    if (!patterns.length) return 0;
    let totalW = 0, weightedConf = 0;
    patterns.forEach(p => {
      const w = p.weight || 5;
      const c = Math.min(p.confidence || 0, 100);
      weightedConf += w * c;
      totalW       += w;
    });
    return totalW > 0 ? Math.min(100, Math.round(weightedConf / totalW)) : 0;
  }

  // ── Main entry ────────────────────────────────────────────────
  /**
   * analyze(tokenAddress, chain)
   * → { success, bundle_risk_score, tier, detected_patterns, clusters,
   *     estimated_cluster_supply_pct, summary, stage, early_buyers_analyzed }
   */
  async function analyze(tokenAddress, chain) {
    if (!tokenAddress) return { success: false, reason: 'No token address', bundle_risk_score: 0 };

    // Fetch trades + holders in parallel
    const [tradesRes, holdersRes] = await Promise.all([
      ChainAPIs.beTrades(tokenAddress, chain || 'solana', 100),
      ChainAPIs.beTopHolders(tokenAddress, chain || 'solana', 20)
    ]);

    const trades     = tradesRes?.data?.items || [];
    const holdersData = holdersRes?.data || null;

    if (!trades.length) {
      return {
        success:                     false,
        reason:                      'No trade data — add Birdeye API key for bundle analysis',
        bundle_risk_score:           0,
        detected_patterns:           [],
        clusters:                    [],
        estimated_cluster_supply_pct: 0,
        summary:                     'Bundle analysis requires Birdeye API key',
        tier:                        bundleTier(0),
        stage:                       0
      };
    }

    // Early buys = first 5 minutes of trading
    const earlyBuys    = getEarlyBuys(trades, 300000);
    const launchTs     = earlyBuys.length > 0 ? earlyBuys[0].blockUnixTime : Math.floor(Date.now() / 1000);
    const earlyWallets = [...new Set(earlyBuys.map(t => t.owner))];

    // ── Stage 1: Fast screen ────────────────────────────────────
    const s1Patterns = [];

    const fixedSize = detectFixedSizeBuys(earlyBuys);
    if (fixedSize) s1Patterns.push(fixedSize);

    const blockBurst = detectSameBlockBurst(earlyBuys);
    if (blockBurst) {
      Array.isArray(blockBurst) ? s1Patterns.push(...blockBurst) : s1Patterns.push(blockBurst);
    }

    const staggered = detectStaggeredInsider(trades, earlyBuys);
    if (staggered) {
      Array.isArray(staggered) ? s1Patterns.push(...staggered) : s1Patterns.push(staggered);
    }

    let allPatterns = [...s1Patterns];
    let stage       = 1;

    // ── Stage 2: Helius funding traces ──────────────────────────
    const { helius } = ChainAPIs.getKeys();
    if (helius && earlyWallets.length >= 3) {
      stage = 2;
      try {
        const [sameFunder, relatedFunding] = await Promise.all([
          detectSameFunder(earlyWallets, launchTs),
          detectRelatedFunding(earlyWallets, launchTs)
        ]);
        if (sameFunder)     allPatterns.push(sameFunder);
        if (relatedFunding) allPatterns.push(relatedFunding);
      } catch (e) {
        console.warn('[BundleDetector] Stage 2 error:', e.message);
      }
    }

    // ── Build clusters ──────────────────────────────────────────
    const allClusterWallets = [...new Set(allPatterns.flatMap(p => p.wallets || []))];
    const clusterSupplyPct  = estimateClusterSupply(allClusterWallets, holdersData);
    const clusters          = allClusterWallets.length > 0 ? [{
      wallets:    allClusterWallets,
      patterns:   allPatterns.map(p => p.pattern),
      supply_pct: clusterSupplyPct
    }] : [];

    const score = computeScore(allPatterns);
    const t     = bundleTier(score);

    // ── Summary ─────────────────────────────────────────────────
    let summary;
    if (allPatterns.length === 0) {
      summary = 'No bundle patterns detected in early trading window';
    } else {
      const walletCount = allClusterWallets.length;
      const supplyStr   = clusterSupplyPct > 0 ? ` (~${clusterSupplyPct}% supply)` : '';
      summary = `${t.emoji} ${t.label}: ${allPatterns.length} pattern${allPatterns.length !== 1 ? 's' : ''} across ${walletCount} wallet${walletCount !== 1 ? 's' : ''}${supplyStr}`;
    }

    return {
      success:                     true,
      bundle_risk_score:           score,
      tier:                        t,
      detected_patterns:           allPatterns,
      clusters,
      estimated_cluster_supply_pct: clusterSupplyPct,
      early_buyers_analyzed:       earlyBuys.length,
      summary,
      stage
    };
  }

  return { analyze, bundleTier };
})();
