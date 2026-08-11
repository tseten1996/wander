-- #51: chat images — members can paste, drop, or pick an image to share it
-- inline in the trip chat. Images live in a private Storage bucket scoped to
-- trip members by RLS; the message row only stores the object path.
--
-- Security model (mirrors the table RLS everywhere else): the bucket is
-- private, so a URL alone reveals nothing — a signed URL can only be minted by
-- someone who passes the SELECT policy below, i.e. a member of the trip whose
-- id is the object's first path segment. This keeps chat images exactly as
-- private as the messages that carry them, with Postgres as the enforcement
-- boundary and the client as UX (the established `is_trip_member` pattern).

-- 1. Message reference — a nullable path into the chat-images bucket. A message
--    is text-only (image_path null), image-only (content = ''), or both.
--    New column of an already-published table, so it replicates over realtime
--    automatically — no publication change needed (see poll_option_media).
alter table public.messages
  add column if not exists image_path text;

-- 2. The private bucket. `public = false` means objects are never served
--    anonymously; every read goes through a signed URL gated by the SELECT
--    policy. Server-side guards cap the blast radius of a bad upload: 5 MB max
--    and an image-only MIME allowlist, enforced by Storage regardless of the
--    client.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-images',
  'chat-images',
  false,
  5242880, -- 5 MB
  array['image/png', 'image/jpeg', 'image/gif', 'image/webp']
)
on conflict (id) do nothing;

-- 3. Storage RLS. Object paths are `<trip_id>/<uuid>.<ext>`, so the first
--    folder segment is the trip id — `is_trip_member` / `is_trip_owner` decide
--    access exactly as they do for the messages table.

-- Read: any member of the object's trip can mint a signed URL for it.
create policy "chat images readable by trip members"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'chat-images'
    and public.is_trip_member(((storage.foldername(name))[1])::uuid)
  );

-- Write: a member may upload only into their own trip's folder.
create policy "trip members can upload chat images"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'chat-images'
    and public.is_trip_member(((storage.foldername(name))[1])::uuid)
  );

-- Delete: the uploader, or the trip owner (owner-only powers extend to
--    removing any member's chat image), so a deleted message can clean up its
--    object without leaving orphans.
create policy "uploader or owner can delete chat images"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'chat-images'
    and (
      owner = (select auth.uid())
      or public.is_trip_owner(((storage.foldername(name))[1])::uuid)
    )
  );
