-- #79: multi-currency budget entries. A cost can be logged in its own
-- currency (hotel in EUR, flights in USD) while all roll-ups and the "who
-- owes who" settlement stay correct in the trip currency.
--
-- Design:
--   • `currency`             — the entry's original ISO currency code. NULL
--                              means "trip currency" (every pre-existing row),
--                              so historical entries need no backfill.
--   • `estimated_converted`  — `estimated` expressed in the trip currency,
--     `actual_converted`       frozen at entry time. NULL when the entry is
--                              already in the trip currency (use the raw
--                              amount) — the client reads `converted ?? raw`.
--   • `exchange_rate`        — original→trip rate used, kept for transparency
--                              and so historical entries don't drift when
--                              rates later move. NULL for trip-currency rows.
--
-- Amounts are frozen (not recomputed live) precisely so a settled trip's
-- numbers never change under the group's feet after the rate moves.
--
-- RLS and the realtime publication for budget_entries are unchanged: new
-- columns of an already-published, already-policied table replicate and are
-- covered by the existing is_trip_member / is_trip_owner policies automatically.
alter table public.budget_entries
  add column if not exists currency text,
  add column if not exists estimated_converted numeric(12,2),
  add column if not exists actual_converted numeric(12,2),
  add column if not exists exchange_rate numeric(18,8);
