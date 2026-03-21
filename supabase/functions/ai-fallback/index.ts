/**
 * T-CMD — AI Fallback Edge Function
 * Supabase Deno Edge Function. Runs server-side; the OpenAI key is never
 * exposed to the browser. Reads the key from api_keys table via service role.
 *
 * Actions:
 *   test       — ping OpenAI, verify key is working
 *   preview    — count eligible rows by job_type + cost estimate (no LLM call)
 *   run        — create jobs + call OpenAI for ≤5 rows synchronously
 *   get_job    — return job status + result payload
 *   apply      — mark result applied; return field patch for client
 *
 * Deployment:
 *   supabase login
 *   supabase link --project-ref YOUR_PROJECT_REF
 *   supabase functions deploy ai-fallback
 *
 * Environment (auto-injected by Supabase Edge runtime):
 *   SUPABASE_URL                — your project URL
 *   SUPABASE_SERVICE_ROLE_KEY   — service role key (bypasses RLS)
 */

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ---------------------------------------------------------------------------
// CORS headers — allow the hosted app origin
// ---------------------------------------------------------------------------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function err(message: string, status = 500) {
  return json({ error: message }, status);
}

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------
const PROMPTS = {
  unknown_token_classifier: `
You are a blockchain tax compliance assistant specializing in Solana token classification.

Given a Solana token, classify it into exactly one of these categories:
  spam              — zero-value airdrop, contract address token, obvious scam
  swap_intermediate — used as an intermediate hop in a DEX route (not a held asset)
  real_token        — a genuine token with trading history and economic value
  likely_airdrop    — received for free, no purchase, possibly has value
  low_value         — real token but estimated value < 50 SEK
  unknown_real      — cannot classify with confidence

Rules:
- If the mint address ends in "pump" (pump.fun minted): likely spam or meme coin
- If economic_context.tag is "swap-leg" with has_route_context: true → swap_intermediate
- If economic_context.has_swap_context and no other holdings → swap_intermediate
- Prefer on-chain explorer evidence over assumptions
- Use web search to check if the mint address appears on Solscan, DexScreener, or CoinGecko
- If evidence is weak, set confidence: "low" and recommended_action: "ask_user"
- NEVER invent classifications — lower confidence is always better than a wrong guess

Output ONLY valid JSON matching this exact schema. No prose, no markdown, no explanations outside the JSON:
{
  "resolved": true,
  "job_type": "unknown_token_classifier",
  "token_classification": "spam|swap_intermediate|real_token|likely_airdrop|low_value|unknown_real",
  "confidence": "high|medium|low",
  "recommended_action": "hide|collapse|ignore|suggest_airdrop|ask_user",
  "evidence": [
    { "kind": "explorer_context|market_context|metadata_context", "note": "string" }
  ],
  "warnings": ["string"]
}
`.trim(),

  missing_price_explainer: `
You are a blockchain tax compliance assistant. Given a failed price lookup for a swap transaction,
identify the root cause of the pricing failure.

Classify the root_cause as exactly one of:
  reconstruction_failure   — tx reconstruction missed the swap legs
  persistence_failure      — tx-implied value was computed but not stored
  trust_gate_rejection     — reconstruction confidence was "low", blocking the price
  market_lookup_failure    — external market API (CoinGecko/CryptoCompare) had no data
  insufficient_context     — not enough transaction context to derive a price

Rules:
- If known_failures includes "no_tx_implied_value_persisted" AND has_route_context is true
  → likely persistence_failure or trust_gate_rejection
- If reconstruction.has_tx_context is false but has_route_context is true
  → likely reconstruction_failure
- If both assets in the swap have known prices elsewhere, check if a cross-rate can be derived
- Prefer recommending route_back_to_tx_implied when route context exists and is sufficient
- Use web search only to verify if the token had a market price on that date
- Output ONLY valid JSON. No prose.

{
  "resolved": true,
  "job_type": "missing_price_explainer",
  "root_cause": "reconstruction_failure|persistence_failure|trust_gate_rejection|market_lookup_failure|insufficient_context",
  "confidence": "high|medium|low",
  "recommended_action": "route_back_to_tx_implied|route_back_to_market_api|manual_review",
  "evidence": [
    { "kind": "tx_summary|route_summary|market_context", "note": "string" }
  ],
  "warnings": ["string"]
}
`.trim(),

  suggested_price_assistant: `
You are a blockchain tax compliance assistant. Propose a historical SEK price for a token.

The USD/SEK exchange rate for the given date will be applied externally — provide the USD price only.

Rules:
- Do NOT invent prices. Only propose if you can find real market evidence.
- Use web search to find the token's price on the SPECIFIC date given (not current price)
- Prefer DEX trade records, CoinGecko historical data, or exchange order books
- If the token is a swap intermediate with a known counter-asset, derive from the swap ratio
- Multi-hop swaps: treat as one economic event — use final sent and received amounts only
- If evidence is weak or price is unavailable, set confidence: "low" and recommended_action: "manual_review"
- Only set recommended_action: "safe_commit" for high-confidence prices from exchange records
- Output ONLY valid JSON. No prose.

{
  "resolved": true,
  "job_type": "suggested_price_assistant",
  "proposed_price_usd": 0.0,
  "proposed_total_value_usd": 0.0,
  "valuation_basis": "tx_implied_route_value|explorer_summary|market_context|dex_trade_record",
  "confidence": "high|medium|low",
  "recommended_action": "suggest_price|safe_commit|manual_review",
  "evidence": [
    { "kind": "explorer_tx_summary|public_market_context|dex_ohlcv", "note": "string" }
  ],
  "warnings": ["string"]
}
`.trim(),
};

