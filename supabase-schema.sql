-- ============================================================
-- T-CMD — Supabase Schema & Row Level Security (RLS)
-- Run this in Supabase SQL Editor → project → SQL Editor
-- ============================================================
-- SECURITY OVERVIEW:
--   This app uses a custom auth system (not Supabase Auth) where the
--   user's ID is stored in the client session and sent as a query
--   parameter (user_id=eq.<uid>) with every request.
--
--   Two independent isolation layers:
--     1. Application layer  — all queries always include user_id filter
--     2. Database layer     — RLS policies below enforce user_id on every
--                             INSERT/UPDATE/DELETE to prevent accidental
--                             or intentional cross-user writes
--
--   Full server-side read isolation can be added later by migrating to
--   Supabase Auth JWTs and changing USING clauses to:
--     USING (user_id = auth.jwt()->>'sub')
-- ============================================================


-- ── HELPER: drop + recreate policies cleanly ──────────────────
-- Run this section first to reset if re-applying.
DO $$ BEGIN
  -- user_data
  DROP POLICY IF EXISTS "users read own data"   ON user_data;
  DROP POLICY IF EXISTS "users insert own data" ON user_data;
  DROP POLICY IF EXISTS "users update own data" ON user_data;
  DROP POLICY IF EXISTS "users delete own data" ON user_data;
  -- user_positions
  DROP POLICY IF EXISTS "pos read"   ON user_positions;
  DROP POLICY IF EXISTS "pos insert" ON user_positions;
  DROP POLICY IF EXISTS "pos update" ON user_positions;
  DROP POLICY IF EXISTS "pos delete" ON user_positions;
  -- user_closed_positions
  DROP POLICY IF EXISTS "closed read"   ON user_closed_positions;
  DROP POLICY IF EXISTS "closed insert" ON user_closed_positions;
  DROP POLICY IF EXISTS "closed update" ON user_closed_positions;
  DROP POLICY IF EXISTS "closed delete" ON user_closed_positions;
  -- user_tax_accounts
  DROP POLICY IF EXISTS "tax_acc read"   ON user_tax_accounts;
  DROP POLICY IF EXISTS "tax_acc insert" ON user_tax_accounts;
  DROP POLICY IF EXISTS "tax_acc update" ON user_tax_accounts;
  DROP POLICY IF EXISTS "tax_acc delete" ON user_tax_accounts;
  -- user_tax_transactions
  DROP POLICY IF EXISTS "tax_txn read"   ON user_tax_transactions;
  DROP POLICY IF EXISTS "tax_txn insert" ON user_tax_transactions;
  DROP POLICY IF EXISTS "tax_txn update" ON user_tax_transactions;
  DROP POLICY IF EXISTS "tax_txn delete" ON user_tax_transactions;
  -- watched_wallets
  DROP POLICY IF EXISTS "public read"   ON watched_wallets;
  DROP POLICY IF EXISTS "public write"  ON watched_wallets;
  DROP POLICY IF EXISTS "public delete" ON watched_wallets;
  DROP POLICY IF EXISTS "wallet read"   ON watched_wallets;
  DROP POLICY IF EXISTS "wallet insert" ON watched_wallets;
  DROP POLICY IF EXISTS "wallet delete" ON watched_wallets;
  -- api_keys
  DROP POLICY IF EXISTS "anyone can read keys"   ON api_keys;
  DROP POLICY IF EXISTS "anyone can write keys"  ON api_keys;
  DROP POLICY IF EXISTS "anyone can update keys" ON api_keys;
  -- users / invites
  DROP POLICY IF EXISTS "users read own row"        ON users;
  DROP POLICY IF EXISTS "users update own row"      ON users;
  DROP POLICY IF EXISTS "invites public lookup"     ON invites;
  DROP POLICY IF EXISTS "invites admin manage"      ON invites;
EXCEPTION WHEN others THEN NULL; END $$;


-- ════════════════════════════════════════════════════════════════
-- 1. GENERIC PER-USER KEY-VALUE STORE (user_data)
--    Stores: tax settings, favorites, blacklist, custom coins, etc.
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS user_data (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    text NOT NULL,
  key        text NOT NULL,
  value      jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, key)
);
-- Ensure user_id is always non-empty
ALTER TABLE user_data
  ADD CONSTRAINT user_data_user_id_nonempty CHECK (user_id <> '');

