/**
 * BundleDetector v2 — Advanced stealth-bundle detection for Solana meme launches
 *
 * New in v2:
 *   • Behavioral clustering — pairwise wallet similarity (timing + size + sell sync + wallet age)
 *   • Supply concentration  — stealth bundle flag if cluster holds >30% even without direct links
 *   • Funding tree          — 2-hop Helius trace: catches spread-funded bundles
 *   • Active distribution   — downgrade signal if cluster wallets are selling NOW (last 30min)
 *   • Tolerance extended    — buy-size match window 2% → 5%, early-buy window 5min → 10min
 *
 * Stage 1: Birdeye trade data only (fast, no extra API keys required)
 * Stage 2: Helius RPC — same-funder, funding tree, related-funding (requires Helius key)
 *
 * Output: { bundle_risk_score 0–100, tier, detected_patterns[], clusters[],
 *           estimated_cluster_supply_pct, summary, stage, distributionAlert }
 *
 * T-CMD · Trade Command
 */
const BundleDetector = (() => {

  // ── Pattern weights ───────────────────────────────────────────
  const W = {
    sameFunder:          50,  // Direct same funder (strongest)
    fundingTree:         42,  // 2-hop shared root funder
    behaviorCluster:     38,  // Multi-signal behavioral fingerprint
    supplyConcentration: 35,  // Cluster holds >30% supply (stealth bundle)
    sameBlock:           25,  // Same Solana block execution
    coordinatedSells:    20,  // Early buyers dump together
    relatedFunding:      20,  // Co-created wallets before launch
    activeDistribution:  30,  // Cluster actively dumping RIGHT NOW
    fixedBuySize:        15,  // Identical/near-identical buy amounts
    burstTiming:         10,  // 6+ wallets within 10-second burst
    regularTiming:       10,  // Robotic regular-interval buys
  };

  // ── Risk tiers ────────────────────────────────────────────────
  function bundleTier(score) {
    if (score >= 80) return { label: 'Strong Bundle',  cls: 'bd-crit', color: '#ef4444', emoji: '🚨' };
    if (score >= 60) return { label: 'Likely Bundled', cls: 'bd-high', color: '#f59e0b', emoji: '⚠️' };
    if (score >= 40) return { label: 'Suspicious',     cls: 'bd-med',  color: '#3b82f6', emoji: '🔍' };
    return               { label: 'Low Risk',          cls: 'bd-low',  color: '#22c55e', emoji: '✅' };
  }

  // ── Helpers ───────────────────────────────────────────────────
  const short = a => a ? `${a.slice(0, 5)}…${a.slice(-4)}` : '?';

  function pctMatch(a, b, tol = 0.05) {
    if (!a || !b || a === 0) return false;
    return Math.abs(a - b) / Math.max(a, b) <= tol;
  }

  // Get first maxMs milliseconds of buy-side trades, sorted oldest-first
  function getEarlyBuys(trades, maxMs = 600000) {
    const buys = trades
      .filter(t => (t.side || '').toLowerCase() === 'buy' && t.owner)
      .sort((a, b) => a.blockUnixTime - b.blockUnixTime);
    if (!buys.length) return [];
    const launchTs = buys[0].blockUnixTime * 1000;
    return maxMs > 0
      ? buys.filter(t => t.blockUnixTime * 1000 - launchTs <= maxMs)
      : buys;
  }

  // ── Union-Find for behavioral clustering ─────────────────────
  function makeUF(n) {
    const parent = Array.from({ length: n }, (_, i) => i);
    const rank   = new Array(n).fill(0);
    function find(x) { return parent[x] === x ? x : (parent[x] = find(parent[x])); }
    function union(x, y) {
      const px = find(x), py = find(y);
      if (px === py) return;
      if (rank[px] < rank[py]) parent[px] = py;
      else if (rank[px] > rank[py]) parent[py] = px;
      else { parent[py] = px; rank[px]++; }
    }
    return { find, union };
  }

  // ─────────────────────────────────────────────────────────────
  // PATTERN A: Behavioral Cluster (Stage 1, Birdeye only)
  // Groups wallets by multi-signal similarity:
  //   • buy timing proximity (same block / <30s / <2min / <5min)
  //   • buy size similarity (±5%)
  //   • coordinated sell timing (sold within 5min of each other)
  //   • "fresh wallet" co-occurrence (both bought in first 60s)
  // Uses union-find with threshold 10 to form clusters.
  // ─────────────────────────────────────────────────────────────
  function detectBehaviorCluster(earlyBuys, trades) {
    if (earlyBuys.length < 4) return null;

    // De-duplicate — one record per wallet (keep the earliest buy)
    const walletMap = new Map();
    earlyBuys.forEach(t => { if (!walletMap.has(t.owner)) walletMap.set(t.owner, t); });
    const wallets = [...walletMap.keys()];
    const buys    = wallets.map(w => walletMap.get(w));
    const n = wallets.length;
    if (n < 4) return null;

    const launchTs = buys[0].blockUnixTime;

    // Build sell map: wallet → timestamp of first sell
    const earlySet  = new Set(wallets.map(w => w.toLowerCase()));
    const sellMap   = new Map();
    trades
      .filter(t => (t.side || '').toLowerCase() === 'sell' && earlySet.has((t.owner || '').toLowerCase()))
      .sort((a, b) => a.blockUnixTime - b.blockUnixTime)
      .forEach(t => { if (!sellMap.has(t.owner)) sellMap.set(t.owner, t.blockUnixTime); });

    // Pairwise similarity matrix
    const sim = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let s = 0;
        const bi = buys[i], bj = buys[j];
        const dt = Math.abs(bi.blockUnixTime - bj.blockUnixTime);

        // ── Timing proximity ──
        if (bi.blockUnixTime === bj.blockUnixTime) s += 12; // same block
        else if (dt <= 30)  s += 8;
        else if (dt <= 120) s += 5;
        else if (dt <= 300) s += 2;

        // ── Buy-size similarity (±5% / ±10% / ±15%) ──
        const ai = bi.from?.uiAmount || bi.from?.amount || 0;
        const aj = bj.from?.uiAmount || bj.from?.amount || 0;
        if (ai > 0 && aj > 0) {
          const diff = Math.abs(ai - aj) / Math.max(ai, aj);
          if      (diff <= 0.02) s += 10;
          else if (diff <= 0.05) s += 7;
          else if (diff <= 0.15) s += 3;
        }

        // ── Sell coordination ──
        const si = sellMap.get(wallets[i]);
        const sj = sellMap.get(wallets[j]);
        if (si && sj) {
          const sd = Math.abs(si - sj);
          if (sd <= 300)  s += 10; // within 5 min
          else if (sd <= 1800) s += 6;
        }

        // ── Both fresh (first 60s of launch) ──
        const freshI = (bi.blockUnixTime - launchTs) <= 60;
        const freshJ = (bj.blockUnixTime - launchTs) <= 60;
        if (freshI && freshJ) s += 4;

        sim[i][j] = sim[j][i] = s;
      }
    }

    // Union-find cluster formation (threshold: similarity ≥ 10)
    const THRESHOLD = 10;
    const uf = makeUF(n);
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++)
        if (sim[i][j] >= THRESHOLD) uf.union(i, j);

    // Extract clusters
    const clusters = new Map();
    wallets.forEach((w, i) => {
      const root = uf.find(i);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root).push({ wallet: w, idx: i });
    });

    // Find the biggest cluster with ≥ 4 wallets
    let best = null;
    for (const members of clusters.values())
      if (members.length >= 4 && (!best || members.length > best.length)) best = members;

    if (!best) return null;

    // Compute average intra-cluster similarity
    const indices = best.map(m => m.idx);
    let totalSim = 0, pairs = 0;
    for (let i = 0; i < indices.length; i++)
      for (let j = i + 1; j < indices.length; j++) {
        totalSim += sim[indices[i]][indices[j]]; pairs++;
      }
    const avgSim = pairs > 0 ? totalSim / pairs : 0;

    const clusterWallets = best.map(m => m.wallet);
    const confidence = Math.min(100, Math.round(20 + clusterWallets.length * 8 + avgSim * 1.2));

    return {
      pattern:    'behaviorCluster',
      wallets:    clusterWallets,
      confidence,
      weight:     W.behaviorCluster,
      details:    `${clusterWallets.length} wallets share behavioral fingerprint (timing+size+sell sync, avg similarity ${avgSim.toFixed(0)})`
    };
  }

  // ─────────────────────────────────────────────────────────────
  // PATTERN B: Supply Concentration (Stage 1, Birdeye holders)
  // Flags if early-buyer/cluster wallets control >25% of supply.
  // This catches "stealth bundles" with perfectly random-looking
  // amounts that defeat every other pattern detector.
  // ─────────────────────────────────────────────────────────────
  function detectSupplyConcentration(earlyBuys, holdersData, existingClusterWallets) {
    if (!holdersData) return null;
    const items = holdersData?.items;
    if (!items?.length) return null;

    // Use existing cluster wallets if available; otherwise all early buyers
    const candidateWallets = existingClusterWallets.length > 0
      ? existingClusterWallets
      : [...new Set(earlyBuys.map(t => t.owner))];

    const addrSet    = new Set(candidateWallets.map(w => w.toLowerCase()));
    const totalAmt   = items.reduce((s, h) => s + (h.ui_amount || h.uiAmount || h.amount || 0), 0);
    if (totalAmt === 0) return null;

    const clusterAmt = items
      .filter(h => addrSet.has((h.address || '').toLowerCase()))
      .reduce((s, h) => s + (h.ui_amount || h.uiAmount || h.amount || 0), 0);

    const pct = (clusterAmt / totalAmt) * 100;
    if (pct < 25) return null;

    // Stealth bundle: high supply concentration even without obvious behavioral links
    const isStealth = pct >= 35 && existingClusterWallets.length === 0;
    const confidence = Math.min(100, Math.round(pct * 1.8));

    return {
      pattern:      'supplyConcentration',
      wallets:      candidateWallets.slice(0, 30),
      confidence,
      weight:       W.supplyConcentration,
      supply_pct:   parseFloat(pct.toFixed(1)),
      isStealth,
      details:      `${isStealth ? '⚠️ Stealth bundle — ' : ''}${pct.toFixed(1)}% of supply held by ${candidateWallets.length} early buyers` +
                    (isStealth ? ' (random-looking amounts, no direct links)' : '')
    };
  }

  // ─────────────────────────────────────────────────────────────
  // PATTERN C: Active Distribution — cluster wallets dumping NOW
  // Checks if ANY identified cluster wallets have sold in the
  // last 30 minutes. If so → immediate downgrade signal.
  // ─────────────────────────────────────────────────────────────
  function detectActiveDistribution(trades, clusterWallets) {
    if (!clusterWallets.length) return null;

    const clusterSet = new Set(clusterWallets.map(w => w.toLowerCase()));
    const now        = Math.floor(Date.now() / 1000);
    const cutoff     = now - 1800; // last 30 minutes

    const recentSells = trades.filter(t =>
      (t.side || '').toLowerCase() === 'sell' &&
      clusterSet.has((t.owner || '').toLowerCase()) &&
      t.blockUnixTime >= cutoff
    );

    if (recentSells.length < 2) return null;

    const sellingWallets = [...new Set(recentSells.map(t => t.owner))];
    if (sellingWallets.length < 2) return null;

    const sellRatio  = sellingWallets.length / Math.max(1, clusterWallets.length);
    const confidence = Math.min(100, Math.round(35 + sellRatio * 75));

    return {
      pattern:           'activeDistribution',
      wallets:           sellingWallets,
      confidence,
      weight:            W.activeDistribution,
      details:           `🚨 ACTIVE DUMP: ${sellingWallets.length}/${clusterWallets.length} cluster wallets selling in last 30 min`,
      distributionAlert: true   // propagated to top-level result → triggers score downgrade
    };
  }

  // ─────────────────────────────────────────────────────────────
  // PATTERN D: Fixed-Size Buy Bundle (Stage 1, ±5% tolerance)
  // ─────────────────────────────────────────────────────────────
  function detectFixedSizeBuys(earlyBuys) {
    if (earlyBuys.length < 4) return null;

    const withAmt = earlyBuys
      .map(t => ({ owner: t.owner, ts: t.blockUnixTime, amount: t.from?.uiAmount || t.from?.amount || 0 }))
      .filter(t => t.amount > 0);

    if (withAmt.length < 4) return null;

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
      if (group.length >= 4) groups.push({ amount: rep, wallets: group });
    }

    if (!groups.length) return null;
    const best   = groups.sort((a, b) => b.wallets.length - a.wallets.length)[0];
    const amtStr = best.amount < 0.001 ? best.amount.toExponential(2) : best.amount.toFixed(4);

    return {
      pattern:    'fixedBuySize',
      wallets:    best.wallets,
      confidence: Math.min(100, 40 + best.wallets.length * 8),
      weight:     W.fixedBuySize,
      details:    `${best.wallets.length} wallets bought identical size (~${amtStr} ±5%)`
    };
  }

  // ─────────────────────────────────────────────────────────────
  // PATTERN E: Same-Block / Burst Timing (Stage 1)
  // ─────────────────────────────────────────────────────────────
  function detectSameBlockBurst(earlyBuys) {
    if (earlyBuys.length < 4) return null;
    const results = [];

    // Same block
    const byBlock = {};
    earlyBuys.forEach(t => {
      if (!byBlock[t.blockUnixTime]) byBlock[t.blockUnixTime] = [];
      byBlock[t.blockUnixTime].push(t.owner);
    });
    const sameBlocks = Object.entries(byBlock)
      .filter(([, ws]) => ws.length >= 4)
      .sort((a, b) => b[1].length - a[1].length);

    if (sameBlocks.length > 0) {
      const [ts, ws] = sameBlocks[0];
      const uniq     = [...new Set(ws)];
      results.push({
        pattern:    'sameBlock',
        wallets:    uniq,
        confidence: Math.min(100, 50 + uniq.length * 7),
        weight:     W.sameBlock,
        details:    `${uniq.length} wallets executed in the same block (ts ${ts})`
      });
    }

    // 10-second burst
    const sorted = [...earlyBuys].sort((a, b) => a.blockUnixTime - b.blockUnixTime);
    let bestBurst = [];
    for (let i = 0; i < sorted.length; i++) {
      const winEnd = sorted[i].blockUnixTime + 10;
      const inWin  = sorted.filter(t => t.blockUnixTime >= sorted[i].blockUnixTime && t.blockUnixTime <= winEnd);
      const uniq   = [...new Set(inWin.map(t => t.owner))];
      if (uniq.length >= 6 && uniq.length > bestBurst.length) bestBurst = uniq;
    }
    if (bestBurst.length >= 6) {
      results.push({
        pattern:    'burstTiming',
        wallets:    bestBurst,
        confidence: Math.min(100, 40 + bestBurst.length * 6),
        weight:     W.burstTiming,
        details:    `${bestBurst.length} wallets bought in a 10-second burst at launch`
      });
    }

    return results.length ? results : null;
  }

  // ─────────────────────────────────────────────────────────────
  // PATTERN F: Staggered Insider — coordinated sells + regular intervals
  // ─────────────────────────────────────────────────────────────
  function detectStaggeredInsider(trades, earlyBuys) {
    if (earlyBuys.length < 5) return null;
    const results         = [];
    const earlyBuyWallets = new Set(earlyBuys.map(t => t.owner.toLowerCase()));

    // Coordinated sells in 5-min windows
    const sells = trades.filter(t =>
      (t.side || '').toLowerCase() === 'sell' &&
      earlyBuyWallets.has((t.owner || '').toLowerCase())
    );
    if (sells.length >= 3) {
      const byWindow = {};
      sells.forEach(t => {
        const bucket = Math.floor(t.blockUnixTime / 300);
        if (!byWindow[bucket]) byWindow[bucket] = [];
        byWindow[bucket].push(t.owner);
      });
      const bigWindows = Object.entries(byWindow)
        .filter(([, ws]) => ws.length >= 3)
        .sort((a, b) => b[1].length - a[1].length);

      if (bigWindows.length > 0) {
        const uniq = [...new Set(bigWindows[0][1])];
        results.push({
          pattern:    'coordinatedSells',
          wallets:    uniq,
          confidence: Math.min(100, 35 + uniq.length * 10),
          weight:     W.coordinatedSells,
          details:    `${uniq.length} early buyers dumped in the same 5-min window`
        });
      }
    }

    // Robotic regular buy timing
    if (earlyBuys.length >= 6) {
      const uniqTs = [...new Set(earlyBuys.map(t => t.blockUnixTime))].sort((a, b) => a - b);
      if (uniqTs.length >= 5) {
        const gaps   = [];
        for (let i = 1; i < uniqTs.length; i++) gaps.push(uniqTs[i] - uniqTs[i - 1]);
        const avg    = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        const stdDev = Math.sqrt(gaps.reduce((a, g) => a + (g - avg) ** 2, 0) / gaps.length);
        const cv     = avg > 0 ? stdDev / avg : 1;
        if (cv < 0.35 && avg >= 1 && avg <= 15 && uniqTs.length >= 6) {
          const robotWallets = [...new Set(earlyBuys.map(t => t.owner))];
          results.push({
            pattern:    'regularTiming',
            wallets:    robotWallets,
            confidence: Math.min(100, Math.round((1 - cv) * 85)),
            weight:     W.regularTiming,
            details:    `${robotWallets.length} wallets bought at robotic intervals (avg ${avg.toFixed(1)}s, regularity ${((1 - cv) * 100).toFixed(0)}%)`
          });
        }
      }
    }

    return results.length ? results : null;
  }

  // ─────────────────────────────────────────────────────────────
  // PATTERN G: Same Funder — direct shared funding (Stage 2, Helius)
  // ─────────────────────────────────────────────────────────────
  async function detectSameFunder(earlyWallets, launchTs) {
    const { helius } = ChainAPIs.getKeys();
    if (!helius || !earlyWallets.length) return null;

    const walletsToCheck = earlyWallets.slice(0, 20);
    const fundersMap     = new Map();
    const BATCH          = 4;

    for (let i = 0; i < walletsToCheck.length; i += BATCH) {
      const batch = walletsToCheck.slice(i, i + BATCH);
      await Promise.all(batch.map(async wallet => {
        try {
          const txns = await ChainAPIs.heliusTxns(wallet, 20, 'TRANSFER');
          if (!Array.isArray(txns)) return;
          const cutoff = launchTs - 86400 * 2;
          for (const t of txns) {
            if (!t.timestamp || t.timestamp > launchTs + 3600) continue;
            for (const tr of (t.nativeTransfers || [])) {
              if (tr.toUserAccount === wallet && tr.fromUserAccount && (tr.amount || 0) > 0.01e9) {
                if (!fundersMap.has(tr.fromUserAccount)) fundersMap.set(tr.fromUserAccount, new Set());
                fundersMap.get(tr.fromUserAccount).add(wallet);
              }
            }
          }
        } catch (_) {}
      }));
    }

    let bestFunder = null, bestWallets = [];
    for (const [funder, ws] of fundersMap) {
      const arr = [...ws];
      if (arr.length >= 3 && arr.length > bestWallets.length) {
        bestFunder = funder; bestWallets = arr;
      }
    }

    if (!bestFunder) return null;
    return {
      pattern:    'sameFunder',
      wallets:    bestWallets,
      funder:     bestFunder,
      confidence: Math.min(100, 55 + bestWallets.length * 8),
      weight:     W.sameFunder,
      details:    `${bestWallets.length} early buyers funded by same wallet (${short(bestFunder)})`
    };
  }

  // ─────────────────────────────────────────────────────────────
  // PATTERN H: Funding Tree — 2-hop shared root funder (Stage 2)
  // Catches "spread funding": controller → N intermediary wallets
  // → each funds 1-2 buyer wallets (undetectable at hop-1 alone)
  // ─────────────────────────────────────────────────────────────
  async function detectFundingTree(earlyWallets, launchTs) {
    const { helius } = ChainAPIs.getKeys();
    if (!helius || earlyWallets.length < 4) return null;

    const walletsToCheck = earlyWallets.slice(0, 20);
    const BATCH          = 4;

    // ── Hop 1: wallet → direct funder ──
    const hop1Map     = new Map(); // wallet → funder
    const hop1Funders = new Map(); // funder → [wallets]

    for (let i = 0; i < walletsToCheck.length; i += BATCH) {
      const batch = walletsToCheck.slice(i, i + BATCH);
      await Promise.all(batch.map(async wallet => {
        try {
          const txns = await ChainAPIs.heliusTxns(wallet, 15, 'TRANSFER');
          if (!Array.isArray(txns)) return;
          for (const t of txns) {
            if (!t.timestamp || t.timestamp > launchTs + 3600) continue;
            for (const tr of (t.nativeTransfers || [])) {
              if (tr.toUserAccount === wallet && tr.fromUserAccount && (tr.amount || 0) > 0.01e9) {
                hop1Map.set(wallet, tr.fromUserAccount);
                if (!hop1Funders.has(tr.fromUserAccount)) hop1Funders.set(tr.fromUserAccount, []);
                hop1Funders.get(tr.fromUserAccount).push(wallet);
                return; // only first funder per wallet
              }
            }
          }
        } catch (_) {}
      }));
    }

    // Only trace hop-2 for "lonely" funders (funded 1-2 wallets each — not already a same-funder hit)
    const lonelyFunders = [...hop1Funders.entries()]
      .filter(([, ws]) => ws.length < 3)
      .map(([f]) => f)
      .slice(0, 8);

    if (lonelyFunders.length < 2) return null;

    // ── Hop 2: lonely funder → its funder ──
    const hop2Funders = new Map(); // hop2Root → [hop1Funders it funded]

    for (let i = 0; i < lonelyFunders.length; i += BATCH) {
      const batch = lonelyFunders.slice(i, i + BATCH);
      await Promise.all(batch.map(async funder => {
        try {
          const txns = await ChainAPIs.heliusTxns(funder, 10, 'TRANSFER');
          if (!Array.isArray(txns)) return;
          for (const t of txns) {
            if (!t.timestamp) continue;
            for (const tr of (t.nativeTransfers || [])) {
              if (tr.toUserAccount === funder && tr.fromUserAccount && (tr.amount || 0) > 0.01e9) {
                if (!hop2Funders.has(tr.fromUserAccount)) hop2Funders.set(tr.fromUserAccount, []);
                hop2Funders.get(tr.fromUserAccount).push(funder);
                return;
              }
            }
          }
        } catch (_) {}
      }));
    }

    // Find hop-2 root that funded ≥ 2 lonely hop-1 funders
    let bestRoot = null, bestBranches = [];
    for (const [root, branches] of hop2Funders) {
      if (branches.length >= 2 && branches.length > bestBranches.length) {
        bestRoot = root; bestBranches = branches;
      }
    }
    if (!bestRoot) return null;

    // Collect all leaf wallets under this funding tree
    const treeWallets = [...new Set(bestBranches.flatMap(f => hop1Funders.get(f) || []))];
    if (treeWallets.length < 3) return null;

    const confidence = Math.min(100, 45 + treeWallets.length * 7 + bestBranches.length * 5);
    return {
      pattern:    'fundingTree',
      wallets:    treeWallets,
      funder:     bestRoot,
      hops:       2,
      confidence,
      weight:     W.fundingTree,
      details:    `${treeWallets.length} buyers share a root funder 2 hops back (${short(bestRoot)} → ${bestBranches.length} intermediaries → buyers)`
    };
  }

  // ─────────────────────────────────────────────────────────────
  // PATTERN I: Related Funding — co-created wallets (Stage 2)
  // ─────────────────────────────────────────────────────────────
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
          const res  = await ChainAPIs.heliusRPC('getSignaturesForAddress', [wallet, { limit: 5, commitment: 'confirmed' }]);
          const sigs = res?.result;
          if (!sigs?.length) return;
          const oldest = sigs[sigs.length - 1];
          if (oldest?.blockTime) firstTxTimes.push({ wallet, firstTs: oldest.blockTime });
        } catch (_) {}
      }));
    }

    if (firstTxTimes.length < 4) return null;
    const prelaunch = firstTxTimes.filter(f => f.firstTs < launchTs + 3600);
    if (prelaunch.length < 4) return null;

    prelaunch.sort((a, b) => a.firstTs - b.firstTs);
    let bestGroup = [];
    for (let i = 0; i < prelaunch.length; i++) {
      const winEnd = prelaunch[i].firstTs + 3600;
      const group  = prelaunch.filter(f => f.firstTs >= prelaunch[i].firstTs && f.firstTs <= winEnd);
      if (group.length > bestGroup.length) bestGroup = group;
    }
    if (bestGroup.length < 4) return null;

    const wallets = bestGroup.map(f => f.wallet);
    return {
      pattern:    'relatedFunding',
      wallets,
      confidence: Math.min(100, 25 + wallets.length * 8),
      weight:     W.relatedFunding,
      details:    `${wallets.length} early buyers were created/funded within 1h of each other`
    };
  }

  // ── Supply estimation helper ──────────────────────────────────
  function estimateClusterSupply(clusterWallets, holdersData) {
    const items = holdersData?.items;
    if (!items?.length || !clusterWallets?.length) return 0;
    const addrSet    = new Set(clusterWallets.map(w => w.toLowerCase()));
    const totalAmt   = items.reduce((s, h) => s + (h.ui_amount || h.uiAmount || h.amount || 0), 0);
    if (totalAmt === 0) return 0;
    const clusterAmt = items
      .filter(h => addrSet.has((h.address || '').toLowerCase()))
      .reduce((s, h) => s + (h.ui_amount || h.uiAmount || h.amount || 0), 0);
    return parseFloat(((clusterAmt / totalAmt) * 100).toFixed(1));
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

  // ─────────────────────────────────────────────────────────────
  // MAIN ENTRY
  // ─────────────────────────────────────────────────────────────
  async function analyze(tokenAddress, chain) {
    if (!tokenAddress) return { success: false, reason: 'No address', bundle_risk_score: 0 };

    // Fetch trades (more = better: 150) + top holders in parallel
    const [tradesRes, holdersRes] = await Promise.all([
      ChainAPIs.beTrades(tokenAddress, chain || 'solana', 150),
      ChainAPIs.beTopHolders(tokenAddress, chain || 'solana', 30)
    ]);

    const trades      = tradesRes?.data?.items || [];
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

    // Early buys = first 10 minutes (extended from 5min)
    const earlyBuys    = getEarlyBuys(trades, 600000);
    const launchTs     = earlyBuys.length > 0 ? earlyBuys[0].blockUnixTime : Math.floor(Date.now() / 1000);
    const earlyWallets = [...new Set(earlyBuys.map(t => t.owner))];

    // ── Stage 1: Behavioral + structural (no extra API needed) ──
    const s1Patterns = [];

    // Behavioral cluster (most powerful Stage-1 signal)
    const behaviorCluster = detectBehaviorCluster(earlyBuys, trades);
    if (behaviorCluster) s1Patterns.push(behaviorCluster);

    // Same block / burst
    const blockBurst = detectSameBlockBurst(earlyBuys);
    if (blockBurst) {
      Array.isArray(blockBurst) ? s1Patterns.push(...blockBurst) : s1Patterns.push(blockBurst);
    }

    // Fixed-size buys
    const fixedSize = detectFixedSizeBuys(earlyBuys);
    if (fixedSize) s1Patterns.push(fixedSize);

    // Staggered insider (coordinated sells + robotic timing)
    const staggered = detectStaggeredInsider(trades, earlyBuys);
    if (staggered) {
      Array.isArray(staggered) ? s1Patterns.push(...staggered) : s1Patterns.push(staggered);
    }

    // Collect Stage-1 cluster wallets for supply check
    const s1ClusterWallets = [...new Set(s1Patterns.flatMap(p => p.wallets || []))];

    // Supply concentration — works with or without identified clusters
    const supplyConc = detectSupplyConcentration(earlyBuys, holdersData, s1ClusterWallets);
    if (supplyConc) s1Patterns.push(supplyConc);

    let allPatterns = [...s1Patterns];
    let stage       = 1;

    // ── Stage 2: Helius funding traces ──────────────────────────
    const { helius } = ChainAPIs.getKeys();
    if (helius && earlyWallets.length >= 3) {
      stage = 2;
      try {
        const [sameFunder, fundingTree, relatedFunding] = await Promise.all([
          detectSameFunder(earlyWallets, launchTs),
          detectFundingTree(earlyWallets, launchTs),
          detectRelatedFunding(earlyWallets, launchTs)
        ]);
        if (sameFunder)     allPatterns.push(sameFunder);
        if (fundingTree)    allPatterns.push(fundingTree);
        if (relatedFunding) allPatterns.push(relatedFunding);
      } catch (e) {
        console.warn('[BundleDetector] Stage 2 error:', e.message);
      }
    }

    // ── Build final cluster list ─────────────────────────────────
    const allClusterWallets = [...new Set(allPatterns.flatMap(p => p.wallets || []))];

    // Distribution monitoring — must run AFTER cluster wallets are known
    const activeDist = detectActiveDistribution(trades, allClusterWallets);
    if (activeDist) allPatterns.push(activeDist);

    // Supply estimate using final cluster list (may differ from Stage-1 estimate)
    const clusterSupplyPct = estimateClusterSupply(allClusterWallets, holdersData);

    const clusters = allClusterWallets.length > 0 ? [{
      wallets:    allClusterWallets,
      patterns:   allPatterns.map(p => p.pattern),
      supply_pct: clusterSupplyPct
    }] : [];

    const score             = computeScore(allPatterns);
    const tier              = bundleTier(score);
    const distributionAlert = allPatterns.some(p => p.distributionAlert);

    // ── Summary string ───────────────────────────────────────────
    let summary;
    if (allPatterns.length === 0) {
      summary = 'No bundle patterns detected in early trading window';
    } else {
      const wc         = allClusterWallets.length;
      const supplyStr  = clusterSupplyPct > 0 ? ` (~${clusterSupplyPct}% supply)` : '';
      const distStr    = distributionAlert ? ' 🚨 CLUSTER SELLING NOW' : '';
      summary = `${tier.emoji} ${tier.label}: ${allPatterns.length} pattern${allPatterns.length !== 1 ? 's' : ''}, ${wc} wallet${wc !== 1 ? 's' : ''}${supplyStr}${distStr}`;
    }

    return {
      success:                      true,
      bundle_risk_score:            score,
      tier,
      detected_patterns:            allPatterns,
      clusters,
      estimated_cluster_supply_pct: clusterSupplyPct,
      early_buyers_analyzed:        earlyBuys.length,
      distributionAlert,
      summary,
      stage
    };
  }

  return { analyze, bundleTier };
})();
