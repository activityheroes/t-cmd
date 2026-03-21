-- ============================================================
-- T-CMD — AI Fallback Migration (run this, not the full schema)
-- Supabase SQL Editor → New query → paste → Run
-- ============================================================

-- ── 1. Update api_keys RLS: block anon key from reading openai row ──
DROP POLICY IF EXISTS "apikeys_select" ON api_keys;
CREATE POLICY "apikeys_select" ON api_keys
  FOR SELECT USING (name NOT IN ('openai'));

-- Keep write policies (unchanged)
DROP POLICY IF EXISTS "apikeys_insert" ON api_keys;
DROP POLICY IF EXISTS "apikeys_update" ON api_keys;
CREATE POLICY "apikeys_insert" ON api_keys FOR INSERT WITH CHECK (true);
CREATE POLICY "apikeys_update" ON api_keys FOR UPDATE USING (true);

-- Seed openai row (empty — admin pastes key in UI)
INSERT INTO api_keys (name, value) VALUES ('openai', '')
ON CONFLICT (name) DO NOTHING;


-- ── 2. AI Fallback tables ────────────────────────────────────────────

-- Drop old policies safely (tables may not exist yet on first run)
DO $$ BEGIN
  DROP POLICY IF EXISTS "aifb_jobs_rw"     ON ai_fallback_jobs;
  DROP POLICY IF EXISTS "aifb_results_rw"  ON ai_fallback_results;
  DROP POLICY IF EXISTS "aifb_attempts_rw" ON ai_fallback_attempts;
EXCEPTION WHEN others THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS ai_fallback_jobs (
  id             uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id        text,
  job_type       text        NOT NULL,
  row_id         text,
  tx_hash        text,
  chain          text        DEFAULT 'solana',
  token_symbol   text,
  mint_address   text,
  timestamp      timestamptz,
  input_payload  jsonb       NOT NULL DEFAULT '{}',
  status         text        NOT NULL DEFAULT 'queued',
  model          text        DEFAULT 'gpt-4o-mini',
  prompt_version text        DEFAULT '1.0',
  created_at     timestamptz DEFAULT now(),
  started_at     timestamptz,
  completed_at   timestamptz,
  error          text
);

CREATE TABLE IF NOT EXISTS ai_fallback_results (
  id                   uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id               uuid        REFERENCES ai_fallback_jobs(id) ON DELETE CASCADE,
  user_id              text,
  job_type             text        NOT NULL,
  resolved             boolean     DEFAULT false,
  result_payload       jsonb,
  confidence           text,
  recommended_action   text,
  evidence_summary     jsonb,
  raw_openai_response  jsonb,
  applied              boolean     DEFAULT false,
  applied_at           timestamptz,
  rejected             boolean     DEFAULT false,
  rejected_at          timestamptz,
  created_at           timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_fallback_attempts (
  id               uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id           uuid        REFERENCES ai_fallback_jobs(id) ON DELETE CASCADE,
  attempt_number   int         NOT NULL DEFAULT 1,
  started_at       timestamptz DEFAULT now(),
  completed_at     timestamptz,
  status           text,
  tokens_used      int,
  cost_usd         numeric(10,6),
  error            text,
  response_time_ms int
);

ALTER TABLE ai_fallback_jobs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_fallback_results  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_fallback_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "aifb_jobs_rw"     ON ai_fallback_jobs     FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "aifb_results_rw"  ON ai_fallback_results  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "aifb_attempts_rw" ON ai_fallback_attempts FOR ALL USING (true) WITH CHECK (true);
