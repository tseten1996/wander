-- Wander: trip logistics — epic #346, slice 2 (issue #350). Getting between places.
--
-- The Stays slice (#348) gave "where are we sleeping" a structured home; this
-- slice gives "how we get between places" the same. On a multi-city trip the
-- most-asked logistics question — "what time is the Paris→Amsterdam train, and
-- what's the booking reference?" — had no answer but a screenshot buried in
-- chat. A `transport` content table records one getting-there hop: its mode, the
-- depart/arrive place + time, and the confirmation code + booking link people
-- pull up at a gate. It mirrors the shipped `stays` table's trust shape exactly
-- (member-read, self-attributed insert, author-or-owner update + delete) — no
-- new trust boundary. Map pins for endpoints, the budget cost-link, and any
-- leg-to-leg auto-slotting are DEFERRED to later slices of #346.

create table public.transport (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  -- Who added it. Nullable + ON DELETE SET NULL mirrors the other content
  -- tables, so a removed member's hops remain on the trip rather than vanishing
  -- with them. Authorship also drives the author-or-owner update/delete policies.
  member_id uuid references public.members(id) on delete set null,
  -- The one required field (the analogue of stays.name): what kind of hop. A
  -- CHECK — not a lookup table — constrains the five values, because the client
  -- writes directly with the anon key and RLS scopes *which rows* a member may
  -- touch, not the *values* they write.
  mode text not null check (mode in ('flight', 'train', 'bus', 'car', 'ferry')),
  -- Optional endpoints: free text ("Gare du Nord", "CDG T2", "Dana's"). No
  -- geocoded pin in this slice — map endpoints are deferred to a later slice.
  depart_place text,
  arrive_place text,
  -- Optional depart/arrive datetimes as WALL-CLOCK local time, deliberately
  -- `timestamp` WITHOUT time zone: a 14:30 train departs 14:30 at the station
  -- regardless of where a member reading the trip happens to be, so no viewer's
  -- browser timezone may shift the number. The client sends and reads a naive
  -- `YYYY-MM-DDTHH:mm` string; the day a hop lands on is the date prefix, so the
  -- calendar surface is timezone-immune. A NULL on either side (a hop with a
  -- known mode but a time still TBD) is allowed.
  depart_at timestamp,
  arrive_at timestamp,
  -- Optional gate details. confirmation_code is copy-to-clipboard in the UI;
  -- booking_url is rendered only as a sanitized http(s) external link.
  confirmation_code text,
  booking_url text,
  created_at timestamptz not null default now(),
  -- A CHECK is the only thing that keeps an arrive-before-depart hop from being
  -- persisted through a direct PostgREST write. A NULL on either side (an
  -- open-ended or time-TBD hop) passes, preserving the optional range.
  check (arrive_at is null or depart_at is null or arrive_at >= depart_at)
);

create index transport_trip_idx on public.transport (trip_id, depart_at);

alter table public.transport enable row level security;

-- RLS: identical trip-member scoping to `stays` and the other collaborative
-- content tables (the client is UX; Postgres is the enforcement boundary). Any
-- member reads the trip's transport and adds a hop as themselves; the author OR
-- the trip owner may edit or remove one. A shared booking record — a member
-- fixing the confirmation code they entered, or the owner tidying the list — is
-- exactly the author-or-owner shape `stays` uses, stricter than the any-member
-- update on notes/itinerary.
create policy transport_select on public.transport for select
  using (is_trip_member(trip_id));
create policy transport_insert on public.transport for insert
  with check (is_trip_member(trip_id) and member_id = my_member_id(trip_id));
create policy transport_update on public.transport for update
  using (member_id = my_member_id(trip_id) or is_trip_owner(trip_id))
  with check (member_id = my_member_id(trip_id) or is_trip_owner(trip_id));
create policy transport_delete on public.transport for delete
  using (member_id = my_member_id(trip_id) or is_trip_owner(trip_id));

-- Realtime publication decision: YES. Transport drives a shared list and the
-- calendar day surface; when one member adds or edits a hop, every open member's
-- list and calendar must update live without a manual refresh — consistent with
-- `stays` and the other content tables. RLS still applies per subscriber, so a
-- non-member's subscription still sees nothing.
alter publication supabase_realtime add table public.transport;
