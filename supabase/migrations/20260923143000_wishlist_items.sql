-- Wander: a per-trip wishlist — epic #164, slice 2 (issue #355). Save, don't lose.
--
-- Slice 1 (#165) turned the map into a place you can *find* things — nearby POIs
-- with a one-tap "Add to itinerary". But that flow forces an instant decision: a
-- found place either lands on a specific day now, or it's lost. Real group
-- planning collects "this café looks good" days before anyone knows which day it
-- belongs on, and until now there was nowhere shared to *park* a maybe — it went
-- into freeform notes, a chat message, or a member's head. This slice adds the
-- shelf between browse and schedule: a trip-scoped `wishlist_items` content table
-- of saved-but-unscheduled places, mirroring the shipped `stays` / `transport`
-- trust shape exactly (member-read, self-attributed insert, author-or-owner
-- update + delete) — no new trust boundary.
--
-- DEFERRED to epic #164 slice 3 (kept out to hold this to one model + save/read):
-- dragging or "add to day" *from* the wishlist into the itinerary, and any
-- map-pin rendering of wishlist places. Like stays/transport, wishlist is
-- member-only — NOT added to the public share/recap token projections — and
-- `duplicate_trip` does not copy it in this slice (both are satisfied by
-- omission: those projections and that RPC copy each table explicitly).

create table public.wishlist_items (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  -- Who saved it. Nullable + ON DELETE SET NULL mirrors the other content
  -- tables, so a removed member's saved places remain on the trip rather than
  -- vanishing with them. Authorship also drives the author-or-owner update/delete
  -- policies (named `added_by` here — the "who added this maybe" of a shelf).
  added_by uuid references public.members(id) on delete set null,
  -- The one required field: what the place is ("Blue Bottle", "the botanic
  -- garden"). Free text, so a hand-added entry works without a coordinate.
  name text not null,
  -- Optional category, reusing slice 1's POI category words plus `other` for a
  -- hand-added place that isn't a found POI. Nullable: an IN check passes NULL
  -- (an uncategorized save is allowed). The client writes directly with the anon
  -- key and RLS scopes *which rows* a member may touch, not the *values* they
  -- write — so a CHECK is the only thing constraining the set.
  category text check (category in ('eat', 'see', 'drink', 'other')),
  -- Optional geocoded pin, carried straight from the slice-1 "Nearby" suggestion
  -- (name + coordinates + category). A hand-added place keeps its name with no
  -- pin — the coordinate is never required.
  latitude double precision,
  longitude double precision,
  -- Optional free-text note ("open late", "closed Mondays").
  note text,
  -- Optional link; rendered only as a sanitized http(s) external link, and
  -- normalized to http(s) on write (the client's `safeHttpUrl` guard). The DB
  -- stores whatever the client sends — the sanitization is the same client-side
  -- guard stays/transport booking links use.
  url text,
  -- A float `position` for ordering the shelf (the same midpoint scheme the other
  -- ordered content tables use). The client seeds it monotonically on insert so
  -- newly saved places sort after existing ones; reordering is a later concern.
  position double precision not null default 0,
  created_at timestamptz not null default now()
);

create index wishlist_items_trip_idx on public.wishlist_items (trip_id, position);

alter table public.wishlist_items enable row level security;

-- RLS: identical trip-member scoping to `stays` / `transport` and the other
-- collaborative content tables (the client is UX; Postgres is the enforcement
-- boundary). Any member reads the trip's wishlist and saves a place as
-- themselves; the author OR the trip owner may edit or remove one. A shared "want
-- to go" list — a member fixing a note they added, or the owner tidying the
-- shelf — is exactly the author-or-owner shape stays/transport use. The insert
-- policy pins `added_by` to `my_member_id`, so a forged author is rejected by
-- RLS, not merely hidden by the UI; there is no update-forge path (the WITH CHECK
-- re-asserts authorship on update).
create policy wishlist_items_select on public.wishlist_items for select
  using (is_trip_member(trip_id));
create policy wishlist_items_insert on public.wishlist_items for insert
  with check (is_trip_member(trip_id) and added_by = my_member_id(trip_id));
create policy wishlist_items_update on public.wishlist_items for update
  using (added_by = my_member_id(trip_id) or is_trip_owner(trip_id))
  with check (added_by = my_member_id(trip_id) or is_trip_owner(trip_id));
create policy wishlist_items_delete on public.wishlist_items for delete
  using (added_by = my_member_id(trip_id) or is_trip_owner(trip_id));

-- Realtime publication decision: YES. The wishlist is a shared shelf; when one
-- member saves a place, every open member's shelf must update live without a
-- manual refresh — consistent with stays/transport and the other content tables.
-- RLS still applies per subscriber, so a non-member's subscription sees nothing.
alter publication supabase_realtime add table public.wishlist_items;
