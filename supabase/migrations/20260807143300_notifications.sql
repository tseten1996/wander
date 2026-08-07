-- Wander: personal notification inbox — epic #181, slice 1 (issue #182)
--
-- A per-recipient, cross-device stream of "things that need me". Modeled on
-- `activity` but *addressed to a person* and *carrying read state*, so it can
-- say "you, specifically, are being waited on" — anywhere you sign in — rather
-- than the impersonal, device-local "this tab changed" of the #43 unread dots.
--
-- It is written fire-and-forget by the same client mutation paths that already
-- write the activity feed (`src/lib/notify.ts`), so there is no server, no
-- external service and no new infrastructure: just another RLS-protected,
-- realtime table, exactly like `activity`.

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  -- The member being notified. Cascades so a member leaving the trip takes
  -- their inbox with them.
  recipient_id uuid not null references public.members(id) on delete cascade,
  -- Who caused it. set null if they later leave — the event still stands.
  actor_id uuid references public.members(id) on delete set null,
  type text not null
    check (type in ('checklist_assigned', 'poll_opened', 'expense_owed')),
  -- The row the notification points at (checklist_item / poll / budget_entry),
  -- used to deep-link to its tab and flash it. Intentionally a soft pointer —
  -- nullable, no FK — so the inbox survives the target being deleted (it falls
  -- back to linking the tab).
  entity_id uuid,
  -- A snapshot of the subject at write time (the task / poll / expense title) so
  -- the inbox renders without a cross-table join and stays readable even if the
  -- underlying row is later edited or removed.
  title text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index notifications_recipient_idx
  on public.notifications (trip_id, recipient_id, created_at desc);
create index notifications_unread_idx
  on public.notifications (recipient_id) where read_at is null;

alter table public.notifications enable row level security;

-- A member reads only their own inbox — enforcement in Postgres, not just the
-- UI (acceptance criterion 1).
create policy notifications_select on public.notifications for select
  using (recipient_id = my_member_id(trip_id));

-- Inserts are attributed and trip-scoped exactly like `activity`: the caller can
-- only write notifications *as themselves* (`actor_id` = their own member row)
-- and only into a trip they belong to. The recipient may be any member of that
-- trip. This is what makes "no self-forgery, no cross-trip injection" a database
-- fact rather than a client convention.
create policy notifications_insert on public.notifications for insert
  with check (is_trip_member(trip_id) and actor_id = my_member_id(trip_id));

-- Mark-read is the only update a recipient may make, and only on their own rows.
create policy notifications_update on public.notifications for update
  using (recipient_id = my_member_id(trip_id))
  with check (recipient_id = my_member_id(trip_id));

-- Column guard (mirrors the members name/colour pattern): the sole field a
-- recipient can change is `read_at`, so no one can rewrite type/title/actor on a
-- notification they merely received.
revoke update on public.notifications from authenticated, anon;
grant update (read_at) on public.notifications to authenticated;

-- A member may clear (delete) their own notifications; the owner may prune any
-- in their trip. Keeps the inbox tidy without a background job.
create policy notifications_delete on public.notifications for delete
  using (recipient_id = my_member_id(trip_id) or is_trip_owner(trip_id));

-- Realtime publication decision: YES. The unread badge must update live the
-- moment someone assigns you a task or opens a poll, on whatever device you have
-- open. RLS still applies per subscriber, so a member is only ever pushed the
-- rows addressed to them — the SELECT policy above gates realtime delivery too.
alter publication supabase_realtime add table public.notifications;
