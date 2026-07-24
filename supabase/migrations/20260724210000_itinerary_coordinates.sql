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
