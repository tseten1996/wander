-- #48: visual poll options — an optional image and/or link on each poll option,
-- so groups can compare candidates (e.g. Airbnb listings) side by side instead
-- of as plain text. Both are plain text columns, validated client-side as
-- http(s); RLS and the realtime publication for poll_options are unchanged
-- (new columns of an already-published table replicate automatically).
alter table public.poll_options
  add column if not exists image_url text,
  add column if not exists link_url text;
