-- Wander: multi-destination trips — epic #196, slice 1 (issue #197).
--
-- Until now a trip holds a single free-text `trips.destination`, so a multi-city
-- journey (Paris → Amsterdam → Berlin) has nowhere to say *which place you're in
-- on which days*: the itinerary is a flat list of dated days with no leg
-- structure, and the header shows one city for a trip that visits several.
--
-- This slice introduces the data model and makes the itinerary, calendar and
-- header read correctly for a multi-city trip. It is deliberately PURELY
-- ADDITIVE and backward-compatible: `trips.destination` stays as the single-place
-- default, and a trip with zero `destinations` rows behaves exactly as it does
-- today.
--
-- A `destinations` row is an ORDERED leg (float `position`, the same midpoint
-- drag-order pattern the itinerary and checklist already use), each with an
-- optional geocoded place (reusing the shared Photon autocomplete) and an
-- optional date range. Because `itinerary_items.day` is a real `date`, a day's
-- leg is DERIVED in the client — it belongs to whichever destination's
-- [start_date, end_date] contains it — so this slice needs NO FK on itinerary
-- items and does not touch that table.
--
-- Explicitly OUT OF SCOPE for this slice (later epic slices): weather-per-leg,
-- per-leg map framing, and updating the duplicate_trip RPC to copy legs.

create table public.destinations (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  name text not null,
  -- Optional geocoded pin from the shared place autocomplete
  -- (src/components/ui/place-autocomplete.tsx). Same double precision the
  -- itinerary coordinates use (#61).
  latitude double precision,
  longitude double precision,
  -- Optional leg date range. A day is assigned to whichever leg's
  -- [start_date, end_date] contains it — derived client-side, no FK.
  start_date date,
  end_date date,
  -- Float ordering, midpoint drag-order like itinerary_items / checklist_items.
  position double precision not null default 0,
  created_at timestamptz not null default now(),
  -- Clients write directly with the anon key and RLS scopes *which rows* a
  -- member may touch, not the *values* they write — so a CHECK is the only
  -- thing that keeps an end-before-start leg from being persisted. A NULL on
  -- either side (an open-ended or dateless leg) passes, preserving the optional
  -- range.
  check (end_date is null or start_date is null or end_date >= start_date)
);

create index destinations_trip_idx on public.destinations (trip_id, position);

alter table public.destinations enable row level security;

-- Reads: any trip member. Writes: OWNER ONLY. Destinations are trip structure —
-- the route skeleton — an owner-only power alongside the trip's dates and
-- details (guardrail 4), enforced here in Postgres and not merely hidden in the
-- UI. Members still add their own itinerary_items freely; those days derive
-- their leg from these owner-defined ranges.
create policy destinations_select on public.destinations for select
  using (is_trip_member(trip_id));
create policy destinations_insert on public.destinations for insert
  with check (is_trip_owner(trip_id));
create policy destinations_update on public.destinations for update
  using (is_trip_owner(trip_id))
  with check (is_trip_owner(trip_id));
create policy destinations_delete on public.destinations for delete
  using (is_trip_owner(trip_id));

-- Realtime publication decision: YES. Destinations drive the itinerary/calendar
-- leg grouping and the trip-header route; when the owner adds, reorders or
-- re-dates a leg, every open member's grouping and header must update live. RLS
-- still applies per subscriber, exactly like the other content tables.
alter publication supabase_realtime add table public.destinations;
