-- #166: overnight / multi-day itinerary items. An itinerary item is bucketed to
-- a single `day`, so lodging that spans several nights (or a multi-day rail
-- pass, car rental, festival) can't be modelled — and the shipped lodging
-- parser (#103) had nowhere to put the check-out it extracts.
--
-- Give an item an OPTIONAL end of its temporal extent: `end_day`. It reuses the
-- existing `end_time` column for the clock time on that closing day (check-out
-- time). `end_day` is nullable and defaults to NULL, so every existing row keeps
-- exact single-day behaviour — this is purely additive.
--
-- No RLS change is needed: itinerary_items already has RLS enabled with member
-- select/insert/update/delete policies (see the init migration), and those
-- row-level policies govern every column, new ones included. The table is also
-- already part of the supabase_realtime publication, so end_day edits propagate
-- live with no publication change (new columns of a published table replicate
-- automatically).
alter table public.itinerary_items
  add column if not exists end_day date;

-- Range-guard the span in the database. Clients write directly with the anon
-- key and RLS scopes *which rows* a member may touch, not the *values* they
-- write — so a CHECK is the only thing that keeps an end-before-start span from
-- being persisted. NULL end_day (single-day item) and a NULL day both pass, so
-- nullable behaviour is preserved. Guarded in a DO block so the migration stays
-- idempotent: Postgres has no ADD CONSTRAINT IF NOT EXISTS.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'itinerary_items_end_day_order'
  ) then
    alter table public.itinerary_items
      add constraint itinerary_items_end_day_order
      check (end_day is null or day is null or end_day >= day);
  end if;
end $$;
