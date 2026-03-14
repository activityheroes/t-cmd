// ════════════════════════════════════════════════════════════════════════
// TAX MODELS — Canonical data contracts for the T-CMD ingestion pipeline
//
// Every source (Solana, EVM, Binance, Kraken, Revolut, MEXC, CSV…) MUST
// produce NormalizedEvents by the end of Stage 2.  The tax engine ONLY
// ever receives NormalizedEvents — never raw API responses or CSV rows.
//
// The three core models are:
//   RawEvent         — raw source data, stored untouched (Stage 1)
//   NormalizedEvent  — common format after Stage 2 parsing
//   TaxEvent         — disposal/income after Stage 11 tax engine
// ════════════════════════════════════════════════════════════════════════

const TaxModels = (() => {

  // ── Pipeline stage registry ─────────────────────────────────────────
  const PIPELINE_STAGES = Object.freeze({
    IMPORT:        { id: 1,  name: 'import',      label: 'Import raw data' },
    PARSE:         { id: 2,  name: 'parse',        label: 'Source-specific parsing' },
    PREFILTER:     { id: 3,  name: 'prefilter',    label: 'Pre-filtering noise & failures' },
    RESOLVE:       { id: 4,  name: 'resolve',      label: 'Asset & token resolution' },
    SPAM:          { id: 5,  name: 'spam',         label: 'Spam & dust detection' },
    RECONSTRUCT:   { id: 6,  name: 'reconstruct',  label: 'Transaction reconstruction' },
    MATCH:         { id: 7,  name: 'match',        label: 'Transfer & bridge matching' },
    PRICE:         { id: 8,  name: 'price',        label: 'SEK price assignment' },
    INVENTORY:     { id: 9,  name: 'inventory',    label: 'Inventory & cost basis' },
    REVIEW:        { id: 10, name: 'review',       label: 'Review issue generation' },
    TAX_EVENTS:    { id: 11, name: 'taxevents',    label: 'Tax event generation' },
    REPORT:        { id: 12, name: 'report',       label: 'Swedish K4 reporting' },
  });

  // ── Source type registry ────────────────────────────────────────────
  const SOURCE_TYPES = Object.freeze({
    // Blockchains (on-chain wallet imports)
    SOLANA:     'solana_wallet',
    ETHEREUM:   'eth_wallet',
    BASE:       'base_wallet',
    ARBITRUM:   'arbitrum_wallet',
    AVALANCHE:  'avalanche_wallet',
    BNB_CHAIN:  'bnb_wallet',
    POLYGON:    'polygon_wallet',
    // Exchange CSV imports
    BINANCE:    'binance_csv',
    KRAKEN:     'kraken_csv',
    BYBIT:      'bybit_csv',
    COINBASE:   'coinbase_csv',
    REVOLUT:    'revolut_csv',
    MEXC:       'mexc_csv',
    SOLSCAN:    'solscan_csv',
    GENERIC:    'generic_csv',
    // Manual
    MANUAL:     'manual',
  });

  // ── Event status codes ──────────────────────────────────────────────
  const EVENT_STATUS = Object.freeze({
    CONFIRMED:  'confirmed',
    FAILED:     'failed',
    CANCELLED:  'cancelled',
    PENDING:    'pending',
    UNKNOWN:    'unknown',
  });

  // ── Pre-filter reason codes ──────────────────────────────────────────
  // Every filtered event keeps its reason for the audit trail.
  const FILTER_REASON = Object.freeze({
    FAILED_TX:          'failed_tx',           // on-chain tx failed / reverted
    CANCELLED_ORDER:    'cancelled_order',     // exchange order cancelled
    ZERO_VALUE:         'zero_value',          // no economic content (0 amt, 0 fee)
    APPROVAL_TX:        'approval_tx',         // ERC-20 approve call (no asset movement)
    ACCOUNT_CREATION:   'account_creation',    // Solana token-account init
    SPAM_METADATA:      'spam_metadata',       // URL/scam pattern in metadata
    DUST_AMOUNT:        'dust_amount',         // below minimum reportable threshold
    EXACT_DUPLICATE:    'exact_duplicate',     // already present (same hash+source)
    NON_ECONOMIC_INSTR: 'non_economic',        // program call with no value transfer
    INTERNAL_FEE_ONLY:  'internal_fee_only',   // exchange fee rebate / referral credit
  });

  // ── Price source codes (mirrors PS in tax-engine.js) ───────────────
  const PRICE_SOURCE = Object.freeze({
    MANUAL:         'manual',
    STABLE:         'stable_rate',
    TRADE_EXACT:    'trade_exact',
    SWAP_IMPLIED:   'swap_implied',
    SWAP_AT_COST:   'swap_at_cost',
    MARKET_API:     'market_api',
    GT_DEX:         'gecko_terminal',
    SAME_DAY:       'same_day_propagated',
    BACK_DERIVED:   'back_derived',
    FX_RATE:        'fx_rate',
    MISSING:        'missing',
  });

  // ── Price confidence codes ──────────────────────────────────────────
  const PRICE_CONFIDENCE = Object.freeze({
    EXACT:          'exact',
    HIGH:           'high',
    INFERRED_HIGH:  'inferred_high',
    INFERRED_MED:   'medium',
    LOW:            'low',
    SPAM_ZERO:      'spam_zero',
    RECEIVED_UNSOLD:'received_unsold',
    UNKNOWN_MANUAL: 'unknown_manual',
  });

  // ── Utility: stable unique ID ───────────────────────────────────────
  let _seq = 0;
  function mkId(prefix = 'evt') {
    return `${prefix}_${Date.now()}_${(++_seq).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }

  // ════════════════════════════════════════════════════════════════════
  // MODEL 1 — RawEvent
  // The unmodified source record stored in Stage 1 before any parsing.
  // Never modified after creation.  Used for re-processing and audit.
  // ════════════════════════════════════════════════════════════════════
  function createRawEvent(source, accountId, rawData) {
    if (!source) throw new Error('createRawEvent: source is required');
    if (!rawData) throw new Error('createRawEvent: rawData is required');
    return Object.freeze({
      rawId:      mkId('raw'),
      source,                        // SOURCE_TYPES value
      accountId:  accountId || null,
      importedAt: new Date().toISOString(),
      data:       Object.freeze(typeof rawData === 'object' ? { ...rawData } : { raw: rawData }),
    });
  }

  // ════════════════════════════════════════════════════════════════════
  // MODEL 2 — NormalizedEvent
  // The canonical format that every Stage-2 parser MUST produce.
  // The pipeline only advances NormalizedEvents; never raw data.
  //
  // Field contract:
  //   • Every field has a defined default — parsers fill what they know.
  //   • Fields marked (Stage N) are populated by that pipeline stage.
  //   • Fields marked (immutable) are set at creation and never changed.
  // ════════════════════════════════════════════════════════════════════
  function createNormalizedEvent(fields = {}) {
    const now = new Date().toISOString();

    const evt = {
      // ── Identity (immutable) ────────────────────────────────────────
      id:             fields.id           || mkId('txn'),
      rawId:          fields.rawId        || null,   // links to RawEvent.rawId
      source:         fields.source       || SOURCE_TYPES.GENERIC,
      accountId:      fields.accountId    || null,
      importedAt:     fields.importedAt   || now,

      // ── Blockchain context ──────────────────────────────────────────
      chain:          fields.chain        || null,   // 'solana'|'ethereum'|'bnb'|…
      txHash:         fields.txHash       || null,
      blockHeight:    fields.blockHeight  || null,
      programId:      fields.programId    || null,   // Solana: instruction program

      // ── Timing ─────────────────────────────────────────────────────
      date:           fields.date         || now,    // ISO 8601

      // ── Status (Stage 3 uses this to pre-filter) ────────────────────
      status:         fields.status       || EVENT_STATUS.CONFIRMED,
      rawStatus:      fields.rawStatus    || null,   // original status string from source

      // ── Outbound leg (what wallet sent / exchange sold) ─────────────
      sentAsset:      (fields.sentAsset   || '').toUpperCase() || null,
      sentAmount:     Math.abs(parseFloat(fields.sentAmount) || 0),
      sentAddress:    fields.sentAddress  || null,   // contract/mint address

      // ── Inbound leg (what wallet received / exchange bought) ────────
      receivedAsset:  (fields.receivedAsset  || '').toUpperCase() || null,
      receivedAmount: Math.abs(parseFloat(fields.receivedAmount) || 0),
      receivedAddress: fields.receivedAddress || null,

      // ── Fee ────────────────────────────────────────────────────────
      feeAsset:       (fields.feeAsset    || '').toUpperCase() || null,
      feeAmount:      Math.abs(parseFloat(fields.feeAmount) || 0),
      feeSEK:         parseFloat(fields.feeSEK)   || 0,

      // ── Source price info (from exchange/blockchain metadata) ───────
      // "Level 1" pricing: the price as reported by the source, in quote currency.
      // This is the most accurate price and takes precedence over market lookups.
      rawTradePriceCurrency: (fields.rawTradePriceCurrency || '').toUpperCase() || null,
      rawTradePrice:  parseFloat(fields.rawTradePrice) || null,
      rawQuoteAmount: parseFloat(fields.rawQuoteAmount) || null,  // total quote value

      // ── SEK pricing (Stage 8) ───────────────────────────────────────
      priceSEKPerUnit: parseFloat(fields.priceSEKPerUnit) || 0,
      costBasisSEK:   parseFloat(fields.costBasisSEK)    || 0,
      priceSource:    fields.priceSource    || PRICE_SOURCE.MISSING,
      priceConfidence: fields.priceConfidence || null,
      priceDerivedFromOtherLeg: fields.priceDerivedFromOtherLeg || false,

      // ── Classification (Stage 6 reconstruction) ─────────────────────
      // 'category' maps to the CAT enum in tax-engine.js
      category:       fields.category     || 'receive',
      autoClassified: fields.autoClassified !== undefined ? fields.autoClassified : false,
      rawType:        (fields.rawType     || '').toLowerCase(),  // source's original type string

      // ── Asset resolution (Stage 4) ──────────────────────────────────
      assetSymbol:    (fields.assetSymbol || fields.sentAsset || '').toUpperCase() || null,
      assetName:      fields.assetName    || '',
      contractAddress: fields.contractAddress || fields.sentAddress || null,
      coinGeckoId:    fields.coinGeckoId  || null,
      // The trade "in-side" (what was received in a TRADE event):
      inAsset:        (fields.inAsset     || fields.receivedAsset || '').toUpperCase() || null,
      inAmount:       Math.abs(parseFloat(fields.inAmount || fields.receivedAmount) || 0),

      // ── Transfer matching (Stage 7) ─────────────────────────────────
      isInternalTransfer: fields.isInternalTransfer || false,
      transferMatchId:    fields.transferMatchId    || null,

      // ── Review flags ────────────────────────────────────────────────
      needsReview:    fields.needsReview !== undefined ? fields.needsReview : true,
      reviewReason:   fields.reviewReason || null,
      isK4Blocker:    fields.isK4Blocker  || false,
      isDuplicate:    fields.isDuplicate  || false,
      userReviewed:   fields.userReviewed || false,

      // ── Spam / dust flags (Stage 5) ─────────────────────────────────
      isSpam:         fields.isSpam       || false,
      isDust:         fields.isDust       || false,
      spamReason:     fields.spamReason   || null,

      // ── Pre-filter (Stage 3) ────────────────────────────────────────
      // Events that PASS the filter have filtered=false.
      // Events that DON'T PASS are removed from the pipeline but kept in
      // the audit log with filtered=true and filterReason set.
      filtered:       fields.filtered     || false,
      filterReason:   fields.filterReason || null,

      // ── Solana-specific metadata ────────────────────────────────────
      solanaSwapType: fields.solanaSwapType || null,
      solanaProgram:  fields.solanaProgram  || null,

      // ── Notes ───────────────────────────────────────────────────────
      notes:          fields.notes        || '',
      description:    fields.description  || '',

      // ── Manual override ─────────────────────────────────────────────
      manualCategory: fields.manualCategory || false,
      manualPrice:    fields.manualPrice    || false,
    };

    return evt;
  }

  // ── Validate NormalizedEvent at Stage 2 exit ─────────────────────
  // Returns { valid: bool, errors: string[] }
  function validateNormalizedEvent(evt) {
    const errors = [];
    if (!evt.id)          errors.push('id is required');
    if (!evt.source)      errors.push('source is required');
    if (!evt.accountId)   errors.push('accountId is required');
    if (!evt.date)        errors.push('date is required');
    if (!evt.status)      errors.push('status is required');
    if (!(evt.sentAmount > 0) && !(evt.receivedAmount > 0) && !(evt.feeAmount > 0)) {
      // At least one leg must have a non-zero amount (or it's a zero-value event)
      // We don't error here — Stage 3 will filter it if it has no economic content
    }
    if (evt.date && isNaN(new Date(evt.date).getTime())) {
      errors.push(`date is not a valid ISO string: ${evt.date}`);
    }
    return { valid: errors.length === 0, errors };
  }

  // ════════════════════════════════════════════════════════════════════
  // MODEL 3 — TaxEvent
  // Output of Stage 11.  The tax engine never produces or modifies
  // NormalizedEvents directly — it reads priced NormalizedEvents and
  // emits TaxEvents (capital disposals + income events).
  // ════════════════════════════════════════════════════════════════════
  function createTaxEvent(fields = {}) {
    return {
      id:             fields.id           || mkId('tax'),
      sourceEventId:  fields.sourceEventId || null,   // links to NormalizedEvent.id
      date:           fields.date         || null,
      year:           fields.year         || null,

      // ── Classification ──────────────────────────────────────────────
      eventType:      fields.eventType    || 'disposal',  // 'disposal' | 'income' | 'fee_disposal'
      country:        fields.country      || 'SE',

      // ── Asset ───────────────────────────────────────────────────────
      assetSymbol:    fields.assetSymbol  || null,
      assetName:      fields.assetName    || null,
      amountDisposed: parseFloat(fields.amountDisposed) || 0,

      // ── Swedish tax amounts ─────────────────────────────────────────
      proceedsSEK:    parseFloat(fields.proceedsSEK)    || 0,
      costBasisSEK:   parseFloat(fields.costBasisSEK)   || 0,
      feeSEK:         parseFloat(fields.feeSEK)         || 0,
      gainLossSEK:    parseFloat(fields.gainLossSEK)    || 0,
      avgCostAtSale:  parseFloat(fields.avgCostAtSale)  || 0,

      // ── Quality flags ───────────────────────────────────────────────
      unknownAcquisition: fields.unknownAcquisition || false,
      proceedsSource:     fields.proceedsSource     || null,   // 'swap_at_cost' etc.
      confidence:         fields.confidence         || 'exact',

      // ── Swedish K4 metadata ─────────────────────────────────────────
      k4Section:      fields.k4Section    || 'D',     // always D for crypto
      isTrade:        fields.isTrade      || false,
      isFee:          fields.isFee        || false,
      needsReview:    fields.needsReview  || false,
    };
  }

  // ── Pipeline result envelope ─────────────────────────────────────
  // Wraps the output of each stage with diagnostics for debugging.
  function createStageResult(stageId, stageName, inputCount, events, filtered = [], meta = {}) {
    return {
      stageId,
      stageName,
      inputCount,
      outputCount:   events.length,
      filteredCount: filtered.length,
      filtered,     // Array of { event, reason } for audit trail
      events,       // The live events passing to next stage
      meta,         // Any stage-specific debug info
      timestamp:    new Date().toISOString(),
    };
  }

  // ── Source type detector ─────────────────────────────────────────
  // Given a source string (e.g. 'binance_csv'), returns the canonical type.
  function detectSourceType(source) {
    if (!source) return SOURCE_TYPES.GENERIC;
    const s = source.toLowerCase();
    if (s.includes('solana')) return SOURCE_TYPES.SOLANA;
    if (s.includes('arbitrum')) return SOURCE_TYPES.ARBITRUM;
    if (s.includes('avalanche') || s.includes('avax')) return SOURCE_TYPES.AVALANCHE;
    if (s.includes('bnb') || s.includes('bsc')) return SOURCE_TYPES.BNB_CHAIN;
    if (s.includes('base')) return SOURCE_TYPES.BASE;
    if (s.includes('polygon') || s.includes('matic')) return SOURCE_TYPES.POLYGON;
    if (s.includes('eth')) return SOURCE_TYPES.ETHEREUM;
    if (s.includes('binance')) return SOURCE_TYPES.BINANCE;
    if (s.includes('kraken')) return SOURCE_TYPES.KRAKEN;
    if (s.includes('bybit')) return SOURCE_TYPES.BYBIT;
    if (s.includes('coinbase')) return SOURCE_TYPES.COINBASE;
    if (s.includes('revolut')) return SOURCE_TYPES.REVOLUT;
    if (s.includes('mexc')) return SOURCE_TYPES.MEXC;
    if (s.includes('solscan')) return SOURCE_TYPES.SOLSCAN;
    if (s.includes('manual')) return SOURCE_TYPES.MANUAL;
    return SOURCE_TYPES.GENERIC;
  }

  // ── Public API ───────────────────────────────────────────────────
  return {
    PIPELINE_STAGES,
    SOURCE_TYPES,
    EVENT_STATUS,
    FILTER_REASON,
    PRICE_SOURCE,
    PRICE_CONFIDENCE,
    createRawEvent,
    createNormalizedEvent,
    validateNormalizedEvent,
    createTaxEvent,
    createStageResult,
    detectSourceType,
    mkId,
  };

})();
