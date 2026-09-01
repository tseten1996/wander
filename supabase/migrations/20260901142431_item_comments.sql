-- #314 (epic #313, slice 1): Comment threads pinned to an itinerary item.
--
-- "Should we do the museum or the beach on Friday?" gets decided in the trip
-- chat and then lost to it — the itinerary item the debate was about carries a
-- name, a time and a place, but never the conversation that put it there. This
-- stands up the epic's polymorphic `comments` table, wired to exactly one
-- `entity_type` (`itinerary_item`) to start, so the discussion can live on the
-- plan itself.
--
-- Deliberately the lowest-risk slice: an additive content table whose trust
-- shape is COPIED from `messages`, not invented — member-scoped read, a
-- self-attributed insert, an author-or-owner delete, and no update path. No
-- existing surface changes for an item that has no comments.
create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  -- Which kind of thing this comment is attached to. CHECK-restricted to a
  -- single value for now; epic slices 2/3 widen it (budget entries, polls).
  entity_type text not null check (entity_type in ('itinerary_item')),
  -- A *soft* pointer to the commented-on row — no FK, matching how
  -- `notifications.entity_id` already points without cascading. Deleting the
  -- itinerary item therefore never cascades here; a comment whose item is gone
  -- is simply never queried (the item's id stops appearing in any query).
  entity_id uuid not null,
  -- Who wrote it. Nullable + ON DELETE SET NULL mirrors `messages`, so a removed
  -- member's comments stay on the item rather than vanishing with them.
  member_id uuid references public.members(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);

-- The one access pattern: a thread for a given entity, oldest-first. The
-- per-item count badge reads the same (trip_id, entity_type) prefix.
create index if not exists comments_entity_idx
  on public.comments (trip_id, entity_type, entity_id, created_at);

alter table public.comments enable row level security;

-- RLS copied from `messages` (the client is UX; Postgres is the enforcement
-- boundary): any trip member reads the thread; a member inserts only as
-- themselves (member_id = my_member_id); the author or the trip owner may
-- delete. There is deliberately NO update policy — a comment is immutable in
-- this slice (editing is out of scope), and with no `for update` policy
-- Postgres denies every UPDATE by default, so no member can rewrite another
-- member's comment via a direct PostgREST call.
create policy comments_select on public.comments for select
  using (is_trip_member(trip_id));
create policy comments_insert on public.comments for insert
  with check (is_trip_member(trip_id) and member_id = my_member_id(trip_id));
create policy comments_delete on public.comments for delete
  using (member_id = my_member_id(trip_id) or is_trip_owner(trip_id));

-- Realtime: broadcast row changes so a comment another member posts appears in
-- everyone's open item dialog and count badge without a manual refresh (RLS
-- still applies per subscriber), consistent with the rest of the app.
alter publication supabase_realtime add table public.comments;
