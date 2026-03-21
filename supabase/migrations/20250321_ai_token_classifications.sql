-- ─────────────────────────────────────────────────────────────────────────
-- Migration: AI token classification tables
-- Run once in Supabase SQL Editor (Project → SQL Editor → New query)
-- ─────────────────────────────────────────────────────────────────────────

-- ── ai_token_classifications ──────────────────────────────────────────────
-- Persistent cache of AI classification results, keyed by token_key.
-- Rows are upserted by the Edge Function so repeated tokens are never
-- re-sent to OpenAI.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists ai_token_classifications (
  id                 uuid        primary key default gen_random_uuid(),
  token_key          text        not null unique,   -- "solana:mint" or "solana:sym:SYMBOL"
  chain              text        not null default 'solana',
  mint_or_contract   text,
  symbol_observed    text,
  classification     text        not null,          -- spam|swap_intermediate|low_value|likely_airdrop|real_token|unknown_real
  confidence         text        not null,          -- high|medium|low
  recommended_action text        not null,          -- hide|collapse_into_swap|ignore_low_value|suggest_airdrop|keep_for_review
  display_name       text,
  explanation        text        not null default '',
  evidence           jsonb       not null default '[]'::jsonb,
  warnings           jsonb       not null default '[]'::jsonb,
  source             text        not null default 'openai',     -- openai | deterministic | manual
  prompt_version     text        not null default '1.0',
  model_name         text        not null default 'gpt-4o-mini',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_ai_token_cls_token_key
  on ai_token_classifications(token_key);

create index if not exists idx_ai_token_cls_chain_mint
  on ai_token_classifications(chain, mint_or_contract)
  where mint_or_contract is not null;

-- ── ai_token_classification_jobs ──────────────────────────────────────────
-- Audit log for each batch classification run.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists ai_token_classification_jobs (
  id              uuid        primary key default gen_random_uuid(),
  user_id         text        not null default 'anonymous',
  status          text        not null default 'queued',   -- queued|running|completed|partial|failed
  input_count     integer     not null default 0,
  resolved_count  integer     not null default 0,
  summary         jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ── RLS ───────────────────────────────────────────────────────────────────
-- Both tables are written by the Edge Function (service role, bypasses RLS).
-- The browser can READ classifications (public cache — no sensitive data).
-- Nobody can write via the browser anon key.

alter table ai_token_classifications    enable row level security;
alter table ai_token_classification_jobs enable row level security;

-- Allow anon / authenticated to read classifications (public cache)
do $$ begin
  drop policy if exists "ai_token_cls_read"  on ai_token_classifications;
  drop policy if exists "ai_token_jobs_read" on ai_token_classification_jobs;
exception when others then null; end $$;

create policy "ai_token_cls_read"
  on ai_token_classifications for select
  using (true);

create policy "ai_token_jobs_read"
  on ai_token_classification_jobs for select
  using (true);

-- No insert/update/delete from the browser — service role only