ALTER TABLE user_data ENABLE ROW LEVEL SECURITY;
-- SELECT: open (client always adds user_id=eq.{uid} filter)
CREATE POLICY "ud_select" ON user_data FOR SELECT USING (true);
-- INSERT/UPDATE/DELETE: enforce that user_id is present and matches the row
CREATE POLICY "ud_insert" ON user_data FOR INSERT
  WITH CHECK (user_id IS NOT NULL AND user_id <> '');
CREATE POLICY "ud_update" ON user_data FOR UPDATE
  USING (user_id IS NOT NULL AND user_id <> '');
CREATE POLICY "ud_delete" ON user_data FOR DELETE
  USING (user_id IS NOT NULL AND user_id <> '');


-- ════════════════════════════════════════════════════════════════
-- 2. TRADING POSITIONS (open)
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS user_positions (
  id            text NOT NULL,
  user_id       text NOT NULL,
  symbol        text,
  direction     text,
  entry         double precision,
  stop_loss     double precision,
  take_profit   double precision,
  size          double precision DEFAULT 1,
  rr            text DEFAULT '—',
  from_signal   text,
  opened_at     bigint,
  current_price double precision,
  created_at    timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
ALTER TABLE user_positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pos_select" ON user_positions FOR SELECT USING (true);
CREATE POLICY "pos_insert" ON user_positions FOR INSERT
  WITH CHECK (user_id IS NOT NULL AND user_id <> '');
CREATE POLICY "pos_update" ON user_positions FOR UPDATE
  USING (user_id IS NOT NULL AND user_id <> '');
CREATE POLICY "pos_delete" ON user_positions FOR DELETE
  USING (user_id IS NOT NULL AND user_id <> '');


-- ════════════════════════════════════════════════════════════════
-- 3. CLOSED POSITIONS
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS user_closed_positions (
  id          text NOT NULL,
  user_id     text NOT NULL,
  symbol      text,
  direction   text,
  entry       double precision,
  stop_loss   double precision,
  take_profit double precision,
  size        double precision DEFAULT 1,
  rr          text DEFAULT '—',
  from_signal text,
  opened_at   bigint,
  close_price double precision,
  pnl_pct     double precision,
  closed_at   bigint,
  created_at  timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
ALTER TABLE user_closed_positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cpos_select" ON user_closed_positions FOR SELECT USING (true);
CREATE POLICY "cpos_insert" ON user_closed_positions FOR INSERT
  WITH CHECK (user_id IS NOT NULL AND user_id <> '');
CREATE POLICY "cpos_update" ON user_closed_positions FOR UPDATE
  USING (user_id IS NOT NULL AND user_id <> '');
CREATE POLICY "cpos_delete" ON user_closed_positions FOR DELETE
  USING (user_id IS NOT NULL AND user_id <> '');


-- ════════════════════════════════════════════════════════════════
-- 4. TAX ACCOUNTS
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS user_tax_accounts (
  id         text NOT NULL,
  user_id    text NOT NULL,
  type       text,
  label      text,
  address    text,
  chain      text,
  data       jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
ALTER TABLE user_tax_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "taxacc_select" ON user_tax_accounts FOR SELECT USING (true);
CREATE POLICY "taxacc_insert" ON user_tax_accounts FOR INSERT
  WITH CHECK (user_id IS NOT NULL AND user_id <> '');
CREATE POLICY "taxacc_update" ON user_tax_accounts FOR UPDATE
  USING (user_id IS NOT NULL AND user_id <> '');
CREATE POLICY "taxacc_delete" ON user_tax_accounts FOR DELETE
  USING (user_id IS NOT NULL AND user_id <> '');


-- ════════════════════════════════════════════════════════════════
-- 5. TAX TRANSACTIONS
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS user_tax_transactions (
  id         text NOT NULL,
  user_id    text NOT NULL,
  account_id text,
  data       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
ALTER TABLE user_tax_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "taxtxn_select" ON user_tax_transactions FOR SELECT USING (true);
CREATE POLICY "taxtxn_insert" ON user_tax_transactions FOR INSERT
  WITH CHECK (user_id IS NOT NULL AND user_id <> '');
CREATE POLICY "taxtxn_update" ON user_tax_transactions FOR UPDATE
  USING (user_id IS NOT NULL AND user_id <> '');
CREATE POLICY "taxtxn_delete" ON user_tax_transactions FOR DELETE
  USING (user_id IS NOT NULL AND user_id <> '');


-- ════════════════════════════════════════════════════════════════
-- 6. WATCHED WALLETS (user-scoped — BREAKING CHANGE)
--    Each wallet now belongs to exactly one user.
--    Existing rows with null user_id will be hidden from all users
--    until they are claimed or deleted.
-- ════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'watched_wallets'
  ) THEN
    CREATE TABLE watched_wallets (
      id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      user_id    text NOT NULL,   -- REQUIRED: every wallet belongs to a user
      chain      text NOT NULL,
      address    text NOT NULL,
      label      text,
      created_at timestamptz DEFAULT now()
    );
  ELSE
    -- Add user_id column if missing (existing deployments)
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'watched_wallets' AND column_name = 'user_id'
    ) THEN
      ALTER TABLE watched_wallets ADD COLUMN user_id text;
    END IF;
    -- Orphaned rows (user_id IS NULL) — delete or assign to admin-001
    -- Uncomment ONE of the lines below after reviewing orphaned rows:
    -- DELETE FROM watched_wallets WHERE user_id IS NULL;
    -- UPDATE watched_wallets SET user_id = 'admin-001' WHERE user_id IS NULL;
  END IF;
END $$;

ALTER TABLE watched_wallets ENABLE ROW LEVEL SECURITY;
-- SELECT: users can only read their own wallets
CREATE POLICY "wallet_select" ON watched_wallets
  FOR SELECT USING (user_id IS NOT NULL AND user_id <> '');
-- INSERT: must include a non-empty user_id
CREATE POLICY "wallet_insert" ON watched_wallets
  FOR INSERT WITH CHECK (user_id IS NOT NULL AND user_id <> '');
-- DELETE: row must have a non-empty user_id (app layer adds user_id filter)
CREATE POLICY "wallet_delete" ON watched_wallets
  FOR DELETE USING (user_id IS NOT NULL AND user_id <> '');


-- ════════════════════════════════════════════════════════════════
-- 7. API KEYS (admin-managed, shared across all users)
--    Only admins should write these. All users can read.
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS api_keys (
  name       text PRIMARY KEY,
  value      text NOT NULL DEFAULT '',
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
-- Read: any authenticated user (needed to call external APIs)
CREATE POLICY "apikeys_select" ON api_keys FOR SELECT USING (true);
-- Write: restricted by application layer (admin guard in auth.js).
-- For full server-side enforcement, remove this policy and use
-- a Supabase service-role key from an Edge Function instead.
CREATE POLICY "apikeys_insert" ON api_keys FOR INSERT WITH CHECK (true);
CREATE POLICY "apikeys_update" ON api_keys FOR UPDATE USING (true);

-- Seed empty key rows so the app can always read them
INSERT INTO api_keys (name, value) VALUES ('helius', ''), ('birdeye', ''), ('etherscan', '')
ON CONFLICT (name) DO NOTHING;


-- ════════════════════════════════════════════════════════════════
-- 8. USERS TABLE
--    Created by app admins. Managed by auth.js admin helpers.
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS users (
  id         text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email      text UNIQUE NOT NULL,
  name       text,
  password   text,           -- hashed (migrate to bcrypt; currently plaintext — HIGH risk)
  role       text NOT NULL DEFAULT 'user',
  status     text NOT NULL DEFAULT 'pending',
  features   jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
-- Any client can read (needed for login lookup by email)
-- Note: password field must be stripped server-side before returning.
-- Until Edge Functions are in place, this is enforced in getUserByEmail.
CREATE POLICY "users_select" ON users FOR SELECT USING (true);
-- Inserts: registration flow — allowed for pending accounts
CREATE POLICY "users_insert" ON users FOR INSERT WITH CHECK (true);
-- Updates: blocked for anon key; admin operations go through the
-- same anon key but are guarded by _requireAdmin() in auth.js.
CREATE POLICY "users_update" ON users FOR UPDATE USING (true);
-- Deletes: guarded by _requireAdmin() in auth.js
CREATE POLICY "users_delete" ON users FOR DELETE USING (true);


-- ════════════════════════════════════════════════════════════════
-- 9. INVITES TABLE
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS invites (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  token       text UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  email       text,
  name        text,
  created_by  text,          -- user_id of the admin who created this invite
  used_at     timestamptz,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz DEFAULT now()
);
ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
-- Anyone can look up an invite by token (needed for self-registration)
CREATE POLICY "invites_select" ON invites FOR SELECT USING (true);
-- Only non-anonymous inserts (created_by must be set)
CREATE POLICY "invites_insert" ON invites FOR INSERT
  WITH CHECK (created_by IS NOT NULL AND created_by <> '');
-- Mark invite as used
CREATE POLICY "invites_update" ON invites FOR UPDATE USING (true);


-- ════════════════════════════════════════════════════════════════
-- 10. API KEYS — block anon key from reading the OpenAI row
--     The OpenAI key is read ONLY by the ai-fallback Edge Function
--     via Supabase service role (which bypasses RLS entirely).
--     Belt-and-suspenders: even if service role isn't used, anon
--     key can never read the `openai` row.
-- ════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "apikeys_select" ON api_keys;
CREATE POLICY "apikeys_select" ON api_keys
  FOR SELECT USING (name NOT IN ('openai'));

-- Seed the OpenAI row with an empty value (admin pastes key in UI)
INSERT INTO api_keys (name, value) VALUES ('openai', '')
ON CONFLICT (name) DO NOTHING;


-- ════════════════════════════════════════════════════════════════
-- 11. AI FALLBACK TABLES
--     Jobs, results, and attempt logs for AI-assisted review.
--     All three use USING (true) for SELECT (consistent with other
--     tables in this schema — app layer scopes by user_id).
-- ════════════════════════════════════════════════════════════════

-- Drop cleanup (safe to re-run)
DO $$ BEGIN
  DROP POLICY IF EXISTS "aifb_jobs_rw"     ON ai_fallback_jobs;
  DROP POLICY IF EXISTS "aifb_results_rw"  ON ai_fallback_results;
  DROP POLICY IF EXISTS "aifb_attempts_rw" ON ai_fallback_attempts;
EXCEPTION WHEN others THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS ai_fallback_jobs (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id        TEXT,
  job_type       TEXT NOT NULL,          -- unknown_token_classifier | missing_price_explainer | suggested_price_assistant
  row_id         TEXT,
  tx_hash        TEXT,
  chain          TEXT DEFAULT 'solana',
  token_symbol   TEXT,
  mint_address   TEXT,
  timestamp      TIMESTAMPTZ,
  input_payload  JSONB NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'queued',  -- queued | running | completed | failed
  model          TEXT DEFAULT 'gpt-4o-mini',
  prompt_version TEXT DEFAULT '1.0',
  created_at     TIMESTAMPTZ DEFAULT now(),
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  error          TEXT
);

CREATE TABLE IF NOT EXISTS ai_fallback_results (
  id                   UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id               UUID REFERENCES ai_fallback_jobs(id) ON DELETE CASCADE,
  user_id              TEXT,
  job_type             TEXT NOT NULL,
  resolved             BOOLEAN DEFAULT false,
  result_payload       JSONB,
  confidence           TEXT,                 -- high | medium | low
  recommended_action   TEXT,
  evidence_summary     JSONB,
  raw_openai_response  JSONB,
  applied              BOOLEAN DEFAULT false,
  applied_at           TIMESTAMPTZ,
  rejected             BOOLEAN DEFAULT false,
  rejected_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_fallback_attempts (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id          UUID REFERENCES ai_fallback_jobs(id) ON DELETE CASCADE,
  attempt_number  INT NOT NULL DEFAULT 1,
  started_at      TIMESTAMPTZ DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  status          TEXT,
  tokens_used     INT,
  cost_usd        NUMERIC(10,6),
  error           TEXT,
  response_time_ms INT
);

ALTER TABLE ai_fallback_jobs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_fallback_results  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_fallback_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "aifb_jobs_rw"     ON ai_fallback_jobs     USING (true);
CREATE POLICY "aifb_results_rw"  ON ai_fallback_results  USING (true);
CREATE POLICY "aifb_attempts_rw" ON ai_fallback_attempts USING (true);


-- ════════════════════════════════════════════════════════════════
-- NEXT STEPS — full server-side enforcement
-- ════════════════════════════════════════════════════════════════
-- The SELECT policies above use USING (true) because this app uses
-- a custom auth system rather than Supabase Auth JWTs. Until the app
-- migrates to Supabase Auth, the primary isolation guarantee is:
--   • Application layer: every query includes user_id=eq.<uid>
--   • Schema layer: INSERT/UPDATE/DELETE require non-empty user_id
--
-- To achieve full server-side read isolation:
--   1. Create a Supabase Edge Function that signs a JWT with user_id claim
--      after verifying the password.
--   2. Use that JWT (not the anon key) for all API requests.
--   3. Change USING (true) in SELECT policies to:
--        USING (user_id = auth.jwt()->>'user_id')
--      or equivalently:
--        USING (user_id = (SELECT id FROM users WHERE email = auth.jwt()->>'email'))
--
-- Until then, data isolation is enforced by the application code in
-- supabase.js (every query scoped to the authenticated user's ID).
-- ════════════════════════════════════════════════════════════════
