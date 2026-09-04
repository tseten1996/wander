-- #330 (epic #313, slice 2): let comment threads attach to a budget entry.
--
-- "Who was actually at this dinner?" and "why is my share bigger?" are the
-- arguments a group has over money — and today they happen in the trip chat,
-- detached from the expense they are about, then scroll away. Slice 1 (#314)
-- stood up the polymorphic `comments` table wired to a single `entity_type`
-- (`itinerary_item`); this slice widens that CHECK to the second entity the
-- epic names, so the same thread can live on the expense itself.
--
-- This is the ENTIRE schema change: no new table, no new column, no new RLS.
-- The table's member-scoped read, self-attributed insert, author-or-owner
-- delete, and realtime publication were all built in slice 1 and cover a
-- `budget_entry` comment unchanged — `entity_id` is a soft pointer, so a
-- comment on a since-deleted expense is simply never queried again.
--
-- The slice-1 CHECK is an inline column constraint, which Postgres names
-- `comments_entity_type_check`. Drop-if-exists then re-add keeps this
-- idempotent (safe to re-run) and re-entrant with any prior partial apply.
alter table public.comments
  drop constraint if exists comments_entity_type_check;

alter table public.comments
  add constraint comments_entity_type_check
  check (entity_type in ('itinerary_item', 'budget_entry'));
