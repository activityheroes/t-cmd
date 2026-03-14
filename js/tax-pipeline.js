// ════════════════════════════════════════════════════════════════════════
// TAX PIPELINE — 12-Stage Ingestion Architecture
//
// Architecture rule:
//   Raw source data MUST NEVER reach tax calculations directly.
//   Every source goes through all 12 stages in order.
//
// Stage flow:
//   1  Import       raw source data → stored untouched
//   2  Parse        source-specific → NormalizedEvent[]
//   3  Pre-filter   remove failed/noise/non-economic events
//   4  Resolve      token metadata → symbols, names, addresses
//   5  Spam         detect worthless/dust/scam tokens
//   6  Reconstruct  movements → real economic events (swaps, trades)
//   7  Match        transfers across accounts (non-taxable)
//   8  Price        assign SEK values with source + confidence
//   9  Inventory    build cost basis (Genomsnittsmetoden)
//  10  Review       generate exception queue
//  11  Tax events   disposals + income events
//  12  Report       Swedish K4 (SKV 2104 Section D)
// ════════════════════════════════════════════════════════════════════════

const TaxPipeline = (() => {

  // ════════════════════════════════════════════════════════════════════
  // STAGE 1 — RAW DATA STORE
  // Stores raw source records exactly as received.
  // Purpose: audit trail, re-processing on parser improvements,
  //          debugging incorrect tax results back to their source.
  // Stored in IndexedDB under 'raw_events' store (separate from txns).
  // ════════════════════════════════════════════════════════════════════
  const RawDataStore = (() => {
    const DB_NAME    = 'tcmd_raw_events';
    const STORE_NAME = 'raw_events';
    const DB_VER     = 1;
    let _db = null;

    function _open() {
      if (_db) return Promise.resolve(_db);
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = e => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'rawId' });
            store.createIndex('by_source',    'source',    { unique: false });
            store.createIndex('by_accountId', 'accountId', { unique: false });
            store.createIndex('by_importedAt','importedAt',{ unique: false });
          }
        };
        req.onsuccess = e => { _db = e.target.result; resolve(_db); };
        req.onerror   = () => reject(req.error);
      });
    }

    // Store an array of RawEvents.  Skips exact-duplicate rawIds.
    async function store(rawEvents) {
      if (!rawEvents || rawEvents.length === 0) return 0;
      const db = await _open();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      let stored = 0;
      for (const evt of rawEvents) {
        try {
          await new Promise((res, rej) => {
            const req = store.add(evt);
            req.onsuccess = () => { stored++; res(); };
            req.onerror   = () => res(); // skip duplicates
          });
        } catch (_) { /* skip */ }
      }
      return stored;
    }

    // Get all raw events for a specific account
    async function getByAccount(accountId) {
      const db = await _open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const idx = tx.objectStore(STORE_NAME).index('by_accountId');
        const req = idx.getAll(accountId);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror   = () => reject(req.error);
      });
    }

    // Delete all raw events for a specific account (on account removal)
    async function deleteByAccount(accountId) {
      const db = await _open();
      const allEvents = await getByAccount(accountId);
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const evt of allEvents) {
        store.delete(evt.rawId);
      }
      return allEvents.length;
    }

    return { store, getByAccount, deleteByAccount };
  })();

  // ════════════════════════════════════════════════════════════════════
  // STAGE 2 — SOURCE-SPECIFIC PARSING
  // Dispatch to the correct parser based on source type.
  // Output contract: every parser returns NormalizedEvent[].
  // No parser may return raw API objects or CSV row objects.
  // ════════════════════════════════════════════════════════════════════
  const SourceParser = (() => {

    // Parser registry — maps source type → parsing function
    // Parsers come from TaxEngine (already implemented for all sources).
    // This registry acts as the dispatch layer to enforce the contract.
    const _parsers = {};

    function register(sourceType, parserFn) {
      _parsers[sourceType] = parserFn;
    }

    // Parse raw CSV/API data from a source into NormalizedEvent[].
    // Parsers are expected to call TaxModels.createNormalizedEvent() for each row.
    function parse(source, accountId, rawData) {
      const parser = _parsers[source];
      if (!parser) {
        console.warn(`[Pipeline Stage 2] No parser registered for source "${source}"`);
        return [];
      }
      let events;
      try {
        events = parser(rawData, accountId);
      } catch (err) {
        console.error(`[Pipeline Stage 2] Parser error for "${source}":`, err);
        return [];
      }
      if (!Array.isArray(events)) {
        console.warn(`[Pipeline Stage 2] Parser for "${source}" returned non-array`);
        return [];
      }
      // Validate each event has required fields
      const valid = [];
      let invalidCount = 0;
      for (const evt of events) {
        const { errors } = TaxModels.validateNormalizedEvent(evt);
        if (errors.length > 0) {
          console.warn(`[Pipeline Stage 2] Invalid event from "${source}":`, errors, evt);
          invalidCount++;
        } else {
          valid.push(evt);
        }
      }
      if (invalidCount > 0) {
        console.warn(`[Pipeline Stage 2] ${invalidCount} invalid events dropped from "${source}"`);
      }
      return valid;
    }

    // Get all registered source types
    function getRegistered() { return Object.keys(_parsers); }

    return { register, parse, getRegistered };
  })();

  // ════════════════════════════════════════════════════════════════════
  // STAGE 3 — PRE-FILTERING
  // The most critical stage for preventing tax errors.
  // Remove all events that should NEVER reach tax calculations.
  //
  // Rule hierarchy (applied in this order):
  //   1. Failed/reverted on-chain transactions
  //   2. Cancelled exchange orders
  //   3. EVM approval transactions (no asset movement)
  //   4. Solana token account creation (0-value initialisation)
  //   5. Zero-value events (0 amount on all legs)
  //   6. Exact duplicate events (same txHash + source already present)
  //   7. Non-financial program instructions
  //   8. Internal fee-only rows (exchange rebates, referral credits)
  //   9. Dust below reporting threshold
  //
  // Filtered events are NOT discarded — they stay in the audit log with
  // filterReason set so the tax calculation can explain "why" a visible
  // blockchain event isn't in the K4.
  // ════════════════════════════════════════════════════════════════════
  const PreFilter = (() => {

    // Minimum dust threshold — amounts below this in major coins are
    // considered economically insignificant.  Keeps review queue clean.
    const DUST_THRESHOLDS = {
      SOL:   0.000001,
      ETH:   0.0000001,
      BTC:   0.00000001,
      BNB:   0.000001,
      AVAX:  0.000001,
      MATIC: 0.001,
      USDC:  0.001,
      USDT:  0.001,
    };

    // Known non-economic Solana programs (no value transfer)
    const NON_ECONOMIC_SOLANA_PROGRAMS = new Set([
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',  // Token Program (account ops)
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv8',  // Associated Token Account Program
      'So11111111111111111111111111111111111111112',     // Wrapped SOL
      'ComputeBudget111111111111111111111111111111',     // Compute Budget
      '11111111111111111111111111111111',                // System Program
    ]);

    // Patterns in transaction notes/descriptions that indicate fee-only rows
    const FEE_ROW_PATTERNS = [
      /^fee\s+rebate/i,
      /^referral\s+(bonus|credit|reward)/i,
      /^commission\s+rebate/i,
      /^cashback/i,
      /^reward\s+(credit|payout)/i,
    ];

    // Failed status strings from various sources
    const FAILED_STATUS_PATTERNS = [
      /^fail/i, /^error/i, /^revert/i, /^abort/i,
      /^cancel/i, /^reject/i, /^declined/i, /^expired/i,
    ];

    function isFailedStatus(status, rawStatus) {
      const s = (status || rawStatus || '').toLowerCase();
      return s === TaxModels.EVENT_STATUS.FAILED
          || s === TaxModels.EVENT_STATUS.CANCELLED
          || FAILED_STATUS_PATTERNS.some(p => p.test(s));
    }

    function isApprovalTx(evt) {
      // EVM approval: category already set by normalizer, or rawType contains 'approv'
      const cat  = (evt.category || '').toLowerCase();
      const raw  = (evt.rawType   || '').toLowerCase();
      const note = (evt.notes || evt.description || '').toLowerCase();
      return cat === 'approval' || raw.includes('approv') || note.includes('approve(') || note.includes('approval tx');
    }

    function isAccountCreation(evt) {
      // Solana token account creation: received 0 tokens, fee > 0, no other value
      if (!evt.source || !evt.source.includes('solana')) return false;
      const cat = (evt.category || '').toLowerCase();
      if (cat === 'account_creation') return true;
      // Heuristic: zero received, near-zero sent, non-trivial fee → just account init
      const hasValue = evt.receivedAmount > 0.0001 || evt.sentAmount > 0.0001;
      const hasFee   = evt.feeAmount > 0 || evt.feeSEK > 0;
      const rawNote  = (evt.notes || '').toLowerCase();
      if (!hasValue && hasFee && (rawNote.includes('create account') || rawNote.includes('init account'))) return true;
      return false;
    }

    function isZeroValue(evt) {
      const totalValue = evt.sentAmount + evt.receivedAmount + evt.feeAmount + Math.abs(evt.feeSEK);
      return totalValue < 1e-12;
    }

    function isNonEconomicInstruction(evt) {
      // Solana non-economic programs (compute budget, etc.)
      if (evt.programId && NON_ECONOMIC_SOLANA_PROGRAMS.has(evt.programId)) {
        // Unless it moved value
        return evt.sentAmount === 0 && evt.receivedAmount === 0;
      }
      // EVM contract interactions with no value transfer (e.g. setApprovalForAll)
      const raw = (evt.rawType || '').toLowerCase();
      if (raw === 'contract_interaction' || raw === 'contract interaction') {
        return evt.sentAmount === 0 && evt.receivedAmount === 0;
      }
      return false;
    }

    function isFeeOnlyRow(evt) {
      const note = (evt.notes || evt.description || '').toLowerCase();
      return FEE_ROW_PATTERNS.some(p => p.test(note));
    }

    function isDust(evt) {
      // Only flag as dust for known major coins below their threshold.
      // Unknown tokens are handled by spam detection (Stage 5).
      const sym = (evt.sentAsset || evt.receivedAsset || evt.assetSymbol || '').toUpperCase();
      const threshold = DUST_THRESHOLDS[sym];
      if (!threshold) return false;
      const amt = evt.sentAmount || evt.receivedAmount || 0;
      return amt > 0 && amt < threshold;
    }

    // Build a set of existing event keys to detect duplicates.
    // Key = txHash|source|sentAsset|receivedAsset (enough to catch re-imports)
    function buildDuplicateKey(evt) {
      const hash  = (evt.txHash  || '').toLowerCase();
      const src   = (evt.source  || '').toLowerCase();
      const sent  = (evt.sentAsset     || '').toUpperCase();
      const rcvd  = (evt.receivedAsset || '').toUpperCase();
      return `${hash}|${src}|${sent}|${rcvd}`;
    }

    // Main pre-filter entry point.
    // Takes events[], returns { passed: [], filtered: [] }
    // 'filtered' entries = { event, reason } for audit trail.
    function run(events, existingEvents = []) {
      const passed   = [];
      const filtered = [];
      const seen     = new Set();

      // Build duplicate key set from already-stored events
      for (const ex of existingEvents) {
        seen.add(buildDuplicateKey(ex));
      }

      for (const evt of events) {
        let reason = null;

        // Rule 1: Failed / reverted on-chain
        if (isFailedStatus(evt.status, evt.rawStatus)) {
          reason = TaxModels.FILTER_REASON.FAILED_TX;
        }
        // Rule 2: EVM approval
        else if (isApprovalTx(evt)) {
          reason = TaxModels.FILTER_REASON.APPROVAL_TX;
        }
        // Rule 3: Solana account creation
        else if (isAccountCreation(evt)) {
          reason = TaxModels.FILTER_REASON.ACCOUNT_CREATION;
        }
        // Rule 4: Zero-value event
        else if (isZeroValue(evt)) {
          reason = TaxModels.FILTER_REASON.ZERO_VALUE;
        }
        // Rule 5: Non-economic instruction
        else if (isNonEconomicInstruction(evt)) {
          reason = TaxModels.FILTER_REASON.NON_ECONOMIC_INSTR;
        }
        // Rule 6: Duplicate import
        else {
          const key = buildDuplicateKey(evt);
          if (evt.txHash && !evt.txHash.startsWith('manual_') && seen.has(key)) {
            reason = TaxModels.FILTER_REASON.EXACT_DUPLICATE;
          } else {
            seen.add(key);
          }
        }
        // Rule 7: Fee-only rows (exchange rebates, referral credits)
        if (!reason && isFeeOnlyRow(evt)) {
          reason = TaxModels.FILTER_REASON.INTERNAL_FEE_ONLY;
        }
        // Rule 8: Dust amounts in known major coins
        if (!reason && isDust(evt)) {
          reason = TaxModels.FILTER_REASON.DUST_AMOUNT;
        }

        if (reason) {
          filtered.push({ event: { ...evt, filtered: true, filterReason: reason }, reason });
        } else {
          passed.push({ ...evt, filtered: false });
        }
      }

      return { passed, filtered };
    }

    // Diagnostic summary for the pipeline logger
    function summarize(result) {
      const byReason = {};
      for (const { reason } of result.filtered) {
        byReason[reason] = (byReason[reason] || 0) + 1;
      }
      return {
        passed:   result.passed.length,
        filtered: result.filtered.length,
        byReason,
      };
    }

    return { run, summarize, buildDuplicateKey };
  })();

  // ════════════════════════════════════════════════════════════════════
  // PIPELINE LOGGER
  // Tracks input/output counts and filter reasons at each stage.
  // Used for debugging and the pipeline progress bar.
  // ════════════════════════════════════════════════════════════════════
  const PipelineLogger = (() => {
    const _log = [];
    let _runId = null;

    function start(label) {
      _runId = label || `run_${Date.now()}`;
      _log.length = 0;
      console.group(`[TaxPipeline] ${_runId}`);
    }

    function logStage(stageId, stageName, inputCount, outputCount, filteredCount = 0, meta = {}) {
      const entry = { stageId, stageName, inputCount, outputCount, filteredCount, meta, ts: Date.now() };
      _log.push(entry);
      const delta = outputCount - inputCount;
      const sign  = delta >= 0 ? '+' : '';
      console.log(
        `  Stage ${stageId.toString().padStart(2)} — ${stageName.padEnd(22)} `
        + `in=${inputCount.toString().padStart(5)}  out=${outputCount.toString().padStart(5)}`
        + `  filtered=${filteredCount.toString().padStart(4)}  (${sign}${delta})`
      );
      if (Object.keys(meta).length > 0) console.log('              meta:', meta);
    }

    function end(summary = {}) {
      console.log('[TaxPipeline] Done:', summary);
      console.groupEnd();
    }

    function getLog() { return [..._log]; }

    return { start, logStage, end, getLog };
  })();

  // ════════════════════════════════════════════════════════════════════
  // ADAPTER — bridges existing TaxEngine functions to the new pipeline
  //
  // Stages 4–12 are already implemented in TaxEngine.  Rather than
  // rewriting them, we call the existing functions while enforcing the
  // stage contract (correct order, logged counts, no cross-stage leakage).
  //
  // As the engine is refactored further, these adapters can be replaced
  // with dedicated implementations that operate on NormalizedEvent directly.
  // ════════════════════════════════════════════════════════════════════
  const EngineAdapter = (() => {

    // Helper: ensure TaxEngine is available
    function _eng() {
      if (typeof TaxEngine === 'undefined') throw new Error('[TaxPipeline] TaxEngine not loaded');
      return TaxEngine;
    }

    // Stage 4: Resolve token metadata
    async function resolveAssets(events, onProgress) {
      return _eng().resolveAllTokenMetadata(events, onProgress);
    }

    // Stage 5: Spam / dust detection
    function detectSpam(events) {
      return _eng().detectSpamTokens(events);
    }

    // Stage 6: Transaction reconstruction
    // (swap reconstruction, on-chain event decoding, merge split rows)
    function reconstructTransactions(events) {
      let result = _eng().decodeOnChainEvents(events);
      // Merge stale Solana split-rows (legacy import format)
      const solanaResult = _eng().reprocessSolanaSwaps(result);
      if (solanaResult.merged > 0) {
        const toDeleteSet = new Set(solanaResult.toDelete);
        result = result.filter(t => !toDeleteSet.has(t.id));
        for (const newTx of solanaResult.toAdd) {
          if (!result.find(t => t.txHash === newTx.txHash && t.category === 'trade')) {
            result.push(newTx);
          }
        }
        console.log(`[Pipeline Stage 6] Merged ${solanaResult.merged} Solana split-swap pairs`);
      }
      return result;
    }

    // Stage 7: Transfer matching
    function matchTransfers(events) {
      return _eng().matchTransfers(events);
    }

    // Stage 8: SEK price assignment
    async function assignPrices(events, onProgress) {
      return _eng().fetchAllSEKPrices(events, onProgress);
    }

    // Stage 9: Inventory / cost basis (not a transformer — builds holdings map)
    function buildInventory(events, year) {
      return _eng().computeTaxYear(year, events);
    }

    // Stage 10: Review issue generation
    function generateReviewIssues(events, taxResult) {
      return _eng().getReviewIssues(events, taxResult);
    }

    // Stage 11: Tax event generation (extract disposals+income from inventory result)
    // Returns { disposals, income } — the canonical TaxEvent arrays
    function generateTaxEvents(inventoryResult) {
      // TaxEngine.computeTaxYear already produces disposals + income.
      // Here we convert them to TaxEvent model objects for type safety.
      const { disposals = [], income = [] } = inventoryResult;
      const taxEvents = [
        ...disposals.map(d => TaxModels.createTaxEvent({
          id:             d.id,
          sourceEventId:  d.id,
          date:           d.date,
          year:           inventoryResult.year,
          eventType:      'disposal',
          assetSymbol:    d.assetSymbol,
          assetName:      d.assetName,
          amountDisposed: d.amountSold,
          proceedsSEK:    d.proceedsSEK,
          costBasisSEK:   d.costBasisSEK,
          feeSEK:         d.feeSEK,
          gainLossSEK:    d.gainLossSEK,
          avgCostAtSale:  d.avgCostAtSale,
          unknownAcquisition: d.unknownAcquisition,
          proceedsSource: d.proceedsSource,
          isTrade:        d.isTrade,
          isFee:          d.isFee,
          confidence:     d.unknownAcquisition ? 'unknown'
                        : d.proceedsSource === 'swap_at_cost' ? 'estimated'
                        : 'exact',
          needsReview:    d.needsReview || d.unknownAcquisition,
        })),
        ...income.map(inc => TaxModels.createTaxEvent({
          id:             inc.id,
          sourceEventId:  inc.id,
          date:           inc.date,
          year:           inventoryResult.year,
          eventType:      'income',
          assetSymbol:    inc.assetSymbol,
          amountDisposed: inc.amount,
          proceedsSEK:    inc.valueSEK,
          costBasisSEK:   inc.valueSEK,  // income = cost basis at FMV
          gainLossSEK:    0,
        })),
      ];
      return taxEvents;
    }

    // Stage 12: Swedish K4 report generation
    function generateReport(inventoryResult, userInfo) {
      return _eng().generateK4Report(inventoryResult, userInfo);
    }

    // Expose computeReportHealth for UI health banner
    function computeReportHealth(taxResult) {
      return _eng().computeReportHealth(taxResult);
    }

    return {
      resolveAssets, detectSpam, reconstructTransactions, matchTransfers,
      assignPrices, buildInventory, generateReviewIssues, generateTaxEvents,
      generateReport, computeReportHealth,
    };
  })();

  // ════════════════════════════════════════════════════════════════════
  // PIPELINE ORCHESTRATOR
  // Runs all 12 stages in order.  Each stage receives the output of the
  // previous stage — no skipping, no cross-stage shortcuts.
  //
  // The orchestrator also:
  //   • Emits events (compatible with TaxEngine.Events) for progress bar
  //   • Logs stage diagnostics via PipelineLogger
  //   • Saves filtered events to a separate audit store
  //   • Validates the NormalizedEvent contract between stages
  // ════════════════════════════════════════════════════════════════════
  const Orchestrator = (() => {

    let _running = false;

    async function run(opts = {}) {
      if (_running) {
        console.warn('[TaxPipeline] Pipeline already running — ignoring concurrent call');
        return null;
      }
      _running = true;

      const {
        onProgress,   // (step, pct, msg) => void
        onStageLog,   // ({ stageId, inputCount, outputCount }) => void — optional
        taxYear,      // Number — target tax year for Stage 9–12
        forceRerun,   // Boolean — skip cached stages
      } = opts;

      const emit = (step, pct, msg) => {
        if (onProgress) onProgress({ step, pct, msg });
        // Also fire TaxEngine Events if available
        if (typeof TaxEngine !== 'undefined') {
          TaxEngine.Events.emit('pipeline:step', { step, pct, msg });
        }
      };

      const logStage = (id, name, inC, outC, filtC = 0, meta = {}) => {
        PipelineLogger.logStage(id, name, inC, outC, filtC, meta);
        if (onStageLog) onStageLog({ stageId: id, stageName: name, inputCount: inC, outputCount: outC, filteredCount: filtC, meta });
      };

      PipelineLogger.start(`pipeline_${Date.now()}`);

      // ── Audit accumulator for filtered events ──
      const allFiltered = [];

      try {
        // ── Stage 1: We don't re-import here — raw data was already stored
        // at import time (importSolanaWallet, importEthWallet, CSV parsers).
        // The orchestrator starts from Stage 2 output = already-stored transactions.
        emit('decode', 5, 'Ładowanie transakcji…');
        let txns = (typeof TaxEngine !== 'undefined') ? TaxEngine.getTransactions() : [];
        const stageOneCount = txns.length;
        logStage(1, 'import', 0, stageOneCount, 0, { note: 'Using stored transactions' });

        // ── Stage 2: Parsing already happened at import time (parsers are called
        // by importSolanaWallet / importEthWallet / CSV upload handlers).
        // All stored txns are already in NormalizedEvent format.
        logStage(2, 'parse', stageOneCount, stageOneCount, 0);

        // ── Stage 3: Pre-filter ────────────────────────────────────────
        emit('decode', 12, 'Pre-filtrering…');
        const existingTxns = txns; // treat in-memory as "already seen"
        const { passed: passedFilter, filtered } = PreFilter.run(txns, []);

        allFiltered.push(...filtered);
        const filterSummary = PreFilter.summarize({ passed: passedFilter, filtered });
        logStage(3, 'prefilter', txns.length, passedFilter.length, filtered.length, filterSummary.byReason);

        txns = passedFilter;

        // Save filtered events back to a readable audit key in localStorage
        try {
          const auditKey = 'pipeline_filtered_audit_' + (taxYear || 'all');
          localStorage.setItem(auditKey, JSON.stringify(
            filtered.map(f => ({ id: f.event.id, reason: f.reason, txHash: f.event.txHash, date: f.event.date, source: f.event.source, asset: f.event.assetSymbol, amount: f.event.amount }))
          ));
        } catch (_) { /* quota — non-fatal */ }

        // ── Stage 4: Token and asset resolution ───────────────────────
        emit('tokens', 18, 'Löser token-metadata…');
        txns = await EngineAdapter.resolveAssets(txns, (p) => emit('tokens', 18, p.msg));
        logStage(4, 'resolve', passedFilter.length, txns.length, 0);

        // ── Stage 5: Spam and dust detection ──────────────────────────
        emit('spam', 25, 'Identifierar spam-tokens…');
        const beforeSpam = txns.length;
        txns = EngineAdapter.detectSpam(txns);
        // Spam detector marks events (category=SPAM) rather than removing them;
        // count events that became SPAM for the log.
        const spamCount = txns.filter(t => t.category === 'spam').length;
        logStage(5, 'spam', beforeSpam, txns.length, spamCount, { spamFlagged: spamCount });

        // ── Stage 6: Transaction reconstruction ───────────────────────
        emit('classify', 33, 'Rekonstruerar transaktioner…');
        const beforeRecon = txns.length;
        txns = EngineAdapter.reconstructTransactions(txns);

        // Classify ALL events now that reconstruction is complete.
        // autoClassifyAll sets the canonical category on each event.
        if (typeof TaxEngine !== 'undefined') {
          txns = TaxEngine.autoClassifyAll(txns);
        }
        logStage(6, 'reconstruct', beforeRecon, txns.length, 0,
          { deltaRows: txns.length - beforeRecon });

        // ── Stage 7: Transfer matching ─────────────────────────────────
        emit('transfer', 44, 'Matchar interna överföringar…');
        const beforeMatch = txns.length;
        txns = EngineAdapter.matchTransfers(txns);
        const internalCount = txns.filter(t => t.isInternalTransfer).length;
        logStage(7, 'match', beforeMatch, txns.length, 0, { internalTransfers: internalCount });

        // ── Stage 8: SEK pricing ───────────────────────────────────────
        emit('price', 52, 'Hämtar historiska SEK-priser…');
        const beforePrice = txns.length;
        txns = await EngineAdapter.assignPrices(txns, (p) => {
          emit('price', 52 + Math.round(p.pct * 0.2), p.msg);
        });
        const pricedCount  = txns.filter(t => t.priceSEKPerUnit > 0 || t.costBasisSEK > 0).length;
        const missingPrice = txns.filter(t => t.needsReview && t.reviewReason === 'missing_sek_price').length;
        logStage(8, 'price', beforePrice, txns.length, 0, { priced: pricedCount, missingPrice });

        // ── Stage 8b: Negative balance detection ──────────────────────
        // (sub-step of Stage 8 / inventory — runs before saving)
        if (typeof TaxEngine !== 'undefined') {
          txns = TaxEngine.detectNegativeBalances(txns);
        }

        // ── Save enriched NormalizedEvents to persistent store ─────────
        emit('save', 80, 'Sparar…');
        if (typeof TaxEngine !== 'undefined') {
          TaxEngine.saveTransactions(txns);
        }

        // ── Stage 9: Inventory and cost basis ─────────────────────────
        emit('tax', 88, 'Beräknar Genomsnittsmetoden…');
        const year = taxYear || ((typeof TaxEngine !== 'undefined')
          ? TaxEngine.getSettings().taxYear
          : new Date().getFullYear() - 1);
        const inventoryResult = EngineAdapter.buildInventory(txns, year);
        logStage(9, 'inventory', txns.length, txns.length, 0, {
          disposals: inventoryResult.disposals.length,
          income:    inventoryResult.income.length,
        });

        // ── Stage 10: Review issue generation ─────────────────────────
        const reviewIssues = EngineAdapter.generateReviewIssues(txns, inventoryResult);
        const blockers = reviewIssues.filter(i => i.isK4Blocker).length;
        logStage(10, 'review', txns.length, txns.length, 0, {
          issues:   reviewIssues.length,
          blockers,
        });

        // ── Stage 11: Tax event generation ────────────────────────────
        const taxEvents = EngineAdapter.generateTaxEvents(inventoryResult);
        logStage(11, 'taxevents', inventoryResult.disposals.length + inventoryResult.income.length,
          taxEvents.length, 0);

        // ── Stage 12: Swedish K4 report ────────────────────────────────
        const settings = (typeof TaxEngine !== 'undefined') ? TaxEngine.getSettings() : {};
        const userInfo = { name: settings.userName, personnummer: settings.personnummer };
        const k4Report = EngineAdapter.generateReport(inventoryResult, userInfo);
        const health   = EngineAdapter.computeReportHealth(inventoryResult);
        logStage(12, 'report', taxEvents.length, k4Report.k4Rows.length, 0, { status: health.status });

        // ── Done ─────────────────────────────────────────────────────
        const summary = {
          totalTxns:    txns.length,
          filtered:     allFiltered.length,
          reviewIssues: reviewIssues.length,
          taxEvents:    taxEvents.length,
          k4Rows:       k4Report.k4Rows.length,
          health:       health.status,
        };
        PipelineLogger.end(summary);
        emit('done', 100, `Klar — ${txns.length.toLocaleString()} transaktioner, ${reviewIssues.length} granskningspunkter`);

        // Fire TaxEngine compatible done event
        if (typeof TaxEngine !== 'undefined') {
          TaxEngine.Events.emit('pipeline:done', {
            totalTxns:    txns.length,
            reviewIssues: reviewIssues.length,
            duplicates:   txns.filter(t => t.isDuplicate).length,
            taxResult:    inventoryResult,
          });
        }

        return {
          txns,
          allFiltered,
          inventoryResult,
          taxEvents,
          reviewIssues,
          k4Report,
          health,
          stageLog: PipelineLogger.getLog(),
        };

      } catch (err) {
        console.error('[TaxPipeline] Pipeline error:', err);
        PipelineLogger.end({ error: err.message });
        if (typeof TaxEngine !== 'undefined') {
          TaxEngine.Events.emit('pipeline:error', { message: err.message });
        }
        throw err;
      } finally {
        _running = false;
      }
    }

    function isRunning() { return _running; }

    return { run, isRunning };
  })();

  // ════════════════════════════════════════════════════════════════════
  // SOURCE PARSER REGISTRATION
  // Wire up TaxEngine parsers to the Stage 2 SourceParser registry.
  // Called once after both TaxEngine and TaxPipeline are loaded.
  // ════════════════════════════════════════════════════════════════════
  function registerAllParsers() {
    if (typeof TaxEngine === 'undefined') {
      console.warn('[TaxPipeline] TaxEngine not loaded — cannot register parsers');
      return;
    }
    const M = TaxModels.SOURCE_TYPES;
    // CSV parsers
    SourceParser.register(M.BINANCE,   (text, id) => TaxEngine.parseBinanceCSV(text, id));
    SourceParser.register(M.KRAKEN,    (text, id) => TaxEngine.parseKrakenCSV(text, id));
    SourceParser.register(M.BYBIT,     (text, id) => TaxEngine.parseBybitCSV(text, id));
    SourceParser.register(M.COINBASE,  (text, id) => TaxEngine.parseCoinbaseCSV(text, id));
    SourceParser.register(M.REVOLUT,   (text, id) => TaxEngine.parseRevolutCSV(text, id));
    SourceParser.register(M.MEXC,      (text, id) => TaxEngine.parseMEXCCSV(text, id));
    SourceParser.register(M.SOLSCAN,   (text, id) => TaxEngine.parseSolscanCSV(text, id));
    SourceParser.register(M.GENERIC,   (text, id) => TaxEngine.parseGenericCSV(text, id));
    console.log('[TaxPipeline] Parsers registered:', SourceParser.getRegistered().length);
  }

  // ════════════════════════════════════════════════════════════════════
  // PIPELINE DIAGNOSTICS API
  // Exposed so the Review page and Admin page can inspect pipeline health.
  // ════════════════════════════════════════════════════════════════════
  function getFilteredAudit(taxYear) {
    try {
      const key  = 'pipeline_filtered_audit_' + (taxYear || 'all');
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : [];
    } catch (_) { return []; }
  }

  // Get a summary of what Stage 3 filtered from the last run
  function getPreFilterSummary(taxYear) {
    const filtered = getFilteredAudit(taxYear);
    const byReason = {};
    for (const f of filtered) {
      byReason[f.reason] = (byReason[f.reason] || 0) + 1;
    }
    return { total: filtered.length, byReason };
  }

  // ── Public API ──────────────────────────────────────────────────────
  return {
    // Models (convenience re-export)
    STAGES:    TaxModels.PIPELINE_STAGES,
    SOURCES:   TaxModels.SOURCE_TYPES,
    FILTERS:   TaxModels.FILTER_REASON,

    // Stage modules (exposed for testing / incremental refactoring)
    RawDataStore,
    SourceParser,
    PreFilter,
    EngineAdapter,
    PipelineLogger,

    // Orchestrator
    run:       Orchestrator.run.bind(Orchestrator),
    isRunning: Orchestrator.isRunning.bind(Orchestrator),

    // Parser wiring
    registerAllParsers,

    // Diagnostics
    getFilteredAudit,
    getPreFilterSummary,
  };
})();
