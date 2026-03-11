-- ============================================================
-- T-CMD — Per-User Data Persistence Schema
-- Run this in Supabase SQL Editor (supabase.com → project → SQL)
-- ============================================================

-- ── 1. Generic per-user key-value store ─────────────────────
-- Stores: favorites, blacklist, custom coins, settings, etc.
CREATE TABLE IF NOT EXISTS user_data (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    text NOT NULL,
  key        text NOT NULL,
  value      jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, key)
);
ALTER TABLE user_data ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users read own data"   ON user_data FOR SELECT USING (true);
CREATE POLICY "users insert own data" ON user_data FOR INSERT WITH CHECK (true);
CREATE POLICY "users update own data" ON user_data FOR UPDATE USING (true);
CREATE POLICY "users delete own data" ON user_data FOR DELETE USING (true);

-- ── 2. Trading positions (open) ─────────────────────────────
CREATE TABLE IF NOT EXISTS user_positions (
  id           text NOT NULL,
  user_id      text NOT NULL,
  symbol       text,
  direction    text,
  entry        double precision,
  stop_loss    double precision,
  take_profit  double precision,
  size         double precision DEFAULT 1,
  rr           text DEFAULT '—',
  from_signal  text,
  opened_at    bigint,
  current_price double precision,
  created_at   timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
ALTER TABLE user_positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pos read"   ON user_positions FOR SELECT USING (true);
CREATE POLICY "pos insert" ON user_positions FOR INSERT WITH CHECK (true);
CREATE POLICY "pos update" ON user_positions FOR UPDATE USING (true);
CREATE POLICY "pos delete" ON user_positions FOR DELETE USING (true);

-- ── 3. Closed positions ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_closed_positions (
  id           text NOT NULL,
  user_id      text NOT NULL,
  symbol       text,
  direction    text,
  entry        double precision,
  stop_loss    double precision,
  take_profit  double precision,
  size         double precision DEFAULT 1,
  rr           text DEFAULT '—',
  from_signal  text,
  opened_at    bigint,
  close_price  double precision,
  pnl_pct      double precision,
  closed_at    bigint,
  created_at   timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
ALTER TABLE user_closed_positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "closed read"   ON user_closed_positions FOR SELECT USING (true);
CREATE POLICY "closed insert" ON user_closed_positions FOR INSERT WITH CHECK (true);
CREATE POLICY "closed update" ON user_closed_positions FOR UPDATE USING (true);
CREATE POLICY "closed delete" ON user_closed_positions FOR DELETE USING (true);

-- ── 4. Tax accounts ─────────────────────────────────────────
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
CREATE POLICY "tax_acc read"   ON user_tax_accounts FOR SELECT USING (true);
CREATE POLICY "tax_acc insert" ON user_tax_accounts FOR INSERT WITH CHECK (true);
CREATE POLICY "tax_acc update" ON user_tax_accounts FOR UPDATE USING (true);
CREATE POLICY "tax_acc delete" ON user_tax_accounts FOR DELETE USING (true);

-- ── 5. Tax transactions ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_tax_transactions (
  id         text NOT NULL,
  user_id    text NOT NULL,
  account_id text,
  data       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
ALTER TABLE user_tax_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tax_txn read"   ON user_tax_transactions FOR SELECT USING (true);
CREATE POLICY "tax_txn insert" ON user_tax_transactions FOR INSERT WITH CHECK (true);
CREATE POLICY "tax_txn update" ON user_tax_transactions FOR UPDATE USING (true);
CREATE POLICY "tax_txn delete" ON user_tax_transactions FOR DELETE USING (true);

-- ── 6. Centralised API keys (admin-managed) ─────────────────
CREATE TABLE IF NOT EXISTS api_keys (
  name       text PRIMARY KEY,
  value      text NOT NULL DEFAULT '',
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anyone can read keys"  ON api_keys FOR SELECT USING (true);
CREATE POLICY "anyone can write keys" ON api_keys FOR INSERT WITH CHECK (true);
CREATE POLICY "anyone can update keys" ON api_keys FOR UPDATE USING (true);

-- Seed default empty keys so the app can read them
INSERT INTO api_keys (name, value) VALUES
  ('helius',    ''),
  ('birdeye',   ''),
  ('etherscan', '')
ON CONFLICT (name) DO NOTHING;

-- ── 7. Add user_id to watched_wallets (if table exists) ─────
-- If you haven't created watched_wallets yet, run this full create:
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'watched_wallets'
  ) THEN
    CREATE TABLE watched_wallets (
      id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      user_id    text,
      chain      text NOT NULL,
      address    text NOT NULL,
      label      text,
      created_at timestamptz DEFAULT now()
    );
    ALTER TABLE watched_wallets ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "public read"   ON watched_wallets FOR SELECT USING (true);
    CREATE POLICY "public write"  ON watched_wallets FOR INSERT WITH CHECK (true);
    CREATE POLICY "public delete" ON watched_wallets FOR DELETE USING (true);
  ELSE
    -- Table exists — add user_id column if missing
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'watched_wallets' AND column_name = 'user_id'
    ) THEN
      ALTER TABLE watched_wallets ADD COLUMN user_id text;
    END IF;
  END IF;
END
$$;
