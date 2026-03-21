/* ============================================================
   T-CMD — AI Fallback Client Module  v1
   Thin wrapper around the Supabase Edge Function `ai-fallback`.
   The OpenAI key NEVER touches this file — it's held server-side.
   ============================================================ */

const AIFallback = (() => {

  // ── Endpoint ─────────────────────────────────────────────
  function _cfg() {
    // TCMD_CONFIG is a const (not on window) — access directly
    return (typeof TCMD_CONFIG !== 'undefined') ? TCMD_CONFIG : null;
  }

  function _fnUrl() {
    const base = _cfg()?.SUPABASE_URL;
    if (!base) return null;
    return `${base}/functions/v1/ai-fallback`;
  }

  function isConfigured() {
    const cfg = _cfg();
    return !!_fnUrl() && !!(cfg?.SUPABASE_ANON_KEY);
  }

  // ── Core fetch helper ────────────────────────────────────
  async function _call(action, payload = {}) {
    const url = _fnUrl();
    if (!url) throw new Error('AI Fallback: SUPABASE_URL not configured');

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': _cfg()?.SUPABASE_ANON_KEY || '',
      },
      body: JSON.stringify({ action, ...payload }),
    });

    const text = await res.text();
    if (!res.ok) {
      let msg;
      try {
        const j = JSON.parse(text);
        msg = j.error || j.message || text;
      } catch {
        msg = text;
      }
      throw new Error(`AI Fallback [${action}]: ${msg}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`AI Fallback [${action}]: invalid JSON response`);
    }
  }

  // ── testKey ──────────────────────────────────────────────
  // Calls the Edge Function with action='test'; the function pings
  // OpenAI and returns { ok, model, latency_ms } or { ok: false, error }.
  // The OpenAI key is never sent to the browser.
  async function testKey() {
    return _call('test');
  }

  // ── preview ──────────────────────────────────────────────
  // Returns a cost/count estimate without calling OpenAI.
  // issues[] — array of review-issue objects from TaxEngine
  // Returns { jobs: [{ job_type, count, estimated_cost_usd }], total_rows, total_cost_usd }
  async function preview(issues) {
    if (!Array.isArray(issues) || !issues.length) {
      return { jobs: [], total_rows: 0, total_cost_usd: 0 };
    }
    const rows = _issueRows(issues);
    return _call('preview', { rows });
  }

  // ── run ──────────────────────────────────────────────────
  // Submits ≤5 rows (safety cap enforced server-side too) and
  // calls OpenAI synchronously. Returns array of job records.
  // issues[]  — review-issue objects
  // jobType   — 'unknown_token_classifier' | 'missing_price_explainer'
  //             | 'suggested_price_assistant'
  // onProgress(pct, msg) — optional progress callback
  async function run(issues, jobType, onProgress) {
    if (!Array.isArray(issues) || !issues.length) return [];
    const rows = _issueRows(issues, jobType).slice(0, 5); // hard cap 5
    if (!rows.length) return [];

    if (onProgress) onProgress(0, `Submitting ${rows.length} row${rows.length !== 1 ? 's' : ''} to AI…`);
    const result = await _call('run', { rows, job_type: jobType });
    if (onProgress) onProgress(100, 'AI processing complete');
    return result.jobs || [];
  }

  // ── getJob ───────────────────────────────────────────────
  // Polls a single job by ID. Returns { job, results, attempts }.
  async function getJob(jobId) {
    if (!jobId) throw new Error('AI Fallback getJob: jobId required');
    return _call('get_job', { job_id: jobId });
  }

  // ── apply ────────────────────────────────────────────────
  // Marks a result as applied and returns a client_patch object
  // that TaxUI can use to update state.
  // Returns { applied: true, client_patch: { row_id, action, ... } }
  async function apply(jobId, resultId) {
    if (!jobId || !resultId) throw new Error('AI Fallback apply: jobId + resultId required');
    return _call('apply', { job_id: jobId, result_id: resultId });
  }

  // ── pollUntilComplete ────────────────────────────────────
  // Convenience: poll getJob every intervalMs until status is
  // 'completed' or 'failed', or maxAttempts is reached.
  // Returns the final job record.
  async function pollUntilComplete(jobId, { intervalMs = 3000, maxAttempts = 20, onPoll } = {}) {
    for (let i = 0; i < maxAttempts; i++) {
      const data = await getJob(jobId);
      const status = data?.job?.status;
      if (onPoll) onPoll(data);
      if (status === 'completed' || status === 'failed') return data;
      await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new Error(`AI Fallback: job ${jobId} timed out after ${maxAttempts} polls`);
  }

  // ── Internal: map review issues to Edge Function row format ──
  function _issueRows(issues, filterJobType) {
    const rows = [];
    for (const issue of issues) {
      if (!issue) continue;
      const txn = issue.txn || issue;

      // Determine which job type this issue maps to
      let jobType = null;
      if (
        issue.reason === 'unknown_asset' &&
        (txn.tokenClass?.type === 'unknown_real' || !txn.tokenClass)
      ) {
        jobType = 'unknown_token_classifier';
      } else if (issue.reason === 'missing_sek_price' && issue.priceBlockDebug) {
        jobType = 'missing_price_explainer';
      } else if (issue.reason === 'missing_sek_price' && !issue.priceBlockDebug) {
        jobType = 'suggested_price_assistant';
      }

      if (!jobType) continue;
      if (filterJobType && jobType !== filterJobType) continue;

      rows.push({
        job_type:       jobType,
        row_id:         txn.id || issue.id,
        tx_hash:        txn.txHash || txn.hash,
        chain:          txn.chain || 'solana',
        token_symbol:   txn.assetSymbol || txn.symbol,
        mint_address:   txn.mintAddress || txn.mint,
        timestamp:      txn.date || txn.timestamp,
        // Context for AI prompts
        input_payload: {
          txn_type:            txn.type,
          amount:              txn.amount,
          amount_usd_estimate: txn.amountUSD,
          coin_gecko_id:       txn.coinGeckoId,
          token_name:          txn.assetName || txn.tokenName,
          platform:            txn.platform || txn.chain || 'solana',
          review_reason:       issue.reason,
          resolution_candidate: txn.resolutionCandidateType,
          price_block_debug:   issue.priceBlockDebug || null,
          swap_context: txn.swapContext ? {
            from_symbol: txn.swapContext.fromSymbol,
            to_symbol:   txn.swapContext.toSymbol,
            from_amount: txn.swapContext.fromAmount,
            to_amount:   txn.swapContext.toAmount,
          } : null,
        },
      });
    }
    return rows;
  }

  // ── Public API ───────────────────────────────────────────
  return {
    isConfigured,
    testKey,
    preview,
    run,
    getJob,
    apply,
    pollUntilComplete,
  };

})();
