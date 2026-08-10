-- Wander: allow chat @-mentions in the inbox — epic #181, slice 2 (#193)
--
-- Slice 1 (#182) shipped the notification inbox with three actor-caused event
-- types. A chat mention is the same shape — actor_id = the sender, recipient =
-- the mentioned member — so it needs no new table, policy, column, or realtime
-- decision: it reuses the existing `notifications` table wholesale. The only
-- change is permission for the new `type` value, so extend the CHECK.
--
-- Unnamed inline CHECKs are auto-named `<table>_<column>_check` by Postgres;
-- drop-if-exists keeps this idempotent and re-runnable.

alter table public.notifications
  drop constraint if exists notifications_type_check;

alter table public.notifications
  add constraint notifications_type_check
  check (type in ('checklist_assigned', 'poll_opened', 'expense_owed', 'mention'));
