-- Wander: trip logistics — epic #346, slice 1 (issue #348). Lodging only.
--
-- A trip stays somewhere, and until now Wander had nowhere structured to put it:
-- the hotel/Airbnb name, its address, the check-in / check-out dates, the
-- confirmation code and booking link all landed in freeform notes or the
-- inspiration board, invisible to the calendar and the "who's here today" view.
-- On a multi-city trip (real via legs, `destinations`/#196) the most-asked
-- logistics question — "which place are we in tonight, and what's the check-in
-- code?" — had no answer in the app.
--
-- This slice adds a trip-scoped `stays` content table mirroring the other
-- content tables' trust shape, plus a calendar day surface that shows which stay
-- covers each day (derived client-side from `[check_in, check_out)`, reusing the
-- leg date-range discipline — no FK on any day row). Transport, map pins, and the
-- budget cost-link are DEFERRED to later slices of #346.

create table public.stays (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  -- Who added it. Nullable + ON DELETE SET NULL mirrors the other content
  -- tables, so a removed member's stays remain on the trip rather than vanishing
  -- with them. Authorship also drives the author-or-owner update/delete policies.
  member_id uuid references public.members(id) on delete set null,
  name text not null,
  -- Optional address + geocoded pin from the shared place autocomplete
  -- (src/lib/geocode.ts), exactly as itinerary items do. A stay with an address
  -- but no coordinates (geocode miss/timeout) keeps the plain text — the address
  -- is never lost to a failed lookup.
  address text,
  latitude double precision,
  longitude double precision,
  -- Optional stay window. A day belongs to the stay whose half-open
  -- [check_in, check_out) contains it — you sleep there on check_in through the
  -- night before check_out, not on the check_out morning. Derived client-side.
  check_in date,
  check_out date,
  -- Optional front-desk details. confirmation_code is copy-to-clipboard in the
  -- UI; booking_url is rendered only as a sanitized http(s) external link.
  confirmation_code text,
  booking_url text,
  created_at timestamptz not null default now(),
  -- Clients write directly with the anon key and RLS scopes *which rows* a
  -- member may touch, not the *values* they write — so a CHECK is the only thing
  -- that keeps a checkout-before-checkin stay from being persisted. A NULL on
  -- either side (an open-ended or dateless stay) passes, preserving the optional
  -- range. A stay's dates need NOT fall inside the trip's own range: early
  -- arrivals and late checkouts happen, so no trip-range guard here.
  check (check_out is null or check_in is null or check_out >= check_in)
);

create index stays_trip_idx on public.stays (trip_id, check_in);

alter table public.stays enable row level security;

-- RLS: identical trip-member scoping to the collaborative content tables (the
-- client is UX; Postgres is the enforcement boundary). Any member reads the
-- trip's stays and adds one as themselves; the author OR the trip owner may edit
-- or remove one. Lodging is shared logistics — a member fixing a typo in the
-- check-in code they entered, or the owner tidying the list, are both expected —
-- so update mirrors delete as author-or-owner (stricter than the any-member
-- update on notes/itinerary, which is the right default for a booking record).
create policy stays_select on public.stays for select
  using (is_trip_member(trip_id));
create policy stays_insert on public.stays for insert
  with check (is_trip_member(trip_id) and member_id = my_member_id(trip_id));
create policy stays_update on public.stays for update
  using (member_id = my_member_id(trip_id) or is_trip_owner(trip_id))
  with check (member_id = my_member_id(trip_id) or is_trip_owner(trip_id));
create policy stays_delete on public.stays for delete
  using (member_id = my_member_id(trip_id) or is_trip_owner(trip_id));

-- Realtime publication decision: YES. Stays drive a shared list and the calendar
-- day surface; when one member adds or edits a booking, every open member's list
-- and calendar must update live without a manual refresh — consistent with the
-- other content tables. RLS still applies per subscriber, so a non-member's
-- subscription still sees nothing.
alter publication supabase_realtime add table public.stays;
