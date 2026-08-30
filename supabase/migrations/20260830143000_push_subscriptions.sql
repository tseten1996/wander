-- Wander: Web Push subscriptions — epic #181, closed-app slice 1 (issue #267)
--
-- The notification inbox (#182) already says "you're being waited on" — but only
-- once the recipient reopens the app. Closed-app delivery is the half of #181
-- that actually changes behaviour, and it needs a place to remember *which
-- devices* a member has opted into push on. This table is that store.
--
-- It carries no send path yet: this slice is the subscription foundation (a
-- member opts in, their `PushSubscription` is persisted, RLS-clean). The server
-- fan-out that signs and sends a Web Push when a `notifications` row is inserted
-- — VAPID signing, the SECURITY DEFINER endpoint lookup, 404/410 pruning — is
-- its own slice (follow-up), because it depends on a human provisioning the
-- VAPID *private* key in the Pages Function secret store, which cannot be set or
-- verified from the repo.
--
-- Guardrail notes:
--   • Guardrail #1 (RLS is enforcement): trip-scoped (`trip_id`), and a member
--     may only ever read/write their OWN rows — `member_id = my_member_id(trip_id)`
--     — inside a trip they belong to. A subscription is device-private config,
--     never visible to another member, not even the owner.
--   • The stored `p256dh`/`auth` keys are public by design (RFC 8291): they let a
--     sender ENCRYPT a payload *to* this device. Only the device's private key,
--     which never leaves the browser, can decrypt. Storing them beside the trip
--     is safe — they compromise nothing on their own.
--   • No true secret lives here. The VAPID private key is the only secret in the
--     whole feature and it lives solely in the server function's secret store,
--     per the #191 decision (guardrail #5).

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  -- The member (per-trip identity) this device is subscribed as. Cascades so a
  -- member leaving the trip takes their subscriptions with them.
  member_id uuid not null references public.members(id) on delete cascade,
  -- The browser push endpoint (the URL the push service exposes for this
  -- device+SW+VAPID key). Unique per member so re-opting-in on the same device
  -- refreshes the row rather than duplicating it.
  endpoint text not null,
  -- The RFC 8291 encryption inputs for this device (public by design, above).
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One row per (member, device-endpoint): a repeat opt-in upserts.
  unique (member_id, endpoint)
);

-- The send path (next slice) fans out by member_id; the FK to trips wants an
-- index so a trip deletion cascades without a seq scan. member_id is already
-- the leading column of the unique index above, so it needs no separate one.
create index push_subscriptions_trip_idx on public.push_subscriptions (trip_id);

alter table public.push_subscriptions enable row level security;

-- A member sees only their own subscriptions — enforcement in Postgres, not the
-- UI. No other member (owner included) can enumerate a member's devices.
create policy push_subscriptions_select on public.push_subscriptions for select
  using (member_id = my_member_id(trip_id));

-- Opt-in: a member may register a device only AS themselves and only in a trip
-- they belong to. `is_trip_member` gates the trip; the `member_id` check pins
-- the row to the caller so no one can plant a subscription on another member.
create policy push_subscriptions_insert on public.push_subscriptions for insert
  with check (is_trip_member(trip_id) and member_id = my_member_id(trip_id));

-- Refresh (the upsert path when a device re-subscribes) — own rows only, and it
-- stays their own row on both sides of the write.
create policy push_subscriptions_update on public.push_subscriptions for update
  using (member_id = my_member_id(trip_id))
  with check (member_id = my_member_id(trip_id));

-- Opt-out / prune — a member may remove their own subscriptions.
create policy push_subscriptions_delete on public.push_subscriptions for delete
  using (member_id = my_member_id(trip_id));

-- Realtime publication decision: NO. A push subscription is device-private
-- configuration, not collaborative trip content — no other member ever renders
-- it, and the owning member's own toggle reads the browser's live subscription
-- state directly, not a realtime feed. Publishing it would leak nothing (RLS
-- gates delivery per subscriber) but would carry rows no client subscribes to,
-- so it stays out of `supabase_realtime`.
