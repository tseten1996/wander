-- Map view (#61): itinerary items can carry geocoded coordinates so the Map
-- view can plot them as pins. Both columns are nullable — an item without a
-- geocoded location is not dropped, it degrades to the "no location yet" strip
-- in the UI.
--
-- No RLS change is needed: itinerary_items already has RLS enabled with member
-- select/insert/update/delete policies (see the init migration), and those
-- row-level policies govern every column, new ones included. The table is also
-- already part of the supabase_realtime publication, so coordinate edits
-- propagate live with no publication change.
alter table public.itinerary_items
  add column if not exists latitude double precision,
  add column if not exists longitude double precision;

-- Range-guard the coordinates in the database. Clients write directly with the
-- anon key and RLS scopes *which rows* a member may touch, not the *values*
-- they write — so a CHECK is the only thing that keeps an out-of-range lat/lng
-- from being persisted. Nullable behaviour is preserved (null passes the check).
-- Guarded in a DO block so the migration stays idempotent: Postgres has no
-- ADD CONSTRAINT IF NOT EXISTS.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'itinerary_items_latitude_range'
  ) then
    alter table public.itinerary_items
      add constraint itinerary_items_latitude_range
      check (latitude is null or (latitude >= -90 and latitude <= 90));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'itinerary_items_longitude_range'
  ) then
    alter table public.itinerary_items
      add constraint itinerary_items_longitude_range
      check (longitude is null or (longitude >= -180 and longitude <= 180));
  end if;
end $$;
