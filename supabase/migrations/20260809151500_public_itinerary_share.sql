-- #127 (epic #126, slice 1): read-only public itinerary share link.
--
-- Today the only way to see a trip's plan is to JOIN it, and joining grants
-- edit access — so there's no way to *show* an itinerary to someone who
-- shouldn't edit (a parent checking dates, a friend deciding whether to come).
-- This is the app's first public-read surface, so it is built defensively:
--
--   * An owner mints an unguessable `share_token` on their trip (and revokes it
--     — revocation is immediate). The token is the ONLY capability.
--   * A token holder reads a whitelisted, read-only projection of the itinerary
--     through ONE token-validating SECURITY DEFINER RPC (`get_public_itinerary`).
--     There is deliberately NO public SELECT policy on any base table, and the
--     invite code is never in the projection — the share path and the join path
--     stay completely separate.
--   * The token grants NO membership, NO write, and exposes NO member PII: the
--     projection carries itinerary fields and the trip's name/destination/dates
--     only — never display names, emails, the invite code, or costs.

-- ─────────────────────────────────────────────────────────────────────────────
-- Column: the share token lives on `trips`, nullable, off by default.
-- ─────────────────────────────────────────────────────────────────────────────
-- No new SELECT policy is added. `share_token` is governed by the EXISTING
-- trips_select policy (owner-or-member): a non-member cannot read the trips row
-- at all, so the token is unreadable to outsiders through normal RLS. The owner
-- can read their own token (to display the link); members can see it but they
-- are already trusted insiders. The ONLY way to turn a token into itinerary
-- data is the SECURITY DEFINER RPC below, which runs past RLS but hand-picks
-- every column it returns.
alter table public.trips
  add column if not exists share_token text unique;

-- ─────────────────────────────────────────────────────────────────────────────
-- Realtime decision (required for any column touching shared content):
-- ─────────────────────────────────────────────────────────────────────────────
-- `trips` is already in the supabase_realtime publication; a new column of an
-- already-published table replicates automatically, and realtime still applies
-- RLS per subscriber — so the token only ever reaches owner/member subscribers,
-- never an outsider. The public share page itself does NOT subscribe to
-- realtime: it is a one-shot, RPC-only read-only snapshot for someone with no
-- session and no membership. Live updates for outsiders would need a separate
-- broadcast surface we deliberately do not build here (smallest complete slice).
-- Therefore: NO publication change.

-- ─────────────────────────────────────────────────────────────────────────────
-- Owner-only: mint / revoke the share token (a server-side capability, so it is
-- a SECURITY DEFINER RPC that validates its inputs — never a client-side write).
-- ─────────────────────────────────────────────────────────────────────────────
-- Enabling mints a 256-bit token when the trip has none, and is a no-op when a
-- token already exists (repeat enables keep the same link). Disabling clears the
-- token, which breaks every outstanding link immediately AND permanently — a
-- later re-enable mints a fresh token, so a revoked link never comes back to
-- life. Returns the current token (null when disabled) so the owner UI can show
-- the link without a second read. gen_random_uuid() is a core function
-- (pg_catalog) so it resolves under `search_path = public`.
create or replace function public.set_trip_share(p_trip_id uuid, p_enabled boolean)
returns text
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_token text;
begin
  if (select auth.uid()) is null or not is_trip_owner(p_trip_id) then
    raise exception 'NOT_OWNER';
  end if;

  if p_enabled then
    update trips
      set share_token = coalesce(
        share_token,
        replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
      )
      where id = p_trip_id
      returning share_token into v_token;
  else
    update trips
      set share_token = null
      where id = p_trip_id
      returning share_token into v_token;
  end if;

  return v_token;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Public, token-scoped read. SECURITY DEFINER so it can read past RLS, but it
-- returns ONLY the explicitly whitelisted, non-sensitive columns below, and
-- only for a trip whose share_token matches an enabled (non-null) token and is
-- not archived. An absent / blank / too-short / unknown / revoked token matches
-- no row and the function returns SQL NULL — never partial data, never the
-- invite code, never member PII.
--
-- COLUMN REVIEW (the whitelist — this is the entire public attack surface):
--   trip:  name, destination, start_date, end_date
--   items: id, title, category, day, end_day, start_time, end_time, location, notes
-- Deliberately EXCLUDED: invite_code, share_token, owner_id, description,
-- cover_url, estimated_budget, currency; itinerary cost, url, latitude,
-- longitude, created_by, budget_entry_id, position, created_at. Any member
-- identity (display_name / created_by) is never joined in.
create or replace function public.get_public_itinerary(p_token text)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select jsonb_build_object(
    'trip', jsonb_build_object(
      'name', t.name,
      'destination', t.destination,
      'start_date', t.start_date,
      'end_date', t.end_date
    ),
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', i.id,
          'title', i.title,
          'category', i.category,
          'day', i.day,
          'end_day', i.end_day,
          'start_time', i.start_time,
          'end_time', i.end_time,
          'location', i.location,
          'notes', i.notes
        )
        order by i.day nulls last, i.position
      )
      from itinerary_items i
      where i.trip_id = t.id
    ), '[]'::jsonb)
  )
  from trips t
  where p_token is not null
    and length(p_token) >= 16
    and t.share_token = p_token
    and not t.archived
  limit 1;
$$;

-- Execution grants. get_public_itinerary is the intentionally-public surface:
-- an unauthenticated visitor (the `anon` role, no session) must be able to call
-- it. set_trip_share is owner-only management, so anon is revoked (its body also
-- guards with is_trip_owner, this is defence in depth).
grant execute on function public.get_public_itinerary(text) to anon, authenticated;
revoke execute on function public.set_trip_share(uuid, boolean) from public;
grant execute on function public.set_trip_share(uuid, boolean) to authenticated;
