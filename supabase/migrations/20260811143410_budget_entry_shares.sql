-- #203: weighted / itemized expense splits (unequal settle-up).
--
-- #104 gave each entry a `participants` set — *who* shares a cost — but every
-- named sharer still paid an identical fraction (`settlement.ts`:
-- `share = amount / sharers.length`). Real group trips are rarely equal: one
-- person takes the suite while two share a bunk, three order wine and one
-- doesn't. This adds an explicit per-sharer weight so the same cost can divide
-- proportionally.
--
-- Design:
--   • `shares` — a `{ member_id: weight }` JSON map. NULL or an empty object
--     means "equal split across `participants`" — exactly today's behaviour, so
--     every pre-existing row keeps its current settlement semantics and NO
--     backfill is needed. When present, the map's keys are authoritative for
--     *who* shares (a superset of what `participants` would say) and each
--     member's cost is `amount * weight_i / Σweights` (settlement.ts).
--
-- Why a single jsonb column and not a join table: like `participants`, the set
-- is small (a trip's members), always read together with the entry, and never
-- queried independently. One column on a table members already write keeps RLS
-- and the realtime publication unchanged — the existing is_trip_member /
-- is_trip_owner policies (and the #172 owner/creator update refinement) cover
-- the new column automatically, and budget_entries is already in the
-- supabase_realtime publication, so no publication change is needed.
--
-- Weights are scale-free: "by shares" stores integer weights, "by exact amount"
-- stores the exact per-member amounts, and "by percent" stores the percentages
-- — all three reduce to the same proportional division, so only the resolved
-- weights are persisted (the entry mode is a UI concern, not stored).
alter table public.budget_entries
  add column if not exists shares jsonb;

-- Integrity at the DB boundary (Wander invariant: Postgres enforces, the client
-- is UX). `shares` is client-written and `budget_update` is gated on
-- is_trip_member (with the #172 owner/creator refinement), so any member could
-- hand-craft the map through PostgREST. A non-numeric or non-positive weight
-- would corrupt the proportional division (a zero or negative weight has no
-- meaning in a split, and a NaN would poison every balance). Reject anything but
-- a JSON object of positive numbers here so a malformed map can never reach
-- settlement (settlement.ts also filters defensively; this closes the boundary).
--
-- A CHECK cannot contain a subquery, so the object test lives in an IMMUTABLE
-- helper. "Clean" = NULL, or a JSON object every value of which is a positive
-- number. An empty object trivially passes (no values) and settlement reads it
-- as "equal split", same as NULL. The column is brand-new and all-NULL, so no
-- existing row can violate this.
create or replace function public.jsonb_shares_is_clean(obj jsonb)
returns boolean
language sql
immutable
as $$
  select obj is null
      or (
        jsonb_typeof(obj) = 'object'
        and not exists (
          select 1
          from jsonb_each(obj) as e(key, value)
          where jsonb_typeof(value) is distinct from 'number'
             or (value #>> '{}')::numeric <= 0
        )
      )
$$;

alter table public.budget_entries
  drop constraint if exists budget_entries_shares_clean;
alter table public.budget_entries
  add constraint budget_entries_shares_clean
  check (public.jsonb_shares_is_clean(shares));
