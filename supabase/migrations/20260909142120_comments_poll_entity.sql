-- #337 (epic #313, slice 3): let comment threads attach to a poll.
--
-- "Why beach over museum?" is the argument a group has *around a poll* — and
-- today it happens in the trip chat, detached from the poll it decided, then
-- scrolls away. A member who votes a week later sees the tally but never the
-- reasoning. Slice 1 (#314) stood up the polymorphic `comments` table on an
-- itinerary item and slice 2 (#330) widened it to a budget entry; the slice-1
-- migration explicitly named polls as the remaining entity. This slice widens
-- that CHECK to `poll`, so the discussion can live on the poll itself.
--
-- This is the ENTIRE schema change: no new table, no new column, no new RLS.
-- The table's member-scoped read, self-attributed insert, author-or-owner
-- delete, and realtime publication were all built in slice 1 and cover a
-- `poll` comment unchanged — `entity_id` is a soft pointer, so a comment on a
-- since-deleted poll is simply never queried again.
--
-- The slice-1 CHECK is an inline column constraint, which Postgres names
-- `comments_entity_type_check`. Drop-if-exists then re-add keeps this
-- idempotent (safe to re-run) and re-entrant with any prior partial apply,
-- matching the pattern #330 shipped for `budget_entry`.
alter table public.comments
  drop constraint if exists comments_entity_type_check;

alter table public.comments
  add constraint comments_entity_type_check
  check (entity_type in ('itinerary_item', 'budget_entry', 'poll'));
