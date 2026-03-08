/* ============================================================
   T-CMD — Phase Classifier + Multi-Engine Scorer
   Classifies each token into a market phase and computes
   phase-specific opportunity scores.

   Phases: launch | accumulation | liquidity_trap | breakout | distribution

   Usage (synchronous, no API calls):
     PhaseClassifier.classify(token, momentumResult?)
     → { phase, accumScore, trapScore, breakoutScore, distScore,
         finalScore, reasons[], penalties[], tier }
   ============================================================ */

const PhaseClassifier = (() => {

  // ── Helpers ──────────────────────────────────────────────────
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ── Core signal extraction ────────────────────────────────────
  function extractSignals(token) {
    const m5   = parseFloat(token.priceChange?.m5  || 0);
    const h1   = parseFloat(token.priceChange?.h1  || 0);
    const h6   = parseFloat(token.priceChange?.h6  || 0);
    const h24  = parseFloat(token.priceChange?.h24 || 0);

    const vol5m  = parseFloat(token.volume?.m5  || 0);
    const vol1h  = parseFloat(token.volume?.h1  || 0);
    const vol24h = parseFloat(token.volume?.h24 || 0);

    const liq    = parseFloat(token.liquidity || 0);
    const mktCap = parseFloat(token.mktCap    || 0);

    const buys1h   = token.txns?.h1?.buys   || 0;
    const sells1h  = token.txns?.h1?.sells  || 0;
    const buys24h  = token.txns?.h24?.buys  || 0;
    const sells24h = token.txns?.h24?.sells || 0;

    const total1h  = buys1h  + sells1h;
    const total24h = buys24h + sells24h;

    const buyRatioH1  = total1h  > 5  ? buys1h  / total1h  : 0.5;
    const buyRatioH24 = total24h > 10 ? buys24h / total24h : 0.5;

    // Volume acceleration — 5m rate vs 1h per-minute average
    const v5mRate   = vol5m / 5;
    const v1hRate   = vol1h > 0 ? vol1h / 60 : v5mRate;
    const volAccel  = v1hRate > 0 ? v5mRate / v1hRate : 1;

    // 1h rate vs 24h per-minute average
    const v24hRate  = vol24h > 0 ? vol24h / 1440 : v1hRate;
    const v1_vs_v24 = v24hRate > 0 ? v1hRate / v24hRate : 1;

    const volRising = volAccel > 1.5 || v1_vs_v24 > 1.5;

    // Price range compression
    const priceFlat = Math.abs(h1) < 5 && Math.abs(m5) < 3;

    // Wash trading risk (vol/liq ratio)
    const vlRatio = liq > 0 ? vol24h / liq : 0;

    // Token age
    const ageMin  = token.createdAt ? (Date.now() - token.createdAt) / 60000 : 9999;
    const ageHours = ageMin / 60;

    // Rug flags from existing scanner (if present on token)
    const rugFlags = Array.isArray(token.rugFlags) ? token.rugFlags : [];
    const manipPenalty = token._manipPenalty != null ? token._manipPenalty : 0;

    return {
      m5, h1, h6, h24,
      vol5m, vol1h, vol24h,
      liq, mktCap,
      buys1h, sells1h, buys24h, sells24h,
      total1h, total24h,
      buyRatioH1, buyRatioH24,
      volAccel, v1_vs_v24, volRising,
      priceFlat,
      vlRatio,
      ageMin, ageHours,
      rugFlags, manipPenalty
    };
  }

  // ── Phase detection ───────────────────────────────────────────
  function detectPhase(s) {
    // 1. Launch — very new token (< 2h)
    if (s.ageHours < 2) return 'launch';

    // 2. Breakout — price accelerating + volume spike + buy pressure
    const priceBreaking = s.m5 > 3 || (s.h1 > 10 && s.h1 > s.h6 * 0.5);
    const volumeSpike   = s.volAccel > 2.5;
    const buyStrong     = s.buyRatioH1 > 0.58;
    if (priceBreaking && volumeSpike && buyStrong) return 'breakout';

    // 3. Distribution — stalling after a run, sells taking over
    const priceStall    = s.h1 < 3 && s.h24 > 30;
    const sellPressure  = s.buyRatioH1 < 0.45;
    const highVolFlat   = s.vol1h > (s.vol24h / 24) * 1.5 && s.h1 < 2;
    if (priceStall && (sellPressure || highVolFlat)) return 'distribution';

    // 4. Liquidity Trap — flat price, rising volume, buy pressure building, stable liq
    const liqOk      = s.liq >= 10000 && s.h1 > -15;
    const compressed = Math.abs(s.h1) < 4 && Math.abs(s.m5) < 2;
    if (compressed && s.volRising && buyStrong && liqOk) return 'liquidity_trap';

    // 5. Default: accumulation
    return 'accumulation';
  }

  // ── Phase-specific scoring engines ────────────────────────────

  /** Accumulation Score — best early entry setup */
  function scoreAccum(s, mom) {
    let score = 0;
    const reasons = [], penalties = [];

    // Price tight range
    if (Math.abs(s.h1) < 5 && Math.abs(s.m5) < 3) {
      score += 25; reasons.push('Price consolidating');
    } else if (Math.abs(s.h1) < 10) {
      score += 12; reasons.push('Price mostly stable');
    }

    // Volume rising slowly (not explosive — that's breakout)
    if (s.volAccel > 1.2 && s.volAccel < 3) {
      score += 20; reasons.push('Volume building steadily');
    } else if (s.volAccel >= 1.0 && s.volAccel <= 1.2) {
      score += 8; reasons.push('Volume stable');
    }

    // Buy pressure positive
    if (s.buyRatioH1 >= 0.52 && s.buyRatioH1 <= 0.70) {
      score += 20; reasons.push(`Buy pressure healthy (${Math.round(s.buyRatioH1*100)}%)`);
    } else if (s.buyRatioH1 > 0.70 && s.buyRatioH1 < 0.82) {
      score += 12; reasons.push(`Buy dominant (${Math.round(s.buyRatioH1*100)}%)`);
    }

    // Holder proxy — tx count
    if (s.buys24h >= 200) {
      score += 15; reasons.push('High buyer activity');
    } else if (s.buys24h >= 80) {
      score += 8; reasons.push('Good buyer count');
    }

    // Liquidity stable
    if (s.liq >= 10000 && s.h1 >= -15) {
      score += 10; reasons.push(`Liquidity OK ($${Math.round(s.liq/1000)}k)`);
    }

    // Not distribution
    if (s.buyRatioH1 >= 0.45 && s.h1 > -20) {
      score += 10;
    }

    // MomentumDetector boosts (if available)
    if (mom) {
      if (mom.signals?.holderGrowth?.value === 'growing') {
        score += 10; reasons.push('Holder growth detected');
      }
      if (mom.signals?.buyPressure?.value >= 0.6) {
        score += 8; reasons.push('Strong buy pressure (Birdeye)');
      }
      if (mom.advanced?.smartWalletInflow?.value > 0) {
        score += 10; reasons.push('Smart wallets entering');
      }
    }

    // Penalties
    if (s.volAccel > 5) {
      score -= 15; penalties.push('Explosive vol spike — possible pump');
    }
    if (s.liq < 5000) {
      score -= 20; penalties.push('Very low liquidity');
    }
    if (s.buyRatioH1 < 0.42) {
      score -= 10; penalties.push('Sell pressure elevated');
    }
    if (s.vlRatio > 10) {
      score -= 15; penalties.push('Wash trading risk');
    }

    return { score: clamp(score, 0, 100), reasons, penalties };
  }

  /** Liquidity Trap Score — compressed price + building pressure = pre-breakout */
  function scoreTrap(s, mom) {
    let score = 0;
    const reasons = [], penalties = [];

    // Price compressed — the tighter the better
    if (Math.abs(s.h1) < 2 && Math.abs(s.m5) < 1) {
      score += 30; reasons.push('Price tightly compressed');
    } else if (Math.abs(s.h1) < 4 && Math.abs(s.m5) < 2) {
      score += 20; reasons.push('Price range compressed');
    }

    // Volume rising (loading pressure)
    if (s.volAccel > 2.0) {
      score += 25; reasons.push(`Volume accelerating ${s.volAccel.toFixed(1)}×`);
    } else if (s.volAccel > 1.5) {
      score += 15; reasons.push('Volume rising');
    }

    // Buy pressure building
    if (s.buyRatioH1 > 0.62) {
      score += 25; reasons.push(`Buy pressure strong (${Math.round(s.buyRatioH1*100)}%)`);
    } else if (s.buyRatioH1 > 0.55) {
      score += 15; reasons.push(`Buy pressure building (${Math.round(s.buyRatioH1*100)}%)`);
    }

    // Liquidity stable and healthy
    if (s.liq >= 20000 && s.h1 > -5) {
      score += 20; reasons.push(`Stable liquidity ($${Math.round(s.liq/1000)}k)`);
    } else if (s.liq >= 10000 && s.h1 > -10) {
      score += 10; reasons.push('Liquidity holding');
    }

    // Momentum boosts
    if (mom) {
      if (mom.advanced?.liquidityStability?.value === 'stable') {
        score += 8; reasons.push('Liquidity confirmed stable');
      }
      if (mom.advanced?.whaleAbsence?.value === true) {
        score += 8; reasons.push('No whale dumps detected');
      }
      if (mom.signals?.buyPressure?.value >= 0.6) {
        score += 6; reasons.push('Confirmed buy pressure');
      }
    }

    // Penalties
    if (Math.abs(s.h1) > 8) {
      score -= 20; penalties.push('Price already moving too fast');
    }
    if (s.liq < 8000) {
      score -= 20; penalties.push('Thin liquidity — trap risk');
    }
    if (s.h1 < -10) {
      score -= 15; penalties.push('Liquidity declining');
    }

    return { score: clamp(score, 0, 100), reasons, penalties };
  }

  /** Breakout Score — momentum entry setup */
  function scoreBreakout(s, mom) {
    let score = 0;
    const reasons = [], penalties = [];

    // Price breaking
    if (s.m5 > 6) {
      score += 20; reasons.push(`Strong 5m move +${s.m5.toFixed(1)}%`);
    } else if (s.m5 > 3) {
      score += 12; reasons.push(`5m breakout +${s.m5.toFixed(1)}%`);
    }
    if (s.h1 > 20) {
      score += 15; reasons.push(`Strong 1h move +${s.h1.toFixed(1)}%`);
    } else if (s.h1 > 10) {
      score += 8; reasons.push(`1h momentum +${s.h1.toFixed(1)}%`);
    }

    // Volume spike
    if (s.volAccel > 4) {
      score += 25; reasons.push(`Volume spike ${s.volAccel.toFixed(1)}×`);
    } else if (s.volAccel > 2.5) {
      score += 18; reasons.push(`Volume surge ${s.volAccel.toFixed(1)}×`);
    } else if (s.volAccel > 1.5) {
      score += 8; reasons.push('Volume rising');
    }

    // Buyer spike
    if (s.buyRatioH1 > 0.70) {
      score += 20; reasons.push(`Buyers dominating (${Math.round(s.buyRatioH1*100)}%)`);
    } else if (s.buyRatioH1 > 0.60) {
      score += 12; reasons.push(`Strong buy side (${Math.round(s.buyRatioH1*100)}%)`);
    }

    // Liquidity healthy
    if (s.liq >= 20000) {
      score += 10; reasons.push('Healthy liquidity');
    } else if (s.liq >= 10000) {
      score += 5;
    }

    // Momentum boosts
    if (mom) {
      const va = mom.acceleration?.volumeAccel;
      if (va === '5x+' || va === '10x+') {
        score += 10; reasons.push('Birdeye volume explosion');
      } else if (va === '3x+') {
        score += 6; reasons.push('Birdeye volume spike');
      }
      if (mom.signals?.uniqueBuyers?.value >= 0.6) {
        score += 8; reasons.push('Unique buyer surge');
      }
      if (mom.advanced?.smartWalletInflow?.value > 0) {
        score += 8; reasons.push('Smart wallets chasing');
      }
    }

    // Penalties
    if (s.vlRatio > 10) {
      score -= 20; penalties.push('Wash trading risk');
    }
    if (s.ageHours < 1 && (s.h24 > 200 || s.h1 > 100)) {
      score -= 15; penalties.push('Likely new-token pump — caution');
    }
    if (s.buyRatioH1 > 0.85 && s.ageHours < 3) {
      score -= 10; penalties.push('Possible bot buy inflation');
    }

    return { score: clamp(score, 0, 100), reasons, penalties };
  }

  /** Distribution Score — signals to avoid (higher = more dangerous) */
  function scoreDist(s, mom) {
    let score = 0;
    const reasons = [], penalties = [];

    // Price stalling after a run
    if (s.h1 < 2 && s.h24 > 30) {
      score += 30; reasons.push(`Stalling after +${s.h24.toFixed(0)}% run`);
    } else if (s.h1 < 5 && s.h24 > 15) {
      score += 15; reasons.push('Momentum losing steam');
    }

    // Sell pressure increasing
    if (s.buyRatioH1 < 0.40) {
      score += 30; reasons.push(`Sells dominating (${Math.round((1-s.buyRatioH1)*100)}% sells)`);
    } else if (s.buyRatioH1 < 0.48) {
      score += 18; reasons.push('Sell pressure rising');
    }

    // High volume but price not moving (supply absorption)
    if (s.vol1h > (s.vol24h / 24) * 2 && Math.abs(s.h1) < 3) {
      score += 25; reasons.push('High vol, price not moving (supply overhead)');
    } else if (s.vol1h > (s.vol24h / 24) * 1.5 && s.h1 < 2) {
      score += 15; reasons.push('Volume absorbed, price stalling');
    }

    // Momentum penalties (whale selling)
    if (mom) {
      if (mom.advanced?.whaleAbsence?.value === false) {
        score += 15; reasons.push('Whale activity detected');
      }
      if (mom.signals?.volumeGrowth?.value < 0) {
        score += 8; reasons.push('Volume declining');
      }
    }

    return { score: clamp(score, 0, 100), reasons, penalties };
  }

  // ── Rug-flag penalty to finalScore ───────────────────────────
  function calcRugPenalty(s) {
    let rugPenalty = 0;
    s.rugFlags.forEach(f => {
      if (f.severity === 'critical') rugPenalty += 8;
      else if (f.severity === 'high') rugPenalty += 5;
      else rugPenalty += 3;
    });
    return Math.min(20, rugPenalty); // cap at 20
  }

  // ── Tier label for the final score ───────────────────────────
  function scoreTier(finalScore) {
    if (finalScore >= 80) return { label: 'Strong Setup',  cls: 'tier-strong',  emoji: '🔥' };
    if (finalScore >= 65) return { label: 'Good Setup',    cls: 'tier-good',    emoji: '✅' };
    if (finalScore >= 50) return { label: 'Watch',         cls: 'tier-watch',   emoji: '👀' };
    if (finalScore >= 30) return { label: 'Weak',          cls: 'tier-weak',    emoji: '⚡' };
    return                        { label: 'Avoid',         cls: 'tier-avoid',   emoji: '⚠️' };
  }

  // ── Phase badge metadata ─────────────────────────────────────
  const PHASE_META = {
    launch:        { emoji: '🆕', label: 'Launch',      color: '#06b6d4', border: '#06b6d4' },
    accumulation:  { emoji: '📦', label: 'Accum',       color: '#22c55e', border: '#22c55e' },
    liquidity_trap:{ emoji: '🪤', label: 'Trap',        color: '#8b5cf6', border: '#8b5cf6' },
    breakout:      { emoji: '🚀', label: 'Breakout',    color: '#f59e0b', border: '#f59e0b' },
    distribution:  { emoji: '⚠️', label: 'Dist',        color: '#ef4444', border: '#ef4444' },
  };

  // ── Main classify function ────────────────────────────────────
  /**
   * PhaseClassifier.classify(token, momentumResult?)
   * @param token         Token object from Scanner.formatToken()
   * @param momentumResult (optional) Result from MomentumDetector.analyze()
   * @returns {
   *   phase, phaseMeta,
   *   accumScore, trapScore, breakoutScore, distScore,
   *   finalScore, reasons, penalties, tier
   * }
   */
  function classify(token, momentumResult) {
    const mom = momentumResult || null;
    const s = extractSignals(token);

    // Hard reject: untradeable liquidity
    if (s.liq < 500) {
      return {
        phase: 'distribution', phaseMeta: PHASE_META.distribution,
        accumScore: 0, trapScore: 0, breakoutScore: 0, distScore: 100,
        finalScore: 0,
        reasons: ['Liquidity < $500 — untradeable'],
        penalties: ['HARD REJECT: extreme thin pool'],
        tier: { label: 'Avoid', cls: 'tier-avoid', emoji: '⚠️' }
      };
    }

    // Hard reject: obvious rug (price down 90%+ in 1h AND low liq)
    if (s.h1 < -85 && s.liq < 5000) {
      return {
        phase: 'distribution', phaseMeta: PHASE_META.distribution,
        accumScore: 0, trapScore: 0, breakoutScore: 0, distScore: 100,
        finalScore: 0,
        reasons: ['Price crashed 85%+ in 1h — possible rug'],
        penalties: ['HARD REJECT: rug/dump signature'],
        tier: { label: 'Avoid', cls: 'tier-avoid', emoji: '⚠️' }
      };
    }

    const phase = detectPhase(s);
    const phaseMeta = PHASE_META[phase] || PHASE_META.accumulation;

    const accumResult    = scoreAccum(s, mom);
    const trapResult     = scoreTrap(s, mom);
    const breakoutResult = scoreBreakout(s, mom);
    const distResult     = scoreDist(s, mom);

    const accumScore    = accumResult.score;
    const trapScore     = trapResult.score;
    const breakoutScore = breakoutResult.score;
    const distScore     = distResult.score;

    // Best opportunity score
    const baseScore = Math.max(accumScore, trapScore, breakoutScore);

    // Risk penalties
    const rugPenalty    = calcRugPenalty(s);
    const distPenalty   = distScore > 50 ? (distScore - 50) * 0.5 : 0;
    const liqPenalty    = s.liq < 5000 ? 20 : 0;
    const washPenalty   = s.vlRatio > 10 ? 15 : s.vlRatio > 5 ? 5 : 0;
    const riskPenalty   = Math.min(50, rugPenalty + distPenalty + liqPenalty + washPenalty);

    let finalScore = clamp(Math.round(baseScore - riskPenalty), 0, 100);

    // Wash trading hard-caps finalScore at 45
    if (s.vlRatio > 10) finalScore = Math.min(finalScore, 45);

    // Pick the best reasons list based on phase
    let reasons = [];
    if (phase === 'breakout')       reasons = breakoutResult.reasons;
    else if (phase === 'liquidity_trap') reasons = trapResult.reasons;
    else if (phase === 'distribution')  reasons = distResult.reasons;
    else                                reasons = accumResult.reasons;

    // Merge relevant penalties
    const allPenalties = [
      ...accumResult.penalties,
      ...trapResult.penalties,
      ...breakoutResult.penalties
    ].filter(Boolean);

    const tier = scoreTier(finalScore);

    return {
      phase,
      phaseMeta,
      accumScore,
      trapScore,
      breakoutScore,
      distScore,
      finalScore,
      reasons: reasons.slice(0, 5),
      penalties: allPenalties.slice(0, 3),
      tier
    };
  }

  return { classify, PHASE_META, extractSignals };
})();