// Cost estimate per job type (gpt-4o-mini, approximate)
const COST_PER_JOB_USD: Record<string, number> = {
  unknown_token_classifier: 0.0004,
  missing_price_explainer:  0.0008,
  suggested_price_assistant: 0.0015,
};

// ---------------------------------------------------------------------------
// Supabase service-role client
// ---------------------------------------------------------------------------
function getServiceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---------------------------------------------------------------------------
// Get OpenAI key from api_keys table (service role bypasses RLS)
// ---------------------------------------------------------------------------
async function getOpenAIKey(sb: SupabaseClient): Promise<string> {
  const { data, error } = await sb
    .from('api_keys')
    .select('value')
    .eq('name', 'openai')
    .maybeSingle();
  if (error) throw new Error(`Failed to read OpenAI key: ${error.message}`);
  const key = data?.value?.trim();
  if (!key) throw new Error('OpenAI API key is not configured. Set it in Admin → API Keys.');
  return key;
}

// ---------------------------------------------------------------------------
// OpenAI Responses API call
// ---------------------------------------------------------------------------
async function callOpenAI(
  apiKey: string,
  systemPrompt: string,
  userContent: string,
  useWebSearch = true,
): Promise<{ output: string; inputTokens: number; outputTokens: number; latencyMs: number }> {
  const t0 = Date.now();

  const body: Record<string, unknown> = {
    model: 'gpt-4o-mini',
    instructions: systemPrompt,
    input: userContent,
    text: { format: { type: 'json_object' } },
  };

  if (useWebSearch) {
    body.tools = [{ type: 'web_search_preview' }];
  }

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`OpenAI API error ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();

  // Extract text output from Responses API format
  const outputText = data?.output
    ?.filter((o: Record<string, unknown>) => o.type === 'message')
    ?.flatMap((o: Record<string, unknown>) =>
      (o.content as Record<string, unknown>[])
        ?.filter((c) => c.type === 'output_text')
        ?.map((c) => c.text)
    )
    ?.join('') ?? '';

  return {
    output: outputText,
    inputTokens: data?.usage?.input_tokens ?? 0,
    outputTokens: data?.usage?.output_tokens ?? 0,
    latencyMs: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// Job processors
// ---------------------------------------------------------------------------
async function processJob(
  sb: SupabaseClient,
  job: Record<string, unknown>,
  openAIKey: string,
): Promise<void> {
  const jobId = job.id as string;
  const jobType = job.job_type as string;
  const inputPayload = job.input_payload as Record<string, unknown>;

  await sb.from('ai_fallback_jobs').update({
    status: 'running',
    started_at: new Date().toISOString(),
  }).eq('id', jobId);

  const attemptStart = Date.now();
  let tokensIn = 0, tokensOut = 0, latencyMs = 0;
  let resultPayload: Record<string, unknown> | null = null;
  let error: string | null = null;

  try {
    const systemPrompt = PROMPTS[jobType as keyof typeof PROMPTS];
    if (!systemPrompt) throw new Error(`Unknown job_type: ${jobType}`);

    const userContent = JSON.stringify(inputPayload, null, 2);
    const { output, inputTokens, outputTokens, latencyMs: lm } = await callOpenAI(
      openAIKey, systemPrompt, userContent, true
    );
    tokensIn = inputTokens;
    tokensOut = outputTokens;
    latencyMs = lm;

    try {
      resultPayload = JSON.parse(output);
    } catch {
      throw new Error(`OpenAI returned non-JSON output: ${output.slice(0, 200)}`);
    }

    // Validate minimal required fields
    if (!resultPayload || typeof resultPayload !== 'object') {
      throw new Error('OpenAI returned empty or invalid JSON');
    }
    if (!resultPayload.job_type) resultPayload.job_type = jobType;
    if (resultPayload.resolved === undefined) resultPayload.resolved = true;

    // Store result
    await sb.from('ai_fallback_results').insert({
      job_id: jobId,
      user_id: job.user_id,
      job_type: jobType,
      resolved: resultPayload.resolved ?? false,
      result_payload: resultPayload,
      confidence: resultPayload.confidence ?? 'low',
      recommended_action: resultPayload.recommended_action ?? 'manual_review',
      evidence_summary: resultPayload.evidence ?? null,
      raw_openai_response: { output, tokensIn, tokensOut },
    });

    await sb.from('ai_fallback_jobs').update({
      status: 'completed',
      completed_at: new Date().toISOString(),
    }).eq('id', jobId);

  } catch (e) {
    error = (e as Error).message;
    await sb.from('ai_fallback_jobs').update({
      status: 'failed',
      completed_at: new Date().toISOString(),
      error,
    }).eq('id', jobId);
  }

  // Record attempt
  const costUsd = (tokensIn * 0.00000015) + (tokensOut * 0.0000006); // gpt-4o-mini pricing
  await sb.from('ai_fallback_attempts').insert({
    job_id: jobId,
    attempt_number: 1,
    completed_at: new Date().toISOString(),
    status: error ? 'failed' : 'success',
    tokens_used: tokensIn + tokensOut,
    cost_usd: costUsd,
    error,
    response_time_ms: latencyMs || (Date.now() - attemptStart),
  });
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

/** Quick OpenAI key validity check — no job created */
async function handleTest(sb: SupabaseClient): Promise<Response> {
  const apiKey = await getOpenAIKey(sb);
  const t0 = Date.now();

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      instructions: 'You are a ping responder. Reply with valid json containing exactly: {"ok":true}',
      input: 'ping — respond with json',
      text: { format: { type: 'json_object' } },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    return json({ ok: false, error: `OpenAI ${res.status}: ${errText.slice(0, 120)}` });
  }

  return json({ ok: true, model: 'gpt-4o-mini', latency_ms: Date.now() - t0 });
}

/** Count eligible rows and estimate cost — no LLM call */
async function handlePreview(body: Record<string, unknown>): Promise<Response> {
  const rows = (body.rows as unknown[]) ?? [];

  const counts: Record<string, number> = {
    unknown_token_classifier: 0,
    missing_price_explainer: 0,
    suggested_price_assistant: 0,
  };

  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const reason = r.reason as string;
    const jobType = r.job_type as string | undefined;

    if (jobType && counts[jobType] !== undefined) {
      counts[jobType]++;
    } else if (reason === 'unknown_asset') {
      counts.unknown_token_classifier++;
    } else if (reason === 'missing_sek_price') {
      if (r.priceBlockDebug) {
        counts.missing_price_explainer++;
      } else {
        counts.suggested_price_assistant++;
      }
    }
  }

  const totalCost = Object.entries(counts).reduce(
    (sum, [type, count]) => sum + (COST_PER_JOB_USD[type] ?? 0) * count,
    0
  );

  return json({
    eligible_count: rows.length,
    by_job_type: counts,
    estimated_cost_usd: Number(totalCost.toFixed(4)),
    examples: (rows as Record<string, unknown>[]).slice(0, 3).map((r) => ({
      row_id: r.id ?? r.row_id,
      reason: r.reason,
      token_symbol: r.assetSymbol ?? r.token_symbol,
    })),
  });
}

/** Create jobs + run OpenAI synchronously for ≤5 rows */
async function handleRun(
  body: Record<string, unknown>,
  sb: SupabaseClient,
  openAIKey: string,
): Promise<Response> {
  const rows = (body.rows as Record<string, unknown>[]) ?? [];
  const jobType = body.job_type as string | undefined;

  // Safety limit: max 5 jobs per call to prevent runaway cost
  const batch = rows.slice(0, 5);
  if (batch.length === 0) return json({ jobs: [], message: 'No rows to process' });

  const userId = body.user_id as string | undefined ?? null;
  const createdJobs: Record<string, unknown>[] = [];

  for (const row of batch) {
    const detectedJobType = jobType
      ?? (row.job_type as string | undefined)
      ?? (row.reason === 'unknown_asset' ? 'unknown_token_classifier'
         : row.priceBlockDebug ? 'missing_price_explainer'
         : 'suggested_price_assistant');

    const { data: insertedJob, error: insertErr } = await sb
      .from('ai_fallback_jobs')
      .insert({
        user_id: userId,
        job_type: detectedJobType,
        row_id: (row.id ?? row.row_id) as string,
        tx_hash: (row.txHash ?? row.tx_hash) as string,
        chain: (row.chain as string) ?? 'solana',
        token_symbol: (row.assetSymbol ?? row.token_symbol) as string,
        mint_address: (row.contractAddress ?? row.mint_address) as string,
        timestamp: (row.date ?? row.timestamp) as string,
        input_payload: row,
        model: 'gpt-4o-mini',
        prompt_version: '1.0',
      })
      .select()
      .single();

    if (insertErr || !insertedJob) {
      console.error('[ai-fallback] insert job failed:', insertErr?.message);
      continue;
    }

    // Process synchronously (edge functions have a 60s timeout — sufficient for gpt-4o-mini)
    await processJob(sb, insertedJob as Record<string, unknown>, openAIKey);

    // Fetch completed job with result
    const { data: finalJob } = await sb
      .from('ai_fallback_jobs')
      .select('*, ai_fallback_results(*)')
      .eq('id', insertedJob.id as string)
      .single();

    createdJobs.push(finalJob ?? insertedJob);
  }

  return json({ jobs: createdJobs, processed: createdJobs.length });
}

/** Return job status + result */
async function handleGetJob(
  body: Record<string, unknown>,
  sb: SupabaseClient,
): Promise<Response> {
  const jobId = body.job_id as string;
  if (!jobId) return err('job_id required', 400);

  const { data, error: fetchErr } = await sb
    .from('ai_fallback_jobs')
    .select('*, ai_fallback_results(*), ai_fallback_attempts(*)')
    .eq('id', jobId)
    .single();

  if (fetchErr) return err(`Job not found: ${fetchErr.message}`, 404);
  return json(data);
}

/** Mark result as applied; return a patch hint for the client */
async function handleApply(
  body: Record<string, unknown>,
  sb: SupabaseClient,
): Promise<Response> {
  const jobId    = body.job_id    as string;
  const resultId = body.result_id as string;
  if (!resultId) return err('result_id required', 400);

  const { data: result, error: fetchErr } = await sb
    .from('ai_fallback_results')
    .select('*')
    .eq('id', resultId)
    .single();

  if (fetchErr || !result) return err('Result not found', 404);

  await sb.from('ai_fallback_results').update({
    applied: true,
    applied_at: new Date().toISOString(),
  }).eq('id', resultId);

  // Build client-side patch based on job type
  const payload = (result as Record<string, unknown>).result_payload as Record<string, unknown>;
  const jobType = (result as Record<string, unknown>).job_type as string;
  let clientPatch: Record<string, unknown> = {};

  if (jobType === 'unknown_token_classifier') {
    const action = payload?.recommended_action as string;
    clientPatch = {
      action: action === 'hide' ? 'mark_spam' : action === 'ignore' ? 'mark_reviewed' : action,
      classification: payload?.token_classification,
    };
  } else if (jobType === 'suggested_price_assistant') {
    clientPatch = {
      action: 'set_price',
      proposed_price_usd: payload?.proposed_price_usd,
      valuation_basis: payload?.valuation_basis,
      confidence: payload?.confidence,
    };
  } else if (jobType === 'missing_price_explainer') {
    clientPatch = {
      action: payload?.recommended_action,
      root_cause: payload?.root_cause,
    };
  }

  return json({
    applied: true,
    job_id: jobId,
    result_id: resultId,
    client_patch: clientPatch,
  });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request): Promise<Response> => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  if (req.method !== 'POST') {
    return err('Method not allowed', 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON body', 400);
  }

  const action = body.action as string;
  if (!action) return err('action field required', 400);

  try {
    // test action only needs the OpenAI key (no Supabase data needed for the call itself)
    if (action === 'test') {
      const sb = getServiceClient();
      return await handleTest(sb);
    }

    if (action === 'preview') {
      return await handlePreview(body);
    }

    const sb = getServiceClient();

    if (action === 'run') {
      const openAIKey = await getOpenAIKey(sb);
      return await handleRun(body, sb, openAIKey);
    }

    if (action === 'get_job') {
      return await handleGetJob(body, sb);
    }

    if (action === 'apply') {
      return await handleApply(body, sb);
    }

    return err(`Unknown action: ${action}`, 400);

  } catch (e) {
    const msg = (e as Error).message ?? 'Internal error';
    console.error('[ai-fallback]', msg);
    return err(msg, 500);
  }
});
