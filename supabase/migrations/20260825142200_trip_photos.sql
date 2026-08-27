-- #294 (epic #205, slice 4): Trip photos — a browsable gallery that gathers a
-- trip's images in one place.
--
-- Most of the gallery is a read-only *aggregation* of images that already live in
-- the trip: chat images (#51, `messages.image_path`) and inspiration-board images
-- (`inspiration_items.image_url`). Those need no new storage and no new table.
-- This migration adds only the missing piece — a place to record a photo a member
-- uploads straight into the gallery, one that was never a chat message or a pinned
-- idea.
--
-- Storage: direct-upload photos reuse the existing private `chat-images` bucket
-- (#51) and its exact `<trip_id>/<uuid>.<ext>` path + Storage RLS. No new bucket,
-- no new storage policy, no new public-read surface — a gallery upload is exactly
-- as private as a chat image, gated by the same `is_trip_member` check on the
-- object's first path segment. This table is only the *pointer* to the object.
create table if not exists public.trip_photos (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  -- Who added it. Nullable + ON DELETE SET NULL mirrors messages/inspiration, so a
  -- removed member's photos stay in the gallery rather than vanishing with them.
  member_id uuid references public.members(id) on delete set null,
  -- Object path into the private chat-images bucket, `<trip_id>/<uuid>.<ext>`.
  image_path text not null,
  created_at timestamptz not null default now()
);

create index if not exists trip_photos_trip_idx
  on public.trip_photos (trip_id, created_at desc);

alter table public.trip_photos enable row level security;

-- RLS: identical trip-member scoping to every other content table (the client is
-- UX; Postgres is the enforcement boundary). Any member reads the trip's photos
-- and adds one as themselves; the uploader or the trip owner can remove one. There
-- is deliberately NO update policy — a photo pointer is immutable; to change it,
-- delete and re-add (the delete policy already restricts that to the uploader or
-- the owner). With no `for update` policy Postgres denies every UPDATE by default,
-- so no member can re-point another member's photo via a direct PostgREST call.
create policy trip_photos_select on public.trip_photos for select
  using (is_trip_member(trip_id));
create policy trip_photos_insert on public.trip_photos for insert
  with check (is_trip_member(trip_id) and member_id = my_member_id(trip_id));
create policy trip_photos_delete on public.trip_photos for delete
  using (member_id = my_member_id(trip_id) or is_trip_owner(trip_id));

-- Realtime: broadcast row changes so a photo another member uploads appears in
-- everyone's gallery without a manual refresh (RLS still applies per subscriber),
-- consistent with the rest of the app.
alter publication supabase_realtime add table public.trip_photos;
