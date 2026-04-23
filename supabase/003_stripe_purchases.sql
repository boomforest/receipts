-- ============================================================
-- Receipts: Stripe purchase tracking + Standard token counter
-- Run in your Grail Supabase project SQL Editor.
-- Idempotent.
--
-- Adds:
--   1. standard_tokens column on receipts_credits (paid Standard reads)
--   2. receipts_purchases table — idempotency log for Stripe webhook events
--      keyed by Stripe event_id so a webhook retry can never grant
--      double credit.
-- ============================================================

-- Standard tokens (paid Sonnet reads). Deep tokens already exist.
alter table receipts_credits
  add column if not exists standard_tokens int not null default 0;

-- Purchase log: one row per fulfilled Stripe checkout.session.completed
create table if not exists receipts_purchases (
  event_id        text        primary key,                  -- Stripe event id (evt_...)
  session_id      text        not null,                     -- Stripe checkout session id (cs_...)
  user_id         uuid        not null references auth.users(id) on delete cascade,
  tier            text        not null check (tier in ('standard', 'deep')),
  amount_cents    int         not null,
  currency        text        not null default 'usd',
  created_at      timestamptz not null default now()
);

create index if not exists receipts_purchases_user_idx on receipts_purchases(user_id);

-- ── RLS ──────────────────────────────────────────────────────
alter table receipts_purchases enable row level security;

-- Users can read their own purchase history (for an account page later).
drop policy if exists "User reads own receipts_purchases" on receipts_purchases;
create policy "User reads own receipts_purchases"
  on receipts_purchases for select
  using (user_id = auth.uid());

-- All writes go through the service role (Stripe webhook handler in worker).
