-- Wander: Web Push subscriptions — epic #181, closed-app delivery slice (#267)
--
-- The inbox (#182) is cross-device but *pull*: "someone is waiting on you" only
-- surfaces when that person reopens the app. This table is the store that lets
-- the same notification be *pushed* to a subscribed device while the app is
-- closed — the half of #181 that actually changes who is the last to know.
--
-- It is written self-only, exactly like `members` name/colour: a member stores
-- *their own* device subscriptions and no one else's. The send path never reads
-- this table from the browser — a recipient's endpoint is handed only to the
-- server function, via the two SECURITY DEFINER RPCs below, and only for a
-- notification the caller legitimately just authored.

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  -- Trip-scoped like every content table (guardrail #1): a subscription belongs
  -- to one member's participation in one trip. Cascades so leaving the trip
  -- takes the device subscription with it.
  trip_id uuid not null references public.trips(id) on delete cascade,
  -- The subscriber. A member subscribes only for themselves (RLS below), which
  -- is what makes "a member writes only their own subscription" a database fact.
  member_id uuid not null references public.members(id) on delete cascade,
  -- The push service endpoint URL (FCM / Mozilla / APNs). Opaque capability URL;
  -- treated as sensitive (never exposed through RLS to other members).
  endpoint text not null,
  -- The subscription's public key (P-256, base64url) used to encrypt the payload
  -- for this device (RFC 8291), and the auth secret (16 bytes, base64url).
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  -- Bumped on every re-subscribe so pruning can prefer freshness; also the
  -- signal that a device is still live.
  last_seen_at timestamptz not null default now(),
  -- One row per (member, endpoint): re-subscribing on the same device upserts
  -- rather than piling duplicates, so a member is never pushed twice per device.
  unique (member_id, endpoint)
);

-- The send path looks subscriptions up by recipient within a trip.
create index push_subscriptions_member_idx
  on public.push_subscriptions (trip_id, member_id);

alter table public.push_subscriptions enable row level security;

-- A member sees only their own device subscriptions — never anyone else's
-- endpoints. Enforcement in Postgres, not just the UI.
create policy push_subscriptions_select on public.push_subscriptions for select
  using (member_id = my_member_id(trip_id));

-- A member may register a subscription only *as themselves* and only in a trip
-- they belong to. No forging a subscription onto another member.
create policy push_subscriptions_insert on public.push_subscriptions for insert
  with check (is_trip_member(trip_id) and member_id = my_member_id(trip_id));

-- Upsert on re-subscribe (keys/last_seen refresh) touches only your own rows.
create policy push_subscriptions_update on public.push_subscriptions for update
  using (member_id = my_member_id(trip_id))
  with check (member_id = my_member_id(trip_id));

-- Opting out (or clearing a device) deletes your own rows. Dead endpoints that
-- belong to *other* members are pruned by the server-only RPC below, never by
-- one member reaching across to another's rows through this policy.
create policy push_subscriptions_delete on public.push_subscriptions for delete
  using (member_id = my_member_id(trip_id));

-- Realtime publication decision: NO. This is device-management data, not trip
-- content — nothing in the UI needs another device's subscription state pushed
-- live, and the endpoints are deliberately kept off any client channel. So it
-- is intentionally left out of the supabase_realtime publication.

-- ─────────────────────────────────────────────────────────────────────────────
-- Server-side send capability (guardrail #1 / #5: a SECURITY DEFINER RPC that
-- validates its inputs, never a client-side workaround, never a service-role
-- key). The Cloudflare Pages Function (#211 runtime) runs as the caller — it
-- forwards the user's JWT exactly like /api/ai — so these RPCs are the only way
-- it can reach a *recipient's* endpoint, and they hand it out only under proof
-- that the caller authored the very notification being delivered.
-- ─────────────────────────────────────────────────────────────────────────────

-- Return the push targets for a set of notifications the CALLER authored.
--
-- Authorization is the `and n.actor_id = my_member_id(n.trip_id)` clause: you
-- can only fan out to the devices of members you legitimately just notified,
-- and the `created_at` window bounds it to the event that actually just
-- happened — this is a send helper for a live event, not a way to enumerate the
-- group's devices after the fact. The endpoint never reaches the caller's
-- browser: the Pages Function consumes the result server-side and returns only
-- counts. Even if called directly, a leaked endpoint is inert without this
-- deployment's VAPID private key (subscriptions are created with
-- `applicationServerKey`, so the push service rejects any other signer).
create or replace function public.push_targets_for_notifications(p_ids uuid[])
returns table (
  subscription_id uuid,
  endpoint text,
  p256dh text,
  auth text,
  notification_id uuid,
  trip_id uuid,
  type text,
  title text,
  entity_id uuid
)
language sql stable security definer
set search_path = public
as $$
  select ps.id, ps.endpoint, ps.p256dh, ps.auth,
         n.id, n.trip_id, n.type, n.title, n.entity_id
  from notifications n
  join push_subscriptions ps
    on ps.member_id = n.recipient_id and ps.trip_id = n.trip_id
  where n.id = any(p_ids)
    and n.actor_id = my_member_id(n.trip_id)
    and n.created_at > now() - interval '5 minutes';
$$;

-- Prune one dead subscription (the push service answered 404/410) by id.
--
-- Keyed by id, not endpoint, so it can only remove a row the send path was just
-- legitimately handed by push_targets_for_notifications — the same
-- caller-authored, recent-notification proof gates it. That bounds the worst
-- case to "someone you just notified has to re-opt-in", never a data leak and
-- never an arbitrary cross-member delete.
create or replace function public.prune_push_subscription(p_subscription_id uuid)
returns void
language sql volatile security definer
set search_path = public
as $$
  delete from push_subscriptions ps
  where ps.id = p_subscription_id
    and exists (
      select 1 from notifications n
      where n.recipient_id = ps.member_id
        and n.trip_id = ps.trip_id
        and n.actor_id = my_member_id(ps.trip_id)
        and n.created_at > now() - interval '5 minutes'
    );
$$;
