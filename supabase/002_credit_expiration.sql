-- ============================================================
-- Receipts: add expiration to free Deep Read tokens
-- Run in your Grail Supabase project SQL Editor.
-- Idempotent.
--
-- The Friends & Family promo grants every Grail account 1 free
-- Deep Read good through a fixed end date (2026-05-07). After
-- that, signed-in users without a paid token get downgraded to
-- free reads on the server.
-- ============================================================

alter table receipts_credits
  add column if not exists expires_at timestamptz;

-- Backfill existing rows with the promo end date so anyone who
-- already grabbed a token isn't penalized for being early.
update receipts_credits
  set expires_at = '2026-05-07T23:59:59Z'
  where expires_at is null;
