/**
 * ProvenanceScorer — shared scoring engine for all provenance / transfer-matching
 *
 * Weighted confidence model:
 *   asset(35%) + amount(25%) + time(15%) + ownership(15%) + sourceFlow(10%)
 *   minus penalty adjustments
 *
 * Bands (defaultScoreConfig):
 *   high   ≥ 0.80 → auto-resolve eligible
 *   medium ≥ 0.50 → show as suggestion
 *   low    < 0.50 → manual review required
 *
 * Used by:
 *   - tax-engine.js resolveUnknownAcquisitions Pass 1 (internal transfer scoring)
 *   - matchTransfers Pass 5 (provenance-linked RECEIVE)
 *   - UI review page candidate drawer
 *
 * @version 1
 */

/* global window, AssetIdentity */

// ── Default configuration ───────────────────────────────────────────────────
const defaultScoreConfig = {
  autoResolveThreshold:  0.80,
  suggestThreshold:      0.50,

  // Time windows (hours)
  maxHoursStrong:  24,        // ≤24h  → score 1.0
  maxHoursMedium:  96,        // ≤96h  → score 0.85
  maxHoursWeak:    24 * 7,    // ≤7d   → score 0.60 (>7d = 0)

  // Amount tolerances (relative diff as fraction)
  amountToleranceTight:   0.01,   // ≤1%  → 1.0
  amountToleranceMedium:  0.03,   // ≤3%  → 0.9
  amountToleranceLoose:   0.05,   // ≤5%  → 0.7
  // 5–8% → 0.5, >8% → 0

  // Absolute dust tolerance per economic asset id (in native units)
  dustAbsToleranceByAsset: {
    SOL:  0.01,
    ETH:  0.001,
    USDC: 1.0,
    USDT: 1.0,
    USDC_E: 1.0,
    USDBC: 1.0,
  },
};

// ── CandidateKind values ────────────────────────────────────────────────────
const CANDIDATE_KINDS = /** @type {const} */ ({
  INTERNAL_TRANSFER:            'internal_transfer',
  EXCHANGE_WITHDRAWAL_TO_WALLET:'exchange_withdrawal_to_wallet',
  EXCHANGE_BUY_PREDECESSOR:     'exchange_buy_predecessor',
  BRIDGE_TRANSFER:              'bridge_transfer',
  WRAPPED_NATIVE_EQUIVALENT:    'wrapped_native_equivalent',
  STABLECOIN_FAMILY_MATCH:      'stablecoin_family_match',
  UNKNOWN:                      'unknown',
});

// ── Resolution actions ──────────────────────────────────────────────────────
const RESOLUTION_ACTIONS = /** @type {const} */ ({
  AUTO_LINK_INTERNAL:   'auto_link_internal_transfer',
  AUTO_LINK_EXCHANGE:   'auto_link_exchange_to_wallet',
  AUTO_RESOLVE_STABLE:  'auto_resolve_stablecoin_price',
  AUTO_MARK_SPAM:       'auto_mark_spam',
  SUGGEST_OPENING_BAL:  'suggest_opening_balance',
  MANUAL_REVIEW:        'manual_review',
});

// ── Human-readable reason labels (for UI display) ──────────────────────────
const REASON_LABELS = {
  same_economic_asset:           'Samma ekonomiska tillgång',
  same_strict_asset:             'Exakt samma token',
  amount_within_tolerance:       'Belopp inom tolerans',
  close_in_time:                 'Nära i tid',
  owned_wallet_or_exchange_path: 'Känt ägarbyte',
  wrapped_native_bridge:         'Wrapped/native-ekvivalent',
  prior_exchange_buy_found:      'Tidigare börsinköp hittades',
  different_account:             'Annat konto (cross-account)',
};

