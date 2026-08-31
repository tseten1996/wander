-- Wander: Web Push send path — epic #181, closed-app slice 2 (issue #309)
--
-- The subscription foundation (the `push_subscriptions` table, the opt-in, the
-- browser lifecycle) shipped in the prior migration
-- (`20260830143000_push_subscriptions.sql`, issue #267). That slice deliberately
-- carried NO send path: a stored subscription with no delivery mechanism pushes
-- nothing. This migration adds that mechanism's database half — the two
-- SECURITY DEFINER RPCs the Cloudflare Pages Function (`functions/api/push.ts`)
-- uses to reach a *recipient's* endpoint. The table itself is untouched here.
--
-- Trust model (guardrail #1 / #5). The Pages Function runs AS THE CALLER — it
-- forwards the browser's Supabase JWT exactly like /api/ai — so it has no more
-- database reach than the member who invoked it. A member may only read their
-- OWN push_subscriptions rows through RLS, so reaching the *recipient's*
-- endpoint has to go through a SECURITY DEFINER RPC that validates its inputs
-- (the `join_trip` pattern), never a service-role key and never a client
-- workaround. Each RPC hands out (or prunes) a target only under proof that the
-- caller authored the very notification being delivered, and only within a
-- 5-minute window — a send helper for a live event, not a way to enumerate the
-- group's devices after the fact. Endpoints never travel back to the browser:
-- the Function consumes them and returns only counts. Even if called directly,
-- a leaked endpoint is inert without this deployment's VAPID private key
-- (subscriptions are pinned with `applicationServerKey`, so the push service
-- rejects any other signer).

-- Return the push targets for a set of notifications the CALLER authored.
--
-- Authorization is the `n.actor_id = my_member_id(n.trip_id)` clause: you can
-- only fan out to the devices of members you legitimately just notified, and
-- the `created_at` window bounds it to the event that actually just happened.
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
