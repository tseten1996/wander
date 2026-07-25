-- #104: split an expense among only some members (subset shares in settle-up).
--
-- Until now settle-up divided every expense evenly across *all* current trip
-- members (`settlement.ts`: `share = pool / members.length`). That is wrong for
-- the most common group-travel expense — the one only some people shared (three
-- of five at a $150 dinner). This adds an explicit participant set per entry.
--
-- Design:
--   • `participants` — the members who actually share this cost, as an array of
--     `members.id`. NULL or an empty array means "shared by all current members"
--     — which is exactly today's behaviour, so every pre-existing row keeps its
--     current settlement semantics and NO backfill is needed.
--
-- Why uuid[] and not a join table: the set is small (a trip's members), always
-- read together with the entry, and never queried independently. An array keeps
-- it one column on a table members already write, so RLS and the realtime
-- publication for budget_entries need no change — the existing
-- is_trip_member / is_trip_owner policies cover the new column automatically,
-- same as the #79 currency columns.
--
-- No element-level foreign key is possible on a Postgres array; a participant
-- who later leaves the trip is handled in the settlement math (their per-entry
-- share redistributes among the remaining participants — see settlement.ts),
-- so a dangling id degrades gracefully rather than corrupting a balance.
alter table public.budget_entries
  add column if not exists participants uuid[];

-- Integrity at the DB boundary (Wander invariant: Postgres enforces, the client
-- is UX). `participants` is client-written and `budget_update` is gated only by
-- is_trip_member, so any member could hand-craft the array through PostgREST.
-- A duplicate element (['a','a','b']) would hand one member a double share —
-- the arbitrary-weighted split this slice explicitly scopes out — and a NULL
-- element is meaningless. Reject both here so a malformed set can never reach
-- settlement (settlement.ts also dedupes defensively; this closes the boundary).
--
-- A CHECK cannot contain a subquery, so the set test lives in an IMMUTABLE
-- helper. "Clean" = NULL (shared-by-all), or every element non-null and
-- distinct: total length equals the count of distinct non-null elements. The
-- column is brand-new and all-NULL, so no existing row can violate this.
create or replace function public.uuid_array_is_clean(arr uuid[])
returns boolean
language sql
immutable
as $$
  select arr is null
      or cardinality(arr) = (
           select count(distinct x)
           from unnest(arr) as u(x)
           where x is not null
         )
$$;

alter table public.budget_entries
  drop constraint if exists budget_entries_participants_clean;
alter table public.budget_entries
  add constraint budget_entries_participants_clean
  check (public.uuid_array_is_clean(participants));
