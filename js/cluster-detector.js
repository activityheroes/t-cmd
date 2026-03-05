/**
 * ClusterDetector — wallet cluster / bundle / cabal detection
 * Identifies groups of wallets likely controlled by the same person/team
 * around a new meme coin launch.
 *
 * Catches:
 *   • bundled launches  (dev splits supply across many wallets)
 *   • cabal/insider groups
 *   • wash trading rings
 *   • coordinated buy/sell dumps
 *
 * Data sources: Birdeye (trades), Helius (funding source tracking)
 * T-CMD · Trade Command
 */
const ClusterDetector = (() => {

  // ── Configuration ─────────────────────────────────────────────
  const CFG = {
    earlyWindowMinutes:   15,    // analyse first N minutes after launch
    earlyBlockWindow:      3,    // or first N blocks
    idAmountTolerance:   0.01,   // ±1% = "identical" buy size
    syncWindowSecs:       20,    // ≤20s between buys = synchronized
    funderWindowMins:     60,    // funding must happen ≤60 min before buy
    minClusterSize:        3,    // need ≥3 wallets to be a cluster
    maxEarlyWallets:      60,    // performance cap
    batchSize:             5     // Helius funding-source batch
  };

  // ── Main entry ────────────────────────────────────────────────
  /**
   * analyze(tokenAddress, chain?, pairAddress?)
   * → {
   *     success, tokenAddress, chain, launchTime,
   *     earlyWalletCount, totalSwapsAnalyzed,
   *     clusters: [{ wallets, confidence, reasons, stats }],
   *     clusterRiskScore
   *   }
   */
  async function analyze(tokenAddress, chain = 'solana', pairAddress = null) {
    try {
      // Step 1: collect swap events
      const allSwaps = await collectSwaps(tokenAddress, chain, pairAddress);
      if (!allSwaps.length) return empty('No swap data found — add Birdeye/Helius API keys');

      // Step 2: identify launch time = earliest swap
      const launchTs = Math.min(...allSwaps.map(s => s.timestamp));

      // Step 3: filter to early window
      const earlySwaps = allSwaps.filter(s =>
        (s.timestamp - launchTs) <= CFG.earlyWindowMinutes * 60 * 1000
      );
      if (earlySwaps.length < 2) return empty('Too few early swaps to analyse clusters');

      // Step 4: build per-wallet summary
      const walletMap = buildWalletMap(earlySwaps, launchTs);
      const earlyWallets = Object.values(walletMap)
        .filter(w => w.buys.length > 0)
        .slice(0, CFG.maxEarlyWallets);

      if (earlyWallets.length < 2) return empty('Too few unique wallets to cluster');

      // Step 5: enrich with funding sources via Helius (Solana only)
      const isSolana = !chain || chain === 'solana';
      if (isSolana && ChainAPIs.getKeys().helius) {
        await enrichFundingSources(earlyWallets);
      }

      // Step 6: detect per-wallet patterns
      detectCyclers(earlyWallets, allSwaps);

      // Step 7: build link matrix
      const links     = buildLinks(earlyWallets, launchTs);

      // Step 8: union-find clustering
      const rawClusters = unionFind(earlyWallets, links);

      // Step 9: compute stats + filter by min size
      const totalBuyTokens = earlySwaps
        .filter(s => s.side === 'buy')
        .reduce((s, sw) => s + (sw.tokenAmount || 0), 0);

      const totalEarlyNative = earlySwaps
        .filter(s => s.side === 'buy')
        .reduce((s, sw) => s + (sw.nativeAmount || 0), 0);

      const clusters = rawClusters
        .filter(c => c.wallets.length >= CFG.minClusterSize)
        .map(c => computeStats(c, earlyWallets, totalBuyTokens, totalEarlyNative, launchTs))
        .sort((a, b) => b.confidence - a.confidence);

      const clusterRiskScore = clusters.length
        ? Math.max(...clusters.map(c => c.confidence))
        : 0;

      return {
        success: true,
        tokenAddress,
        chain,
        launchTime:          launchTs,
        earlyWalletCount:    earlyWallets.length,
        totalSwapsAnalyzed:  earlySwaps.length,
        clusters,
        clusterRiskScore,
        analyzedAt: Date.now()
      };

    } catch (err) {
      console.error('[ClusterDetector]', err);
      return empty(`Analysis error: ${err.message}`);
    }
  }

  // ── Swap collection ───────────────────────────────────────────
  async function collectSwaps(tokenAddress, chain, pairAddress) {
    const swaps = [];
    const seen  = new Set(); // dedup by txHash

    // A: Birdeye trade history (primary for all chains)
    const tradesRes = await ChainAPIs.beTrades(tokenAddress, chain, 100);
    const beTrades  = tradesRes?.data?.items || [];

    beTrades.forEach(t => {
      const wallet    = t.owner || t.wallet || t.source;
      const side      = t.side || (t.type === 'buy' ? 'buy' : 'sell');
      const timestamp = t.blockUnixTime ? t.blockUnixTime * 1000 : (t.timestamp || Date.now());
      const nativeAmt = parseFloat(t.volumeNative || t.quoteAmount || 0);
      const tokenAmt  = parseFloat(t.tokenAmount  || t.baseAmount  || 0);
      const hash      = t.txHash || t.signature;

      if (wallet && hash && !seen.has(hash)) {
        seen.add(hash);
        swaps.push({ wallet, side, timestamp, nativeAmount: nativeAmt, tokenAmount: tokenAmt, txHash: hash, slot: t.slot || null });
      }
    });

    // B: Helius enhanced transactions on the pair address (Solana, better resolution)
    if ((!chain || chain === 'solana') && ChainAPIs.getKeys().helius && pairAddress) {
      const hl = await ChainAPIs.heliusTxns(pairAddress, 100, 'SWAP');
      if (Array.isArray(hl)) {
        hl.forEach(t => {
          if (!t.signature || seen.has(t.signature)) return;
          const wallet     = t.feePayer;
          const timestamp  = t.timestamp ? t.timestamp * 1000 : Date.now();
          const tokenXfer  = (t.tokenTransfers || []).find(tf => tf.mint === tokenAddress);
          if (!wallet || !tokenXfer) return;
          const side       = tokenXfer.toUserAccount === wallet ? 'buy' : 'sell';
          const nativeAmt  = (t.nativeTransfers || []).reduce((s, tf) => s + (tf.amount || 0), 0) / 1e9;
          seen.add(t.signature);
          swaps.push({
            wallet, side, timestamp,
            nativeAmount: nativeAmt,
            tokenAmount:  tokenXfer.tokenAmount || 0,
            txHash: t.signature,
            slot:   t.slot || null
          });
        });
      }
    }

    return swaps.sort((a, b) => a.timestamp - b.timestamp);
  }

  // ── Build per-wallet summary map ─────────────────────────────
  function buildWalletMap(swaps, launchTs) {
    const map = {};
    swaps.forEach(s => {
      const w = s.wallet;
      if (!map[w]) {
        map[w] = { wallet: w, buys: [], sells: [], firstBuyTime: null, firstBuySlot: null,
                   totalBuyNative: 0, totalTokensReceived: 0, fundingSources: [], isCycler: false, avgCycleDelaySecs: null };
      }
      if (s.side === 'buy') {
        map[w].buys.push(s);
        map[w].totalBuyNative      += s.nativeAmount || 0;
        map[w].totalTokensReceived += s.tokenAmount  || 0;
        if (!map[w].firstBuyTime || s.timestamp < map[w].firstBuyTime) {
          map[w].firstBuyTime = s.timestamp;
          map[w].firstBuySlot = s.slot;
        }
      } else {
        map[w].sells.push(s);
      }
    });
    return map;
  }

  // ── Funding source enrichment via Helius ─────────────────────
  async function enrichFundingSources(wallets) {
    for (let i = 0; i < wallets.length; i += CFG.batchSize) {
      const batch = wallets.slice(i, i + CFG.batchSize);
      await Promise.all(batch.map(async wData => {
        const txns = await ChainAPIs.heliusTxns(wData.wallet, 20);
        if (!Array.isArray(txns)) return;

        const buyTime   = wData.firstBuyTime || Date.now();
        const windowMs  = CFG.funderWindowMins * 60 * 1000;
        const cutoff    = buyTime - windowMs;

        txns.forEach(t => {
          const ts = t.timestamp ? t.timestamp * 1000 : 0;
          if (ts < cutoff || ts > buyTime) return;

          // Find SOL transfers INTO this wallet
          (t.nativeTransfers || []).forEach(tf => {
            if (
              tf.toUserAccount === wData.wallet &&
              tf.fromUserAccount && tf.fromUserAccount !== wData.wallet &&
              (tf.amount || 0) > 0
            ) {
              wData.fundingSources.push({
                funder:    tf.fromUserAccount,
                amountSol: tf.amount / 1e9,
                timestamp: ts
              });
            }
          });
        });
      }));
    }
  }

  // ── Detect cyclers (quick buy→sell loops) ────────────────────
  function detectCyclers(wallets, allSwaps) {
    wallets.forEach(w => {
      if (w.buys.length < 2 || w.sells.length < 2) return;
      const buyTimes  = w.buys.map(b => b.timestamp).sort();
      const sellTimes = w.sells.map(s => s.timestamp).sort();
      const delay     = sellTimes[0] - buyTimes[0];
      if (delay > 0 && delay < 600000) { // <10 min
        w.isCycler          = true;
        w.avgCycleDelaySecs = Math.round(delay / 1000);
      }
    });
  }

  // ── Build link matrix between wallets ────────────────────────
  function buildLinks(wallets, launchTs) {
    // links: wallet → [{peer, reason, strength}]
    const links = new Map();
    wallets.forEach(w => links.set(w.wallet, []));

    function addLink(a, b, reason, strength) {
      if (a === b) return;
      links.get(a)?.push({ peer: b, reason, strength });
      links.get(b)?.push({ peer: a, reason, strength });
    }

    // ── Signal 1: Shared funding source ───────────────────────
    const funderMap = {}; // funder → [{wallet, amountSol, ts}]
    wallets.forEach(w => {
      w.fundingSources.forEach(fs => {
        if (!funderMap[fs.funder]) funderMap[fs.funder] = [];
        funderMap[fs.funder].push({ wallet: w.wallet, amountSol: fs.amountSol, ts: fs.timestamp });
      });
    });

    Object.entries(funderMap).forEach(([funder, funded]) => {
      if (funded.length < 2) return;
      const count = funded.length;
      const strength = count >= 8 ? 95 : count >= 5 ? 85 : count >= 3 ? 70 : 50;

      for (let i = 0; i < funded.length; i++) {
        for (let j = i + 1; j < funded.length; j++) {
          const dtMins = Math.abs(funded[i].ts - funded[j].ts) / 60000;
          const timeNote = dtMins < 5  ? ` within ${dtMins.toFixed(0)}m` :
                           dtMins < 30 ? ` within ${dtMins.toFixed(0)}m`  : '';
          addLink(
            funded[i].wallet, funded[j].wallet,
            `Shared funder ${shortAddr(funder)} funded ${count} wallets${timeNote}`,
            strength
          );
        }
      }
    });

    // ── Signal 2: Identical buy sizes ─────────────────────────
    const buySizes = wallets.map(w => ({
      wallet: w.wallet,
      avgBuy: w.buys.length > 0 ? w.totalBuyNative / w.buys.length : 0
    })).filter(w => w.avgBuy > 0);

    for (let i = 0; i < buySizes.length; i++) {
      for (let j = i + 1; j < buySizes.length; j++) {
        const a = buySizes[i].avgBuy, b = buySizes[j].avgBuy;
        const diff = Math.abs(a - b) / Math.max(a, b);
        if (diff <= CFG.idAmountTolerance) {
          addLink(
            buySizes[i].wallet, buySizes[j].wallet,
            `Identical buy size: ${a.toFixed(4)} SOL ±${(diff * 100).toFixed(2)}%`,
            65
          );
        }
      }
    }

    // ── Signal 3a: Synchronized timing (within window) ────────
    const sorted = [...wallets].sort((a, b) => (a.firstBuyTime || 0) - (b.firstBuyTime || 0));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const dt = ((sorted[j].firstBuyTime || 0) - (sorted[i].firstBuyTime || 0)) / 1000;
        if (dt > CFG.syncWindowSecs) break; // sorted → safe to break early
        addLink(
          sorted[i].wallet, sorted[j].wallet,
          `Bought within ${dt.toFixed(0)}s of each other after launch`,
          55
        );
      }
    }

    // ── Signal 3b: Same block/slot ────────────────────────────
    const slotBuckets = {};
    wallets.forEach(w => {
      if (!w.firstBuySlot) return;
      const key = String(w.firstBuySlot);
      if (!slotBuckets[key]) slotBuckets[key] = [];
      slotBuckets[key].push(w.wallet);
    });
    Object.entries(slotBuckets).forEach(([slot, ws]) => {
      if (ws.length < 2) return;
      for (let i = 0; i < ws.length; i++) {
        for (let j = i + 1; j < ws.length; j++) {
          addLink(ws[i], ws[j], `Same block/slot ${slot} — bundle signature`, 85);
        }
      }
    });

    // ── Signal 4: Matched buy→sell cycle delay ────────────────
    const cyclers = wallets.filter(w => w.isCycler && w.avgCycleDelaySecs != null);
    for (let i = 0; i < cyclers.length; i++) {
      for (let j = i + 1; j < cyclers.length; j++) {
        const delayDiff = Math.abs(cyclers[i].avgCycleDelaySecs - cyclers[j].avgCycleDelaySecs);
        if (delayDiff <= 30) { // within 30s of each other's cycle time
          const avgDelay = Math.round((cyclers[i].avgCycleDelaySecs + cyclers[j].avgCycleDelaySecs) / 2);
          addLink(
            cyclers[i].wallet, cyclers[j].wallet,
            `Matching buy→sell cycle: ~${avgDelay}s delay — coordinated dump pattern`,
            70
          );
        }
      }
    }

    return links;
  }

  // ── Union-Find clustering ─────────────────────────────────────
  function unionFind(wallets, links) {
    const parent = {};
    wallets.forEach(w => { parent[w.wallet] = w.wallet; });

    function find(x) {
      if (parent[x] !== x) parent[x] = find(parent[x]);
      return parent[x];
    }
    function union(a, b) { parent[find(a)] = find(b); }

    // Collect all cluster reasons
    const clusterReasons = {}; // root → Set<reason>

    links.forEach((peers, wallet) => {
      peers.forEach(({ peer, reason, strength }) => {
        if (strength >= 50) {
          union(wallet, peer);
        }
      });
    });

    // Re-resolve after all unions
    wallets.forEach(w => find(w.wallet));

    const groups = {}; // root → {wallets, reasons}
    wallets.forEach(w => {
      const root = find(w.wallet);
      if (!groups[root]) groups[root] = { wallets: [], reasons: new Set() };
      groups[root].wallets.push(w.wallet);
    });

    // Assign reasons: collect from all links between group members
    links.forEach((peers, wallet) => {
      const root = find(wallet);
      if (!groups[root]) return;
      peers.forEach(({ peer, reason, strength }) => {
        if (strength >= 50 && find(peer) === root) {
          groups[root].reasons.add(reason);
        }
      });
    });

    return Object.values(groups).map(g => ({
      wallets:    g.wallets,
      reasons:    [...g.reasons],
      confidence: calcConfidence(g.wallets, g.reasons)
    }));
  }

  function calcConfidence(wallets, reasons) {
    let score = 0;

    reasons.forEach(r => {
      if (r.includes('Shared funder') && r.includes('within')) score += 45;
      else if (r.includes('Shared funder'))                    score += 30;
      else if (r.includes('Same block') || r.includes('slot')) score += 30;
      else if (r.includes('Identical buy size'))               score += 20;
      else if (r.includes('Bought within'))                    score += 15;
      else if (r.includes('cycle'))                            score += 20;
      else                                                     score += 10;
    });

    // Cluster size bonus
    const n = wallets.length;
    if (n >= 10) score += 30;
    else if (n >= 5)  score += 18;
    else if (n >= 3)  score += 8;

    return Math.min(score, 100);
  }

  // ── Compute per-cluster statistics ────────────────────────────
  function computeStats(cluster, allWallets, totalBuyTokens, totalNative, launchTs) {
    const members = allWallets.filter(w => cluster.wallets.includes(w.wallet));

    const totalTokens     = members.reduce((s, w) => s + w.totalTokensReceived, 0);
    const totalNativeBuy  = members.reduce((s, w) => s + w.totalBuyNative, 0);
    const avgOffsetSecs   = members.length
      ? Math.round(members.reduce((s, w) => s + ((w.firstBuyTime || launchTs) - launchTs), 0) / members.length / 1000)
      : 0;
    const avgBuySize      = members.length
      ? members.reduce((s, w) => s + (w.buys.length ? w.totalBuyNative / w.buys.length : 0), 0) / members.length
      : 0;

    const pctSupply  = totalBuyTokens > 0 ? (totalTokens / totalBuyTokens) * 100 : 0;
    const pctVolume  = totalNative    > 0 ? (totalNativeBuy / totalNative)  * 100 : 0;

    // Collect all unique funders
    const allFunders = [...new Set(members.flatMap(w => w.fundingSources.map(f => f.funder)))];

    return {
      ...cluster,
      stats: {
        walletCount:          members.length,
        totalTokensHeld:      Math.round(totalTokens),
        pctSupplyHeld:        parseFloat(pctSupply.toFixed(2)),
        pctEarlyVolume:       parseFloat(pctVolume.toFixed(2)),
        avgBuyTimeOffsetSecs: avgOffsetSecs,
        avgBuyNative:         parseFloat(avgBuySize.toFixed(4)),
        sharedFunders:        allFunders.slice(0, 5)
      }
    };
  }

  // ── Helpers ───────────────────────────────────────────────────
  function shortAddr(addr) {
    return addr ? `${addr.slice(0, 5)}…${addr.slice(-4)}` : '?';
  }

  function empty(reason) {
    return { success: false, reason, clusters: [], clusterRiskScore: 0, analyzedAt: Date.now() };
  }

  return { analyze, CFG };
})();
