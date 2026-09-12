-- #338 (theme: collaboration): attach a receipt photo to an expense.
--
-- "Wait, what was this €80 at dinner?" is the most common friend-trip budget
-- dispute, and today the proof — the photo of the receipt — lives in the group
-- chat (if at all), detached from the money it explains. A `budget_entries` row
-- already records *how much* and *who shares it*, and #330 lets members argue
-- *why* in a comment thread; this adds the missing *what*: the charge itself.
--
-- This is the ENTIRE schema change: one nullable, additive column. `NULL` means
-- "no receipt", so every existing entry and any entry without one renders
-- exactly as it does today. The object lives in the existing private
-- `chat-images` bucket (#51), keyed `<trip_id>/<uuid>.<ext>`, reusing the same
-- Storage RLS that already scopes read/write to trip members
-- (20260811210151_chat_images.sql, 20260825142200_trip_photos.sql). No new
-- bucket, no new Storage policy, no new public-read surface — a receipt is
-- exactly as private as a chat image or a gallery photo.
--
-- No table RLS change: the write stays gated by the unchanged `budget_update`
-- policy (creator-or-owner, 20260731004000_budget_update_owner_creator.sql), so
-- a non-member / non-author still cannot attach or replace a receipt. Unlike
-- `members` (which has a column-scoped UPDATE grant, ARCHITECTURE §2),
-- `budget_entries` is updatable through the default table-wide grant, so the new
-- column is writable with no grant change. The table is already in the
-- `supabase_realtime` publication, so an added receipt appears live for other
-- members with the trip open — no extra wiring.
alter table public.budget_entries
  add column if not exists image_path text;

comment on column public.budget_entries.image_path is
  'Optional receipt image: object path <trip_id>/<uuid>.<ext> in the private chat-images bucket (#338). NULL = no receipt.';