// ── ProvenanceScorer class ──────────────────────────────────────────────────
class ProvenanceScorer {
  /**
   * @param {typeof defaultScoreConfig} cfg
   */
  constructor(cfg = defaultScoreConfig) {
    this.cfg = Object.assign({}, defaultScoreConfig, cfg || {});
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Score a single (subject, candidate) pair.
   * Returns { candidate, score, confidence, breakdown, suggestedAction, reasons }
   */
  score(subject, candidate) {
    const assetMatch      = this._scoreAssetMatch(subject, candidate);
    const amountMatch     = this._scoreAmountMatch(subject, candidate);
    const timeMatch       = this._scoreTimeMatch(subject, candidate);
    const ownershipMatch  = this._scoreOwnershipMatch(subject, candidate);
    const sourceFlowMatch = this._scoreSourceFlowMatch(subject, candidate);
    const penalties       = this._scorePenalties(subject, candidate);

    const totalRaw =
      assetMatch      * 0.35 +
      amountMatch     * 0.25 +
      timeMatch       * 0.15 +
      ownershipMatch  * 0.15 +
      sourceFlowMatch * 0.10 -
      penalties;

    const total      = Math.max(0, Math.min(1, totalRaw));
    const confidence = this._band(total);
    const breakdown  = {
      assetMatch, amountMatch, timeMatch,
      ownershipMatch, sourceFlowMatch, penalties, total,
    };
    const reasons         = this._buildReasons(subject, candidate, breakdown);
    const suggestedAction = this._actionFor(subject, candidate, total);

    return { candidate, score: total, confidence, breakdown, suggestedAction, reasons };
  }

  /**
   * Score all candidates for a subject, sorted best-first.
   */
  scoreAll(subject, candidates) {
    return (candidates || [])
      .map(c => this.score(subject, c))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Pick the single best candidate (or null if none).
   */
  pickBest(subject, candidates) {
    const scored = this.scoreAll(subject, candidates);
    return scored[0] ?? null;
  }

  // ── Sub-scorers ─────────────────────────────────────────────────────────────

  _scoreAssetMatch(subject, candidate) {
    // Exact token-level match beats economic family match
    if (subject.strictId && subject.strictId === candidate.strictId) return 1.0;
    if (subject.economicId && subject.economicId === candidate.economicId) return 0.9;
    // symbol-level fallback (for older rows without strictId/economicId)
    if (subject.symbol && subject.symbol === candidate.symbol) return 0.85;
    return 0;
  }

  _scoreAmountMatch(subject, candidate) {
    const a      = Math.abs(subject.amount  || 0);
    const b      = Math.abs(candidate.amount || 0);
    if (a === 0 && b === 0) return 1;
    const max    = Math.max(a, b, 1e-12);
    const diff   = Math.abs(a - b);
    const diffRel = diff / max;

    // Absolute dust tolerance check (e.g. SOL fees)
    const absTol = (this.cfg.dustAbsToleranceByAsset || {})[subject.economicId] ?? 0;
    if (diff <= absTol) return 1.0;

    if (diffRel <= this.cfg.amountToleranceTight)   return 1.0;
    if (diffRel <= this.cfg.amountToleranceMedium)  return 0.9;
    if (diffRel <= this.cfg.amountToleranceLoose)   return 0.7;
    if (diffRel <= 0.08)                            return 0.5;
    return 0;
  }

  _scoreTimeMatch(subject, candidate) {
    const tA   = new Date(subject.timestamp).getTime();
    const tB   = new Date(candidate.timestamp).getTime();
    if (isNaN(tA) || isNaN(tB)) return 0.5;  // unknown → neutral
    const hours = Math.abs(tA - tB) / 3_600_000;

    if (hours <= this.cfg.maxHoursStrong)  return 1.0;
    if (hours <= this.cfg.maxHoursMedium)  return 0.85;
    if (hours <= this.cfg.maxHoursWeak)    return 0.6;
    return 0;
  }

  _scoreOwnershipMatch(subject, candidate) {
    // Same account = NOT good for internal transfers (both legs must be different accounts)
    // but good signal for re-import / dedup scenarios
    const sAcct = subject.sourceAccountId;
    const cAcct = candidate.sourceAccountId;

    if (sAcct && cAcct) {
      if (sAcct === cAcct) {
        // Same account: suspicious for an internal transfer — penalise slightly
        // but don't zero out (could be a CEX showing both legs on same account)
        return 0.3;
      }
      // Different accounts — this is the expected internal transfer pattern
      return 0.9;
    }

    // Wallet ownership context (caller has verified both addresses belong to user)
    if (subject.hasOwnedWalletContext) return 0.9;

    // Different platforms → more likely cross-account user flow
    if (
      subject.sourcePlatform && candidate.sourcePlatform &&
      subject.sourcePlatform !== candidate.sourcePlatform
    ) return 0.8;

    return 0.4;  // no account info at all
  }

  _scoreSourceFlowMatch(subject, candidate) {
    switch (candidate.kind) {
      case CANDIDATE_KINDS.INTERNAL_TRANSFER:             return 1.0;
      case CANDIDATE_KINDS.EXCHANGE_WITHDRAWAL_TO_WALLET:
      case CANDIDATE_KINDS.EXCHANGE_BUY_PREDECESSOR:      return 0.95;
      case CANDIDATE_KINDS.BRIDGE_TRANSFER:               return 0.90;
      case CANDIDATE_KINDS.WRAPPED_NATIVE_EQUIVALENT:
      case CANDIDATE_KINDS.STABLECOIN_FAMILY_MATCH:       return 0.85;
      default:                                            return 0.40;
    }
  }

  _scorePenalties(subject, candidate) {
    let p = 0;
    // Different economic family despite same symbol is a big red flag
    if (
      subject.economicId && candidate.economicId &&
      subject.economicId !== candidate.economicId
    ) p += 0.30;
    // Both sides have no account info → low provenance confidence
    if (!subject.sourceAccountId && !candidate.sourceAccountId) p += 0.05;
    return p;
  }

  // ── Utility helpers ─────────────────────────────────────────────────────────

  _band(score) {
    if (score >= this.cfg.autoResolveThreshold) return 'high';
    if (score >= this.cfg.suggestThreshold)     return 'medium';
    return 'low';
  }

  _actionFor(subject, candidate, score) {
    if (subject.isStablecoin)                     return RESOLUTION_ACTIONS.AUTO_RESOLVE_STABLE;
    if (subject.isSpamCandidate || subject.isDust) return RESOLUTION_ACTIONS.AUTO_MARK_SPAM;

    if (score >= this.cfg.autoResolveThreshold) {
      if (
        candidate.kind === CANDIDATE_KINDS.INTERNAL_TRANSFER ||
        candidate.kind === CANDIDATE_KINDS.BRIDGE_TRANSFER ||
        candidate.kind === CANDIDATE_KINDS.WRAPPED_NATIVE_EQUIVALENT
      ) return RESOLUTION_ACTIONS.AUTO_LINK_INTERNAL;

      if (
        candidate.kind === CANDIDATE_KINDS.EXCHANGE_WITHDRAWAL_TO_WALLET ||
        candidate.kind === CANDIDATE_KINDS.EXCHANGE_BUY_PREDECESSOR
      ) return RESOLUTION_ACTIONS.AUTO_LINK_EXCHANGE;
    }

    if (score >= this.cfg.suggestThreshold) return RESOLUTION_ACTIONS.SUGGEST_OPENING_BAL;
    return RESOLUTION_ACTIONS.MANUAL_REVIEW;
  }

  _buildReasons(subject, candidate, bd) {
    const out = [];
    if (bd.assetMatch === 1.0)   out.push('same_strict_asset');
    else if (bd.assetMatch >= 0.85) out.push('same_economic_asset');
    if (bd.amountMatch >= 0.9)   out.push('amount_within_tolerance');
    if (bd.timeMatch   >= 0.85)  out.push('close_in_time');
    if (bd.ownershipMatch >= 0.8) out.push(
      subject.sourceAccountId !== candidate.sourceAccountId
        ? 'different_account'
        : 'owned_wallet_or_exchange_path'
    );
    if (candidate.kind === CANDIDATE_KINDS.WRAPPED_NATIVE_EQUIVALENT) out.push('wrapped_native_bridge');
    if (candidate.kind === CANDIDATE_KINDS.EXCHANGE_BUY_PREDECESSOR)  out.push('prior_exchange_buy_found');
    return out;
  }

  // ── Human-readable summary ──────────────────────────────────────────────────

  /**
   * Build a short Swedish explanation for the UI ("We found X because Y").
   * @param {object} subject  - SubjectRow
   * @param {object} result   - return value of score()
   * @returns {string}
   */
  buildExplanation(subject, result) {
    const { candidate, score, confidence, reasons } = result;
    const pct      = Math.round(score * 100);
    const confMap  = { high: 'hög', medium: 'medel', low: 'låg' };
    const confSwe  = confMap[confidence] || confidence;
    const sym      = subject.symbol || subject.economicId || '?';
    const candSym  = candidate.symbol || candidate.economicId || '?';
    const reasonSwe = reasons.map(r => REASON_LABELS[r] || r).join(', ');
    const candDate  = (candidate.timestamp || '').slice(0, 10);
    const candAmt   = typeof candidate.amount === 'number'
      ? candidate.amount.toFixed(4) : '?';
    const kindMap = {
      internal_transfer:             'intern transfer',
      exchange_withdrawal_to_wallet: 'börsuttag till plånbok',
      exchange_buy_predecessor:      'börsinköp',
      bridge_transfer:               'bridge-transfer',
      wrapped_native_equivalent:     'wrapped/native-ekvivalent',
      stablecoin_family_match:       'stablecoin-familj',
    };
    const kindSwe = kindMap[candidate.kind] || candidate.kind || 'transaktion';
    return `Hittade möjlig ${kindSwe}: ${candAmt} ${candSym} (${candDate}) — ${pct}% konfidens (${confSwe}). Orsaker: ${reasonSwe || 'ingen specifik matchning'}.`;
  }
}

// ── Batch helpers (client-side equivalents of /api/review/auto-resolve/preview) ──

/**
 * Build a preview summary of what auto-resolve would do.
 * @param {Array} disposals  - taxResult.disposals with autoResolve field
 * @returns {object}  preview summary matching API spec
 */
function previewAutoResolve(disposals) {
  const by_action = {};
  let highCount = 0, mediumCount = 0, lowCount = 0;
  const examples = [];

  for (const d of (disposals || [])) {
    if (!d.autoResolve) continue;
    const { action, confidence } = d.autoResolve;
    const conf  = typeof confidence === 'number' ? confidence : 0;
    const band  = conf >= 0.8 ? 'high' : conf >= 0.5 ? 'medium' : 'low';

    if (band === 'high')   highCount++;
    else if (band === 'medium') mediumCount++;
    else lowCount++;

    by_action[action] = (by_action[action] || 0) + 1;

    if (examples.length < 5 && band === 'high') {
      examples.push({
        row_id: d.id,
        asset:  d.assetSymbol,
        score:  conf,
        action,
        reason: d.scoreReasons || [],
      });
    }
  }

  return {
    eligible_count:          highCount + mediumCount + lowCount,
    high_confidence_count:   highCount,
    medium_confidence_count: mediumCount,
    low_confidence_count:    lowCount,
    by_action,
    examples,
  };
}

/**
 * Commit provenance links: score subjects against their candidate lists and
 * return structured resolution results (client-side equivalent of POST /api/review/auto-resolve/commit).
 *
 * @param {Array}  subjects           - SubjectRow[]
 * @param {object} candidatesByRowId  - Record<rowId, MatchCandidate[]>
 * @param {object} cfg                - optional ScoreConfig override
 * @returns {Array} resolution results
 */
function commitProvenanceLinks(subjects, candidatesByRowId, cfg) {
  const scorer  = new ProvenanceScorer(cfg || defaultScoreConfig);
  const results = [];

  for (const subject of (subjects || [])) {
    const candidates = (candidatesByRowId || {})[subject.rowId] ?? [];
    const best       = scorer.pickBest(subject, candidates);

    if (!best) {
      results.push({
        rowId:            subject.rowId,
        resolutionStatus: 'unresolved',
        suggestedAction:  RESOLUTION_ACTIONS.MANUAL_REVIEW,
      });
      continue;
    }

    const cfg2   = scorer.cfg;
    const status = best.score >= cfg2.autoResolveThreshold ? 'auto_resolved'
                 : best.score >= cfg2.suggestThreshold     ? 'suggested'
                 : 'manual_review';

    results.push({
      rowId:            subject.rowId,
      resolutionStatus: status,
      linkedRowId:      best.candidate.rowId,
      confidence:       best.confidence,
      suggestedAction:  best.suggestedAction,
      breakdown:        best.breakdown,
      reasons:          best.reasons,
    });
  }

  return results;
}

// ── Helper: build a SubjectRow from a disposal/transaction object ─────────────
/**
 * Convert a tax-engine disposal/transaction into a SubjectRow for the scorer.
 * This is the canonical mapping used by both tax-engine.js and tax-ui.js.
 */
function disposalToSubjectRow(d, { stableSet, spamCheck } = {}) {
  const _eco = sym =>
    (typeof AssetIdentity !== 'undefined') ? AssetIdentity.getEconomicId(sym) : sym;
  const sym = d.assetSymbol || '';
  return {
    rowId:              d.id,
    strictId:           sym,
    economicId:         d.economicId || _eco(sym),
    sourceAccountId:    d.accountId  || null,
    sourcePlatform:     d.source     || null,
    timestamp:          d.date,
    amount:             d.amountSold || d.amount || 0,
    isStablecoin:       stableSet  ? stableSet.has(sym)       : false,
    isSpamCandidate:    spamCheck  ? spamCheck(d)              : false,
    isDust:             false,
    hasOwnedWalletContext: false,
    symbol:             sym,
    chain:              d.chain || null,
  };
}

/**
 * Convert a transaction into a MatchCandidate for the scorer.
 */
function txnToMatchCandidate(t, kind) {
  const _eco = sym =>
    (typeof AssetIdentity !== 'undefined') ? AssetIdentity.getEconomicId(sym) : sym;
  const sym = t.assetSymbol || '';
  return {
    rowId:            t.id,
    kind:             kind || CANDIDATE_KINDS.INTERNAL_TRANSFER,
    strictId:         sym,
    economicId:       t.economicId || _eco(sym),
    sourceAccountId:  t.accountId  || null,
    sourcePlatform:   t.source     || null,
    timestamp:        t.date,
    amount:           t.amount     || 0,
    symbol:           sym,
    metadata: {
      category:  t.category,
      txHash:    t.txHash,
    },
  };
}

// ── Expose as globals (non-module browser environment) ────────────────────────
if (typeof window !== 'undefined') {
  window.ProvenanceScorer        = ProvenanceScorer;
  window.defaultScoreConfig      = defaultScoreConfig;
  window.CANDIDATE_KINDS         = CANDIDATE_KINDS;
  window.RESOLUTION_ACTIONS      = RESOLUTION_ACTIONS;
  window.REASON_LABELS           = REASON_LABELS;
  window.commitProvenanceLinks   = commitProvenanceLinks;
  window.previewAutoResolve      = previewAutoResolve;
  window.disposalToSubjectRow    = disposalToSubjectRow;
  window.txnToMatchCandidate     = txnToMatchCandidate;
}
