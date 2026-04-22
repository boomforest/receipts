-- ============================================================
-- Receipts: per-Grail-user Deep Read token ledger
-- Run in your Grail Supabase project SQL Editor.
-- Idempotent.
--
-- Every Grail account gets 1 free Deep Read on Receipts. The
-- token is auto-granted server-side the first time a signed-in
-- user requests an analysis. Decremented atomically when used.
-- ============================================================

create table if not exists receipts_credits (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  deep_tokens  int  not null default 1,
  used_at      timestamptz,
  granted_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ── RLS ──────────────────────────────────────────────────────
alter table receipts_credits enable row level security;

-- Users can read their own credit balance (so the UI can show it)
drop policy if exists "User reads own receipts_credits" on receipts_credits;
create policy "User reads own receipts_credits"
  on receipts_credits for select
  using (user_id = auth.uid());

-- All inserts and updates go through the service role
-- (analyze.js function on Receipts) — no public write policies.
